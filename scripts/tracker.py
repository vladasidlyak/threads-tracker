#!/usr/bin/env python3
"""
Threads Competitor Tracker - data pipeline.

Commands (run from the repository root):

  python scripts/tracker.py collect  --handle esmipsicologa [--max-posts 60] [--no-replies] [--comments]
  python scripts/tracker.py refresh  [--comments]            # every account in config/accounts.json
  python scripts/tracker.py report   --handle esmipsicologa --brand ines --focus full
  python scripts/tracker.py report   --all --brand ines --focus full
  python scripts/tracker.py add      --handle https://www.threads.com/@someone

Add --dry-run to any command to use the sample files in tests/fixtures instead of
calling Apify and Claude. Dry runs cost nothing and write to a temporary folder.

Secrets come from environment variables (GitHub Actions secrets):
  APIFY_TOKEN        - Apify personal API token
  ANTHROPIC_API_KEY  - Claude API key
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
APIFY_API = "https://api.apify.com/v2"
CLAUDE_API = "https://api.anthropic.com/v1/messages"
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


class TrackerError(Exception):
    """An error with a message that is safe and useful to show in the Actions log."""


# ---------------------------------------------------------------- monthly budget
# Every paid call is recorded in data/usage.json. When this month's total reaches
# monthly_budget_usd (config/settings.json), paid actions stop with a clear message.
BUDGET = {"path": None, "settings": {}}


def _usage() -> dict:
    return read_json(BUDGET["path"], {}) if BUDGET["path"] else {}


def month_key() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m")


def spent_this_month() -> float:
    return float(_usage().get(month_key(), {}).get("total", 0))


def budget_left() -> float:
    limit = float(BUDGET["settings"].get("monthly_budget_usd", 0) or 0)
    return 9999.0 if not limit or not BUDGET["path"] else round(limit - spent_this_month(), 4)


def check_budget(minimum: float = 0.02) -> float:
    left = budget_left()
    if left < minimum:
        limit = BUDGET["settings"].get("monthly_budget_usd")
        raise TrackerError(f"This month's budget of ${limit} is used up (spent ${spent_this_month():.2f}). "
                           "Paid actions start again on the 1st, or raise monthly_budget_usd in config/settings.json.")
    return left


def record_cost(kind: str, usd: float, what: str) -> None:
    if not BUDGET["path"]:
        return
    u = _usage()
    m = u.setdefault(month_key(), {"total": 0, "items": []})
    m["total"] = round(m["total"] + usd, 4)
    m["items"] = (m["items"] + [{"t": now_iso(), "kind": kind, "usd": round(usd, 4), "what": what[:80]}])[-300:]
    for k in sorted(u)[:-12]:  # keep a year
        u.pop(k, None)
    write_json(BUDGET["path"], u)
    log(f"Cost: ${usd:.3f} ({kind}). This month: ${m['total']:.2f}")


def setup_budget(paths, settings: dict, dry_run: bool) -> None:
    BUDGET["settings"] = settings
    BUDGET["path"] = None if dry_run else paths.data / "usage.json"


# ---------------------------------------------------------------- paths & io

class Paths:
    def __init__(self, root: Path):
        self.root = root
        self.config = ROOT / "config"
        self.prompts = ROOT / "prompts"
        self.data = root / "data"
        self.accounts_dir = self.data / "accounts"
        self.reports = root / "reports"

    def account_file(self, handle: str) -> Path:
        return self.accounts_dir / f"{handle}.json"


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    tmp.replace(path)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def log(msg: str) -> None:
    print(msg, flush=True)


# ---------------------------------------------------------------- helpers

def clean_handle(value: str) -> str:
    value = (value or "").strip()
    m = re.search(r"threads\.(?:net|com)/@([A-Za-z0-9._]+)", value)
    if m:
        value = m.group(1)
    value = value.lstrip("@").split("?")[0].split("/")[0]
    value = re.sub(r"[^A-Za-z0-9._]", "", value).lower()
    if not value:
        raise TrackerError("That doesn't look like a Threads profile link or @handle.")
    return value


def num(v) -> int:
    if v is None or v == "":
        return 0
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def squash(text: str) -> str:
    return re.sub(r"\s+", " ", text or "")


def engagement(p: dict) -> int:
    return p.get("likes", 0) + p.get("replies", 0) + p.get("reposts", 0) + p.get("quotes", 0)


def format_of(text: str) -> str:
    t = (text or "").strip()
    if re.match(r'^\s*["“«]', t) or re.search(r"\n\s*[-–—]\s*[A-ZÁÉÍÓÚÑ][^\n]{1,40}$", t):
        return "Quote"
    bullet_lines = [l for l in t.split("\n") if re.match(r"^\s*(\d+[.)]|[-•*–])\s", l)]
    if len(bullet_lines) >= 2:
        return "List"
    first = re.split(r"[.!\n]", t)[0] if t else ""
    if "?" in first or "¿" in first or t.endswith("?"):
        return "Question"
    if re.search(r"https?://", t):
        return "With link"
    if re.match(r"^(i |yo |me |mi |my |when i|cuando )", t.lower()):
        return "Personal story"
    return "Statement"


def length_of(text: str) -> str:
    n = len(text or "")
    return "< 100" if n < 100 else "100-250" if n < 250 else "250-500" if n < 500 else "500+"


def weekday_of(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        return DAYS[dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).weekday()]
    except ValueError:
        return None


# ---------------------------------------------------------------- normalize Apify rows

def normalize_post(row: dict) -> dict:
    return {
        "id": str(row.get("postId") or row.get("id") or row.get("code")),
        "account": (row.get("username") or "").lower(),
        "type": "reply" if row.get("isReply") else "post",
        "text": row.get("text") or "",
        "date": row.get("createdAt"),
        "likes": num(row.get("likeCount")),
        "replies": num(row.get("replyCount")),
        "reposts": num(row.get("repostCount")),
        "quotes": num(row.get("quoteCount")),
        "shares": num(row.get("shareCount")),
        "views": num(row.get("viewCount")),
        "url": row.get("url") or "",
        "media": (row.get("mediaType") or "text").lower(),
        "parentText": (row.get("parentPostText") or "")[:1500],
        "parentAuthor": (row.get("parentPostUsername") or "").lower(),
        "followers": num(row.get("authorFollowerCount")),
    }


def normalize_comment(row: dict, author: str) -> dict:
    username = (row.get("username") or "").lower()
    return {
        "id": str(row.get("postId") or row.get("code")),
        "username": username,
        "isAuthor": username == author,
        "text": row.get("text") or "",
        "date": row.get("createdAt"),
        "likes": num(row.get("likeCount")),
        "replies": num(row.get("replyCount")),
        "views": num(row.get("viewCount")),
        "depth": num(row.get("replyDepth")) or 1,
        "parentId": str(row.get("parentPostId") or ""),
        "url": row.get("url") or "",
    }


# ---------------------------------------------------------------- Apify

class Apify:
    def __init__(self, token: str | None, dry_run: bool):
        self.dry_run = dry_run
        if not dry_run and not token:
            raise TrackerError("APIFY_TOKEN is missing. Add it in GitHub: Settings → Secrets and variables → Actions.")
        self.session = requests.Session()
        if token:
            self.session.headers["Authorization"] = f"Bearer {token}"

    def _req(self, method: str, url: str, **kw):
        for attempt in range(3):
            try:
                r = self.session.request(method, url, timeout=90, **kw)
            except requests.RequestException as e:
                if attempt == 2:
                    raise TrackerError(f"Couldn't reach Apify: {e.__class__.__name__}")
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 401:
                raise TrackerError("Apify rejected the token. Check the APIFY_TOKEN secret.")
            if r.status_code == 402:
                raise TrackerError("Apify says the account has no credit left. Top up in Apify → Billing.")
            if r.status_code >= 500 and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code >= 400:
                raise TrackerError(f"Apify error {r.status_code}: {r.text[:300]}")
            return r.json()
        raise TrackerError("Apify didn't answer after 3 tries.")

    def run(self, actor: str, actor_input: dict, max_cost: float, fixture: str) -> list[dict]:
        if self.dry_run:
            log(f"[dry run] would run {actor} with {json.dumps(actor_input)[:200]}")
            return read_json(FIXTURES / fixture, [])
        max_cost = round(min(max_cost, check_budget()), 2)
        actor_id = actor.replace("/", "~")
        run = self._req("POST", f"{APIFY_API}/acts/{actor_id}/runs",
                        params={"maxTotalChargeUsd": max_cost}, json=actor_input)["data"]
        run_id = run["id"]
        log(f"Apify run started: {run_id} (cost cap ${max_cost:.2f})")
        started = time.time()
        while run["status"] in ("READY", "RUNNING"):
            if time.time() - started > 20 * 60:
                raise TrackerError("The Apify run took longer than 20 minutes and was left running. Check it in Apify.")
            run = self._req("GET", f"{APIFY_API}/actor-runs/{run_id}", params={"waitForFinish": 60})["data"]
            log(f"  status: {run['status']} ({int(time.time() - started)}s)")
        if run["status"] != "SUCCEEDED":
            raise TrackerError(f"The Apify run ended with status {run['status']}. Nothing was saved.")
        items, offset = [], 0
        while True:
            page = self._req("GET", f"{APIFY_API}/datasets/{run['defaultDatasetId']}/items",
                             params={"clean": "true", "format": "json", "offset": offset, "limit": 500})
            items.extend(page)
            if len(page) < 500:
                break
            offset += 500
        price = float(BUDGET["settings"].get("apify_price_per_item_usd", 0.0016))
        cost = max(len(items) * price, float(run.get("usageTotalUsd") or 0))
        log(f"Apify run finished: {len(items)} rows")
        record_cost("apify", cost, f"{actor} {json.dumps(actor_input, ensure_ascii=False)[:60]}")
        return items


# ---------------------------------------------------------------- Claude

def ask_claude(prompt: str, settings: dict, dry_run: bool) -> str:
    if dry_run:
        log("[dry run] would send the report prompt to Claude "
            f"({len(prompt)} characters, model {settings['claude_model']})")
        return "### What's working\n- (dry run) This is where Claude's analysis would appear.\n"
    check_budget(0.02)
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise TrackerError("ANTHROPIC_API_KEY is missing. Add it in GitHub: Settings → Secrets and variables → Actions.")
    body = {"model": settings["claude_model"], "max_tokens": settings["claude_max_tokens"],
            "messages": [{"role": "user", "content": prompt}]}
    headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    for attempt in range(3):
        try:
            r = requests.post(CLAUDE_API, headers=headers, json=body, timeout=300)
        except requests.RequestException as e:
            if attempt == 2:
                raise TrackerError(f"Couldn't reach the Claude API: {e.__class__.__name__}")
            time.sleep(10)
            continue
        if r.status_code in (429, 500, 529) and attempt < 2:
            time.sleep(20 * (attempt + 1))
            continue
        if r.status_code == 401:
            raise TrackerError("The Claude API rejected the key. Check the ANTHROPIC_API_KEY secret.")
        if r.status_code == 400 and "credit" in r.text.lower():
            raise TrackerError("Your Claude API balance is too low. Add credits at platform.claude.com → Billing.")
        if r.status_code >= 400:
            raise TrackerError(f"Claude API error {r.status_code}: {r.text[:300]}")
        data = r.json()
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        if data.get("stop_reason") == "max_tokens":
            log("WARNING: the report hit claude_max_tokens and was cut off. Raise it in config/settings.json.")
            text += "\n\n*(Report cut off at the length limit. Raise claude_max_tokens in config/settings.json.)*\n"
        usage = data.get("usage", {})
        log(f"Claude answered: {usage.get('input_tokens')} input tokens, {usage.get('output_tokens')} output tokens")
        cost = ((usage.get("input_tokens") or 0) * float(settings.get("claude_price_input_per_mtok", 2)) +
                (usage.get("output_tokens") or 0) * float(settings.get("claude_price_output_per_mtok", 10))) / 1e6
        record_cost("claude", cost, prompt[:80].replace("\n", " "))
        return text.replace("—", " - ")
    raise TrackerError("The Claude API didn't answer after 3 tries.")


# ---------------------------------------------------------------- account store

def load_account(paths: Paths, handle: str) -> dict:
    return read_json(paths.account_file(handle)) or {
        "handle": handle, "profile": {}, "followersHistory": [], "posts": {}, "comments": {}}


def merge_posts(account: dict, rows: list[dict], keep: int) -> tuple[int, int]:
    stamp = now_iso()[:10]
    new = updated = 0
    for row in rows:
        if row.get("dataType") == "profile" or row.get("isRepost"):
            continue
        p = normalize_post(row)
        if p["account"] != account["handle"] or not p["id"] or p["id"] == "None":
            continue
        old = account["posts"].get(p["id"])
        history = old.get("history", []) if old else []
        snap = {"d": stamp, "likes": p["likes"], "replies": p["replies"], "reposts": p["reposts"],
                "quotes": p["quotes"], "views": p["views"]}
        history = [h for h in history if h["d"] != stamp] + [snap]
        p["history"] = history[-keep:]
        account["posts"][p["id"]] = p
        if old:
            updated += 1
        else:
            new += 1
    return new, updated


def apply_profile(account: dict, rows: list[dict]) -> None:
    prof = next((r for r in rows if r.get("dataType") == "profile"), None)
    followers = num(prof.get("followerCount")) if prof else 0
    if not followers:
        followers = max((num(r.get("authorFollowerCount")) for r in rows), default=0)
    if prof:
        account["profile"].update({
            "fullName": prof.get("fullName") or "",
            "bio": prof.get("bio") or "",
            "url": prof.get("url") or f"https://www.threads.com/@{account['handle']}",
        })
    if followers:
        account["profile"]["followers"] = followers
        stamp = now_iso()[:10]
        hist = [h for h in account["followersHistory"] if h["d"] != stamp]
        account["followersHistory"] = hist + [{"d": stamp, "followers": followers}]
    account["profile"]["lastFetched"] = now_iso()


def update_index(paths: Paths) -> None:
    """data/index.json: the small summary the dashboard loads first."""
    accounts_cfg = read_json(paths.config / "accounts.json", {"accounts": []})["accounts"]
    if paths.root != ROOT:  # dry run keeps its own copy of the accounts list
        accounts_cfg = read_json(paths.data / "accounts-config.json", {"accounts": accounts_cfg})["accounts"]
    out = []
    for a in accounts_cfg:
        acc = read_json(paths.account_file(a["handle"]))
        if not acc:
            out.append({"handle": a["handle"], "note": a.get("note", ""), "posts": 0, "replies": 0})
            continue
        posts = [p for p in acc["posts"].values() if p["type"] == "post"]
        out.append({
            "handle": a["handle"], "note": a.get("note", ""),
            "fullName": acc["profile"].get("fullName", ""),
            "followers": acc["profile"].get("followers", 0),
            "lastFetched": acc["profile"].get("lastFetched"),
            "posts": len(posts), "replies": len(acc["posts"]) - len(posts),
            "commentThreads": len(acc.get("comments", {})),
        })
    reports = read_json(paths.reports / "index.json", [])
    competitors = read_json(paths.data / "competitors" / "index.json", [])
    settings = read_json(paths.config / "settings.json", {})
    month = (read_json(paths.data / "usage.json", {}) or {}).get(month_key(), {})
    write_json(paths.data / "index.json", {"updated": now_iso(), "accounts": out, "reports": reports[:200],
                                           "competitors": competitors[:100],
                                           "plans": read_json(paths.data / "plans" / "index.json", [])[:100],
                                           "usage": {"month": month_key(), "spent": round(month.get("total", 0), 2),
                                                     "budget": settings.get("monthly_budget_usd")}})


# ---------------------------------------------------------------- commands

def collect(paths: Paths, settings: dict, apify: Apify, handle: str, max_posts: int,
            replies: bool, comments: bool) -> dict:
    log(f"\n=== Collecting @{handle} ===")
    content = ["profile", "posts"] + (["replies"] if replies else [])
    actor_input = {"usernames": [handle], "profileContent": content, "maxItemsPerInput": max_posts,
                   "includeViewCounts": True, "includeAuthorDetails": True,
                   "proxyConfiguration": {"useApifyProxy": True}}
    existing = load_account(paths, handle)
    last = existing["profile"].get("lastFetched")
    if settings.get("only_new_posts_on_refresh") and last and existing["posts"]:
        days = max(2, int((dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(last.replace("Z", "+00:00"))).days) + 2)
        actor_input["postedAfter"] = f"{days} days"
        log(f"Only posts from the last {days} days (older ones are already saved)")
    rows = apify.run(settings["apify_profile_actor"], actor_input, settings["max_cost_usd_per_run"], "profile_run.json")
    if not rows:
        raise TrackerError(f"Apify returned no data for @{handle}. Is the profile public and spelled right?")
    account = load_account(paths, handle)
    apply_profile(account, rows)
    new, updated = merge_posts(account, rows, settings["history_snapshots_to_keep"])
    log(f"Posts and replies: {new} new, {updated} updated. Followers: {account['profile'].get('followers', 'unknown')}")
    if comments:
        collect_comments(settings, apify, account)
    write_json(paths.account_file(handle), account)
    return account


def collect_comments(settings: dict, apify: Apify, account: dict) -> None:
    posts = sorted((p for p in account["posts"].values() if p["type"] == "post" and p["url"]),
                   key=engagement, reverse=True)[:settings["comments_top_posts"]]
    if not posts:
        return
    log(f"Collecting comments under the top {len(posts)} posts...")
    rows = apify.run(settings["apify_comments_actor"], {
        "postUrls": [p["url"] for p in posts], "includeReplies": True, "includeNestedReplies": True,
        "maxItemsPerInput": settings["comments_per_post"], "sort": "top",
        "includeReplyViewCounts": False, "includeAuthorDetails": False,
        "proxyConfiguration": {"useApifyProxy": True},
    }, settings["max_cost_usd_per_run"], "comments_run.json")
    by_post: dict[str, list] = {p["id"]: [] for p in posts}
    ids_to_root: dict[str, str] = {p["id"]: p["id"] for p in posts}
    # rows arrive post first, then its replies; resolve every reply to its root post
    pending = [r for r in rows if r.get("isReply")]
    for _ in range(4):
        rest = []
        for r in pending:
            parent = str(r.get("parentPostId") or "")
            root = ids_to_root.get(str(r.get("rootPostId") or "")) or ids_to_root.get(parent)
            if root:
                c = normalize_comment(r, account["handle"])
                ids_to_root[c["id"]] = root
                by_post[root].append(c)
            else:
                rest.append(r)
        pending = rest
    total = 0
    for pid, items in by_post.items():
        if items:
            account.setdefault("comments", {})[pid] = items
            total += len(items)
    log(f"Comments saved: {total} across {sum(1 for v in by_post.values() if v)} posts")


EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\u2661][\ufe0f\U0001F3FB-\U0001F3FF]*(?:\u200d[\U0001F300-\U0001FAFF\u2600-\u27BF][\ufe0f\U0001F3FB-\U0001F3FF]*)*")
YOU_RE = re.compile(r"\b(tú|tu|tus|te|ti|contigo|usted|you|your|yourself)\b", re.I)
I_RE = re.compile(r"\b(yo|me|mi|mis|conmigo|i|my|myself)\b", re.I)


def voice_stats(items: list[dict]) -> str:
    """Compact language statistics for the prompt (the dashboard's Voice tab shows the full version)."""
    texts = [p for p in items if (p.get("text") or "").strip()]
    if not texts:
        return "n/a"
    n = len(texts)
    words = lambda s: re.findall(r"[\w'’]+", s)
    sents = [s for p in texts for s in re.split(r"(?<=[.!?…])\s+|\n+", p["text"]) if words(s)]
    share = lambda pred: f"{round(100 * sum(1 for p in texts if pred(p['text'])) / n)}%"
    def lift(pred):
        yes = [engagement(p) for p in texts if pred(p["text"])]
        no = [engagement(p) for p in texts if not pred(p["text"])]
        if len(yes) < 3 or len(no) < 3:
            return ""
        return f" (median engagement {round(statistics.median(yes))} with vs {round(statistics.median(no))} without)"
    emojis: dict[str, int] = {}
    for p in texts:
        for e in EMOJI_RE.findall(p["text"]):
            emojis[e] = emojis.get(e, 0) + 1
    openings: dict[str, int] = {}
    for p in texts:
        w = " ".join(words(p["text"])[:2]).lower()
        if w:
            openings[w] = openings.get(w, 0) + 1
    checks = [
        ("question marks", lambda s: bool(re.search(r"[?¿]", s))),
        ("exclamation marks", lambda s: bool(re.search(r"[!¡]", s))),
        ("ellipsis", lambda s: "…" in s or "..." in s),
        ("quotation marks", lambda s: bool(re.search(r"[“”\"«»]", s))),
        ("line breaks", lambda s: "\n" in s),
        ("emoji", lambda s: bool(EMOJI_RE.search(s))),
        ("CAPS emphasis", lambda s: bool(re.search(r"\b[A-ZÁÉÍÓÚÑ]{2,}\b", s))),
        ("'you' address", lambda s: bool(YOU_RE.search(s))),
        ("'I' voice", lambda s: bool(I_RE.search(s))),
    ]
    lines = [
        f"{n} texts. Median {round(statistics.median(len(words(p['text'])) for p in texts))} words; "
        f"average sentence {sum(len(words(s)) for s in sents) / max(1, len(sents)):.1f} words.",
    ] + [f"Uses {name}: {share(fn)}{lift(fn)}" for name, fn in checks] + [
        "Top emojis: " + (" ".join(f"{e}×{c}" for e, c in sorted(emojis.items(), key=lambda x: -x[1])[:8]) or "none"),
        "Repeated openings: " + (", ".join([f'"{k}…"×{c}' for k, c in sorted(openings.items(), key=lambda x: -x[1]) if c > 1][:6]) or "none"),
    ]
    return "\n".join(lines)


def build_prompt(paths: Paths, accounts: list[dict], brand_key: str, focus: str) -> str:
    brands = read_json(paths.config / "brands.json")
    if brand_key not in brands:
        raise TrackerError(f"Unknown brand '{brand_key}'. Options: {', '.join(brands)}")
    brand = brands[brand_key]
    posts = [p for a in accounts for p in a["posts"].values() if p["type"] == "post"]
    replies = [p for a in accounts for p in a["posts"].values() if p["type"] == "reply"]
    if not posts and not replies:
        raise TrackerError("No data to analyze yet. Collect the account first.")

    def line(p):
        views = f", views {p['views']}" if p.get("views") else ""
        txt = re.sub(r"\s+", " ", p["text"])[:600] or "(image or video without text)"
        return (f"- @{p['account']} | {(p['date'] or '')[:10]} {weekday_of(p['date']) or ''} | likes {p['likes']}, "
                f"replies {p['replies']}, reposts {p['reposts']}, quotes {p['quotes']}{views} | "
                f"format {format_of(p['text'])} | {len(p['text'])} chars\n  \"{txt}\"")

    ranked = sorted(posts, key=engagement, reverse=True)
    top = "\n".join(line(p) for p in ranked[:60 if focus == "voice" else 25]) or "(none)"
    weak = "\n".join(line(p) for p in ranked[-8:]) if len(ranked) > 30 else "(not enough posts to compare)"
    rep = "\n".join(
        f"- @{p['account']} replied to @{p['parentAuthor'] or 'someone'}: "
        f"\"{squash(p['parentText'])[:250]}\"\n  Reply: \"{squash(p['text'])[:400]}\" (likes {p['likes']})"
        for p in sorted(replies, key=lambda x: x["date"] or "", reverse=True)[:30]) or "(none)"
    convo = []
    for a in accounts:
        for pid, items in list(a.get("comments", {}).items())[:6]:
            post = a["posts"].get(pid, {})
            convo.append(f"Post by @{a['handle']}: \"{squash(post.get('text', ''))[:200]}\"")
            for c in items[:12]:
                who = "AUTHOR" if c["isAuthor"] else "follower"
                convo.append(f"  {'  ' * (c['depth'] - 1)}[{who}] @{c['username']} (likes {c['likes']}): "
                             f"\"{squash(c['text'])[:250]}\"")
    convo_txt = "\n".join(convo) or "(comments were not collected)"

    def agg(keyfn):
        groups: dict[str, list] = {}
        for p in posts:
            k = keyfn(p)
            if k:
                groups.setdefault(k, []).append(engagement(p))
        return "; ".join(f"{k}: {len(v)} posts, avg {round(sum(v) / len(v))}, median {round(statistics.median(v))}"
                         for k, v in groups.items()) or "n/a"

    followers = ", ".join(f"@{a['handle']} {a['profile'].get('followers', 'unknown')}" for a in accounts)
    viewed = [p for p in posts if p.get("views")]
    views_line = (f"Median views {round(statistics.median(p['views'] for p in viewed))} "
                  f"({len(viewed)} of {len(posts)} posts show views)") if viewed else "Views not available"
    template = (paths.prompts / "report.md").read_text(encoding="utf-8")
    task = (paths.prompts / f"task_{focus}.md").read_text(encoding="utf-8")
    values = {
        "BRAND_NAME": brand["name"], "BRAND_CONTEXT": brand["context"], "DRAFTS_LANGUAGE": brand["drafts_language"],
        "ACCOUNTS": ", ".join("@" + a["handle"] for a in accounts), "FOLLOWERS": followers,
        "POST_COUNT": str(len(posts)), "REPLY_COUNT": str(len(replies)), "VIEWS": views_line,
        "BY_FORMAT": agg(lambda p: format_of(p["text"])), "BY_LENGTH": agg(lambda p: length_of(p["text"])),
        "BY_WEEKDAY": agg(lambda p: weekday_of(p["date"])),
        "VOICE_POSTS": voice_stats(posts), "VOICE_REPLIES": voice_stats(replies),
        "TOP_POSTS": top, "WEAK_POSTS": weak, "REPLIES": rep, "CONVERSATIONS": convo_txt,
    }
    task = task.replace("{{BRAND_NAME}}", brand["name"]).replace("{{DRAFTS_LANGUAGE}}", brand["drafts_language"])
    values["TASK"] = task
    for k, v in values.items():
        template = template.replace("{{" + k + "}}", v)
    return template


def report(paths: Paths, settings: dict, handles: list[str], brand: str, focus: str, dry_run: bool,
           requested_by: str = "") -> Path:
    accounts = []
    for h in handles:
        acc = read_json(paths.account_file(h))
        if not acc:
            raise TrackerError(f"No data for @{h} yet. Run collect first.")
        accounts.append(acc)
    log(f"\n=== Writing {focus} report for {', '.join('@' + h for h in handles)} (brand: {brand}) ===")
    prompt = build_prompt(paths, accounts, brand, focus)
    text = ask_claude(prompt, settings, dry_run)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d-%H%M")
    slug = handles[0] if len(handles) == 1 else "all-accounts"
    rel = f"reports/{slug}/{stamp}-{focus}-{brand}.md"
    title = {"full": "Full analysis", "ideas": "Post ideas", "replies": "Reply analysis", "voice": "AI linguistic report"}[focus]
    header = (f"# {title}: {', '.join('@' + h for h in handles)}\n\n"
              f"Brand: {read_json(paths.config / 'brands.json')[brand]['name']} · Generated {now_iso()[:16].replace('T', ' ')} UTC\n\n")
    out = paths.root / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(header + text.strip() + "\n", encoding="utf-8")
    idx = read_json(paths.reports / "index.json", [])
    entry = {"path": rel, "title": title, "accounts": handles, "brand": brand, "focus": focus, "created": now_iso()}
    if requested_by:
        entry["requestedBy"] = requested_by[:120]
    idx.insert(0, entry)
    write_json(paths.reports / "index.json", idx[:500])
    log(f"Report saved: {rel}")
    return out


def add_account(paths: Paths, handle: str, note: str = "", comments: bool = False) -> bool:
    cfg_path = paths.config / "accounts.json" if paths.root == ROOT else paths.data / "accounts-config.json"
    cfg = read_json(cfg_path) or read_json(paths.config / "accounts.json", {"accounts": []})
    if any(a["handle"] == handle for a in cfg["accounts"]):
        return False
    cfg["accounts"].append({"handle": handle, "note": note, "comments": comments})
    write_json(cfg_path, cfg)
    log(f"Added @{handle} to the tracked accounts.")
    return True


# ---------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Threads Competitor Tracker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("collect", "refresh", "report", "add", "index"):
        p = sub.add_parser(name)
        p.add_argument("--dry-run", action="store_true", help="use sample data, call nothing, write to a temp folder")
        if name in ("collect", "report", "add"):
            p.add_argument("--handle", help="profile link or @handle")
        if name in ("collect", "refresh"):
            p.add_argument("--max-posts", type=int)
            p.add_argument("--no-replies", action="store_true")
            p.add_argument("--comments", action="store_true", help="also collect comments under the top posts")
        if name == "report":
            p.add_argument("--all", action="store_true", help="one report across every tracked account")
            p.add_argument("--brand", default="ines")
            p.add_argument("--focus", default="full", choices=["full", "ideas", "replies", "voice"])
            p.add_argument("--requested-by", default="")
        if name == "add":
            p.add_argument("--note", default="")
    args = ap.parse_args(argv)

    root = ROOT
    if args.dry_run:
        root = Path(tempfile.mkdtemp(prefix="tracker-dry-"))
        for d in ("data", "reports"):
            if (ROOT / d).exists():
                shutil.copytree(ROOT / d, root / d)
        log(f"[dry run] working in {root} - nothing in the repository will change")
    paths = Paths(root)
    settings = read_json(paths.config / "settings.json")
    setup_budget(paths, settings, args.dry_run)

    try:
        if args.cmd == "index":
            update_index(paths)
            return 0
        if args.cmd == "add":
            add_account(paths, clean_handle(args.handle), args.note)
            update_index(paths)
            return 0
        if args.cmd == "report":
            if args.all:
                cfg = read_json(paths.config / "accounts.json")["accounts"]
                handles = [a["handle"] for a in cfg if paths.account_file(a["handle"]).exists()]
            else:
                handles = [clean_handle(args.handle)]
            report(paths, settings, handles, args.brand, args.focus, args.dry_run, args.requested_by)
            update_index(paths)
            return 0
        apify = Apify(os.environ.get("APIFY_TOKEN"), args.dry_run)
        max_posts = args.max_posts or settings["max_posts_per_account"]
        replies = settings["include_replies"] and not args.no_replies
        if args.cmd == "collect":
            handle = clean_handle(args.handle)
            add_account(paths, handle, comments=args.comments)
            collect(paths, settings, apify, handle, max_posts, replies, args.comments)
        else:  # refresh
            cfg = read_json(paths.config / "accounts.json")["accounts"]
            failed = []
            for a in cfg:
                try:
                    collect(paths, settings, apify, a["handle"], max_posts, replies, args.comments or a.get("comments", False))
                except TrackerError as e:
                    log(f"!! @{a['handle']}: {e}")
                    failed.append(a["handle"])
            if failed and len(failed) == len(cfg):
                raise TrackerError("Every account failed - see the messages above.")
        update_index(paths)
        return 0
    except TrackerError as e:
        log(f"\nERROR: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
