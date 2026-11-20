#!/usr/bin/env python3
"""
Threads Competitor Tracker - data pipeline.

Commands (run from the repository root):

  python scripts/tracker.py collect  --handle esmipsicologa [--max-posts 60] [--no-replies] [--comments]
  python scripts/tracker.py refresh  [--comments]            # every account in config/accounts.json
  python scripts/tracker.py monthly                          # one summary report per brand (its own competitors)
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


def spent_this_month(kind: str = "") -> float:
    m = _usage().get(month_key(), {})
    if not kind:
        return float(m.get("total", 0))
    return round(sum(i["usd"] for i in m.get("items", []) if i.get("kind") == kind), 4)


LIMIT_KEYS = {"apify": "monthly_budget_apify_usd", "claude": "monthly_budget_claude_usd"}
SERVICE = {"apify": "Apify (collecting posts)", "claude": "Claude (AI reports and plans)"}


def budget_left(kind: str = "") -> float:
    s = BUDGET["settings"]
    limit = float(s.get(LIMIT_KEYS.get(kind, ""), 0) or 0) if kind else 0
    spent = spent_this_month(kind) if limit else spent_this_month()
    limit = limit or float(s.get("monthly_budget_usd", 0) or 0)
    return 9999.0 if not limit or not BUDGET["path"] else round(limit - spent, 4)


def check_budget(minimum: float = 0.02, kind: str = "") -> float:
    left = budget_left(kind)
    if left < minimum:
        key = LIMIT_KEYS.get(kind, "monthly_budget_usd")
        limit = BUDGET["settings"].get(key) or BUDGET["settings"].get("monthly_budget_usd")
        raise TrackerError(f"This month's {SERVICE.get(kind, '')} budget of ${limit} is used up "
                           f"(spent ${spent_this_month(kind if BUDGET['settings'].get(key) else ''):.2f}). "
                           f"It starts again on the 1st, or raise {key} in config/settings.json.")
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


def _pct_ranks(values: list[float]) -> list[float]:
    """0..1 percentile rank of each value (ties share a rank)."""
    order = sorted(values)
    n = len(values)
    return [(order.index(v) + order.count(v) / 2) / n if n else 0 for v in values]


def rank_posts(posts: list[dict], followers: dict) -> list[dict]:
    """Best posts first: engagement rate (per follower) counts most, then likes, then views.
    Posts with no likes and no interaction at all are dropped."""
    posts = [p for p in posts if p.get("likes", 0) > 0 or engagement(p) > 0]
    if not posts:
        return []
    er = [engagement(p) / max(1, followers.get(p.get("account"), 0) or 1) for p in posts]
    likes = [p.get("likes", 0) for p in posts]
    views = [p.get("views") or 0 for p in posts]
    has_views = any(views)
    w = (0.5, 0.3, 0.2) if has_views else (0.6, 0.4, 0.0)
    r_er, r_l, r_v = _pct_ranks(er), _pct_ranks(likes), _pct_ranks(views)
    for p, a, b, c, e in zip(posts, r_er, r_l, r_v, er):
        p["_score"] = w[0] * a + w[1] * b + w[2] * c
        p["_er"] = e
    return sorted(posts, key=lambda p: (p["_score"], p["_er"], p.get("likes", 0), p.get("views") or 0), reverse=True)


def select_top(accounts: list[dict], top_n: int) -> tuple[list[dict], str]:
    """Top N posts per account by the ranking above; returns the posts and a note on how they were chosen."""
    chosen, notes = [], []
    for a in accounts:
        posts = [p for p in a["posts"].values() if p["type"] == "post"]
        ranked = rank_posts(posts, {a["handle"]: a["profile"].get("followers", 0)})
        pick = ranked[:top_n]
        chosen += pick
        notes.append(f"@{a['handle']}: top {len(pick)} of {len(posts)} collected posts "
                     f"({len(posts) - len(ranked)} with no likes or interaction left out)")
    rule = ("Posts are ranked by engagement rate (likes + replies + reposts + quotes per follower) first, "
            "then likes, then views. Only the top posts are analyzed; weaker and empty posts are left out on purpose, "
            "so treat every post below as a strong performer and compare them with each other.")
    return chosen, rule + "\n" + "\n".join("- " + n for n in notes)


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
        max_cost = round(min(max_cost, check_budget(0.02, "apify")), 2)
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

def claude_model(settings: dict) -> dict:
    """Model chosen for this run: TRACKER_MODEL=standard|economy (from the website form), else the default."""
    models = settings.get("claude_models") or {}
    mode = (os.environ.get("TRACKER_MODEL") or settings.get("claude_default_mode") or "standard").strip().lower()
    m = models.get(mode) or {"id": settings["claude_model"], "in": settings.get("claude_price_input_per_mtok", 2),
                             "out": settings.get("claude_price_output_per_mtok", 10)}
    return {**m, "mode": mode}


def ask_claude(prompt: str, settings: dict, dry_run: bool) -> str:
    model = claude_model(settings)
    if dry_run:
        log("[dry run] would send the report prompt to Claude "
            f"({len(prompt)} characters, model {model['id']} - {model['mode']})")
        return "### What's working\n- (dry run) This is where Claude's analysis would appear.\n"
    check_budget(0.02, "claude")
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise TrackerError("ANTHROPIC_API_KEY is missing. Add it in GitHub: Settings → Secrets and variables → Actions.")
    log(f"Model: {model['id']} ({model['mode']})")
    body = {"model": model["id"], "max_tokens": settings["claude_max_tokens"],
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
        tin, tout = usage.get("input_tokens") or 0, usage.get("output_tokens") or 0
        long_mult = float(model.get("long_mult", 1)) if tin > int(model.get("long_from", 10 ** 9)) else 1
        cost = (tin * float(model["in"]) + tout * float(model["out"])) * long_mult / 1e6
        record_cost("claude", cost, f"[{model['mode']}] " + prompt[:70].replace("\n", " "))
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
            "handle": a["handle"], "note": a.get("note", ""), "brands": a.get("brands", []),
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
    brands = {k: {"name": v.get("name", k)} for k, v in (read_json(paths.config / "brands.json", {}) or {}).items()}
    write_json(paths.data / "index.json", {"updated": now_iso(), "brands": brands, "accounts": out, "reports": reports[:200],
                                           "competitors": competitors[:100],
                                           "plans": read_json(paths.data / "plans" / "index.json", [])[:100],
                                           "usage": {"month": month_key(), "spent": round(month.get("total", 0), 2),
                                                     "budget": settings.get("monthly_budget_usd"),
                                                     "apify": round(sum(i["usd"] for i in month.get("items", []) if i.get("kind") == "apify"), 2),
                                                     "claude": round(sum(i["usd"] for i in month.get("items", []) if i.get("kind") == "claude"), 2),
                                                     "apifyBudget": settings.get("monthly_budget_apify_usd"),
                                                     "claudeBudget": settings.get("monthly_budget_claude_usd")}})


# ---------------------------------------------------------------- commands

def collect(paths: Paths, settings: dict, apify: Apify, handle: str, max_posts: int,
            replies: bool, comments: bool) -> dict:
    log(f"\n=== Collecting @{handle} ===")
    # Posts and replies are collected separately: the Apify item limit counts both together,
    # and accounts that reply a lot would otherwise leave almost no posts to pick the best from.
    pool = min(100, max(int(max_posts * 1.7), 35))  # collect a bit more, then keep the best max_posts
    base = {"usernames": [handle], "includeViewCounts": True, "includeAuthorDetails": True,
            "proxyConfiguration": {"useApifyProxy": True}}
    existing = load_account(paths, handle)
    last = existing["profile"].get("lastFetched")
    if settings.get("only_new_posts_on_refresh") and last and existing["posts"]:
        days = max(2, int((dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(last.replace("Z", "+00:00"))).days) + 2)
        base["postedAfter"] = f"{days} days"
        log(f"Only posts from the last {days} days (older ones are already saved)")
    rows = apify.run(settings["apify_profile_actor"], {**base, "profileContent": ["profile", "posts"], "maxItemsPerInput": pool},
                     settings["max_cost_usd_per_run"], "profile_run.json")
    n_replies = int(settings.get("replies_per_account", 15))
    if replies and n_replies:
        try:
            rows += apify.run(settings["apify_profile_actor"], {**base, "profileContent": ["replies"], "maxItemsPerInput": n_replies},
                              settings["max_cost_usd_per_run"], "profile_run.json") or []
        except TrackerError as e:
            log(f"!! Replies not collected: {e}")
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
    posts = [p for p in rank_posts([p for p in account["posts"].values() if p["type"] == "post" and p["url"]],
                                   {account["handle"]: account["profile"].get("followers", 0)})][:settings["comments_top_posts"]]
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


def build_prompt(paths: Paths, accounts: list[dict], brand_key: str, focus: str, top_n: int = 60) -> str:
    brands = read_json(paths.config / "brands.json")
    if brand_key not in brands:
        raise TrackerError(f"Unknown brand '{brand_key}'. Options: {', '.join(brands)}")
    brand = brands[brand_key]
    posts, selection = select_top(accounts, top_n)
    replies = [p for a in accounts for p in a["posts"].values() if p["type"] == "reply"]
    if not posts and not replies:
        raise TrackerError("No data to analyze yet. Collect the account first.")

    def line(p):
        views = f", views {p['views']}" if p.get("views") else ""
        txt = re.sub(r"\s+", " ", p["text"])[:600] or "(image or video without text)"
        return (f"- @{p['account']} | {(p['date'] or '')[:10]} {weekday_of(p['date']) or ''} | likes {p['likes']}, "
                f"replies {p['replies']}, reposts {p['reposts']}, quotes {p['quotes']}{views} | "
                f"format {format_of(p['text'])} | {len(p['text'])} chars\n  \"{txt}\"")

    ranked = posts  # already best-first
    top = "\n".join(line(p) for p in ranked[:60 if focus == "voice" else 30]) or "(none)"
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
        "TOP_POSTS": top, "SELECTION": selection, "REPLIES": rep, "CONVERSATIONS": convo_txt,
    }
    task = task.replace("{{BRAND_NAME}}", brand["name"]).replace("{{DRAFTS_LANGUAGE}}", brand["drafts_language"])
    values["TASK"] = task
    for k, v in values.items():
        template = template.replace("{{" + k + "}}", v)
    return template


# ---------------------------------------------------------------- facts block (computed, not AI)

def _fmt_n(n) -> str:
    if n is None:
        return "-"
    n = float(n)
    return f"{n / 1e6:.1f}M" if n >= 1e6 else f"{n / 1e3:.1f}K" if n >= 1e4 else f"{int(round(n)):,}"


def _cell(t: str, n: int = 70) -> str:
    t = " ".join((t or "").split()).replace("|", "/")
    return t if len(t) <= n else t[:n - 1].rstrip() + "…"


def _rate(p) -> float | None:
    return engagement(p) / p["views"] * 100 if p.get("views") else None


def facts_markdown(accounts: list[dict], chosen: list[dict], tz_name: str) -> str:
    """Reliable numbers for the top of every report: a scorecard, top posts and best posting times."""
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(tz_name)
    except Exception:
        tz, tz_name = dt.timezone.utc, "UTC"
    now = dt.datetime.now(dt.timezone.utc)
    out = ["## At a glance", ""]
    out.append("| Account | Followers | Posts a week | Typical views | Typical likes | Reactions per 100 views | Best post |")
    out.append("|---|---|---|---|---|---|---|")
    every = []
    for a in accounts:
        posts = [p for p in a["posts"].values() if p["type"] == "post" and p.get("date")]
        every += posts
        dates = [dt.datetime.fromisoformat(p["date"].replace("Z", "+00:00")) for p in posts]
        recent = [d for d in dates if (now - d).days <= 30]
        span = max(7, (now - min(dates)).days) if dates else 0
        per_week = len(recent) / 30 * 7 if len(recent) >= 3 else (len(dates) / span * 7 if span else 0)
        views = [p["views"] for p in posts if p.get("views")]
        rates = [r for r in map(_rate, posts) if r is not None]
        best = max(posts, key=engagement) if posts else None
        best_cell = (f"[{_fmt_n(best['likes'])} likes]({best['url']})" if best and best.get("url") else "-")
        out.append(f"| @{a['handle']} | {_fmt_n(a['profile'].get('followers'))} | {per_week:.1f} | "
                   f"{_fmt_n(statistics.median(views)) if views else '-'} | "
                   f"{_fmt_n(statistics.median([p['likes'] for p in posts])) if posts else '-'} | "
                   f"{statistics.median(rates):.1f} | {best_cell} |" if posts else f"| @{a['handle']} | - | - | - | - | - | - |")
    out += ["", "*Typical = median, so one viral post doesn't distort it. Reactions = likes + replies + reposts + quotes.*", ""]

    top = sorted(chosen, key=engagement, reverse=True)[:5]
    if top:
        out += ["## Top 5 posts", "", "| # | Post | Likes | Views | Reactions per 100 views |", "|---|---|---|---|---|"]
        for i, p in enumerate(top, 1):
            who = f"@{p['account']}: " if len(accounts) > 1 else ""
            text = f"[{_cell(who + p['text'])}]({p['url']})" if p.get("url") else _cell(who + p["text"])
            r = _rate(p)
            out.append(f"| {i} | {text} | {_fmt_n(p['likes'])} | {_fmt_n(p.get('views'))} | {f'{r:.1f}' if r is not None else '-'} |")
        out.append("")

    def band(h):
        return "Morning (6-12)" if 6 <= h < 12 else "Afternoon (12-17)" if h < 17 else "Evening (17-22)" if h < 22 else "Night (22-6)"
    days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    slots = {}
    for p in every:
        d = dt.datetime.fromisoformat(p["date"].replace("Z", "+00:00")).astimezone(tz)
        slots.setdefault((days[d.weekday()], band(d.hour if d.hour >= 6 else 23)), []).append(engagement(p))
    typical = statistics.median([engagement(p) for p in every]) if every else 0
    ranked = sorted(((k, v) for k, v in slots.items() if len(v) >= 2), key=lambda kv: statistics.median(kv[1]), reverse=True)
    by_band = {}
    for (d, b), v in slots.items():
        by_band.setdefault(b, []).extend(v)
    if ranked:
        out += [f"## Best time to post ({tz_name.split('/')[-1].replace('_', ' ')} time)", "",
                "| When | Posts | Typical reactions | Compared with usual |", "|---|---|---|---|"]
        for (d, b), v in ranked[:4]:
            m = statistics.median(v)
            ratio = m / typical if typical else 0
            vs = f"{ratio:.1f}x usual" if ratio >= 2 else f"{(ratio - 1) * 100:+.0f}%"
            out.append(f"| {d}, {b.lower()} | {len(v)} | {_fmt_n(m)} | {vs} |")
        best_band = max(by_band.items(), key=lambda kv: statistics.median(kv[1]) if len(kv[1]) >= 3 else -1)
        out += ["", f"*Across all days, {best_band[0].lower()} works best (typical {_fmt_n(statistics.median(best_band[1]))} reactions "
                    f"vs {_fmt_n(typical)} overall). Small samples - treat as a starting point and test.*", ""]
    return "\n".join(out)


def report(paths: Paths, settings: dict, handles: list[str], brand: str, focus: str, dry_run: bool,
           requested_by: str = "", combined: bool = False, top_n: int = 0) -> Path:
    top_n = top_n or settings.get("top_posts_to_analyze", 60)
    accounts = []
    for h in handles:
        acc = read_json(paths.account_file(h))
        if not acc:
            raise TrackerError(f"No data for @{h} yet. Run collect first.")
        accounts.append(acc)
    log(f"\n=== Writing {focus} report for {', '.join('@' + h for h in handles)} (brand: {brand}) ===")
    brands_cfg = read_json(paths.config / "brands.json")
    chosen, _ = select_top(accounts, top_n)
    facts = facts_markdown(accounts, chosen, brands_cfg[brand].get("timezone", "Europe/Madrid"))
    prompt = build_prompt(paths, accounts, brand, focus, top_n).replace("{{FACTS}}", facts)
    text = ask_claude(prompt, settings, dry_run)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d-%H%M")
    combined = combined or len(handles) > 1
    slug = f"all-{brand}" if combined else handles[0]
    rel = f"reports/{slug}/{stamp}-{focus}-{brand}.md"
    title = {"full": "Full analysis", "ideas": "Post ideas", "replies": "Reply analysis", "voice": "AI linguistic report"}[focus]
    brand_name = read_json(paths.config / 'brands.json')[brand]['name']
    if combined:
        title += f" - all {brand_name.split(' (')[0]}'s competitors"
    header = (f"# {title}: {', '.join('@' + h for h in handles)}\n\n"
              f"Brand: {read_json(paths.config / 'brands.json')[brand]['name']} · Generated {now_iso()[:16].replace('T', ' ')} UTC\n\n")
    out = paths.root / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    glance, _, rest = facts.partition("## Top 5 posts")
    rest = ("## Top 5 posts" + rest) if rest else ""
    out.write_text(header + glance.strip() + "\n\n---\n\n" + text.strip() + ("\n\n---\n\n" + rest.strip() if rest else "") + "\n",
                   encoding="utf-8")
    idx = read_json(paths.reports / "index.json", [])
    entry = {"path": rel, "title": title, "accounts": handles, "brand": brand, "focus": focus,
             "scope": "all" if combined else "single", "created": now_iso()}
    if requested_by:
        entry["requestedBy"] = requested_by[:120]
    idx.insert(0, entry)
    write_json(paths.reports / "index.json", idx[:500])
    log(f"Report saved: {rel}")
    return out


def accounts_cfg_path(paths: Paths) -> Path:
    return paths.config / "accounts.json" if paths.root == ROOT else paths.data / "accounts-config.json"


def read_accounts(paths: Paths) -> list[dict]:
    cfg = read_json(accounts_cfg_path(paths)) or read_json(paths.config / "accounts.json", {"accounts": []})
    return cfg["accounts"]


def add_account(paths: Paths, handle: str, note: str = "", comments: bool = False, brand: str = "") -> bool:
    """Track an account; when a brand is given, also mark the account as that brand's competitor."""
    accounts = read_accounts(paths)
    existing = next((a for a in accounts if a["handle"] == handle), None)
    if existing:
        if brand and brand not in existing.setdefault("brands", []):
            existing["brands"].append(brand)
            write_json(accounts_cfg_path(paths), {"accounts": accounts})
            log(f"@{handle} is now also a competitor for '{brand}'.")
        return False
    accounts.append({"handle": handle, "note": note, "comments": comments, "brands": [brand] if brand else []})
    write_json(accounts_cfg_path(paths), {"accounts": accounts})
    log(f"Added @{handle} to the tracked accounts" + (f" (competitor for '{brand}')." if brand else "."))
    return True


def accounts_for(paths: Paths, brand: str) -> list[str]:
    """Handles tracked as competitors for this brand (that already have data)."""
    return [a["handle"] for a in read_accounts(paths)
            if brand in a.get("brands", []) and paths.account_file(a["handle"]).exists()]


def monthly(paths: Paths, settings: dict, dry_run: bool) -> None:
    """One summary report per brand, each built only from that brand's own competitors."""
    brands = read_json(paths.config / "brands.json", {})
    done = 0
    for key, b in brands.items():
        handles = accounts_for(paths, key)
        if not handles:
            log(f"- {b.get('name', key)}: no competitors tracked yet, skipped.")
            continue
        try:
            report(paths, settings, handles, key, "full", dry_run, "monthly schedule", combined=True)
            done += 1
        except TrackerError as e:
            log(f"!! {b.get('name', key)}: {e}")
    if not done:
        raise TrackerError("No monthly reports were written - no brand has tracked competitors yet.")


# ---------------------------------------------------------------- main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Threads Competitor Tracker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("collect", "refresh", "report", "add", "index", "monthly"):
        p = sub.add_parser(name)
        p.add_argument("--dry-run", action="store_true", help="use sample data, call nothing, write to a temp folder")
        if name in ("collect", "report", "add"):
            p.add_argument("--handle", help="profile link or @handle")
        if name == "refresh":
            p.add_argument("--brand", default="", help="only this brand's competitors")
        if name in ("collect", "refresh"):
            p.add_argument("--max-posts", type=int)
            p.add_argument("--no-replies", action="store_true")
            p.add_argument("--comments", action="store_true", help="also collect comments under the top posts")
        if name == "report":
            p.add_argument("--all", action="store_true", help="same as --scope all")
            p.add_argument("--top", type=int, default=0, help="how many best posts per account to analyze (default 60)")
            p.add_argument("--scope", default="single", choices=["single", "all", "each"],
                           help="single = --handle; all = one combined report on the brand's competitors; each = one report per competitor")
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
        if args.cmd == "monthly":
            monthly(paths, settings, args.dry_run)
            update_index(paths)
            return 0
        if args.cmd == "report":
            scope = "all" if args.all else args.scope
            if scope == "single":
                handles = [clean_handle(args.handle)]
                add_account(paths, handles[0], brand=args.brand)
                report(paths, settings, handles, args.brand, args.focus, args.dry_run, args.requested_by, top_n=args.top)
            else:
                handles = accounts_for(paths, args.brand)
                if not handles:
                    raise TrackerError(f"No competitors tracked for '{args.brand}' yet. Add a few first: in Reports, "
                                       "paste a competitor's Threads link and press Run.")
                if scope == "all":
                    report(paths, settings, handles, args.brand, args.focus, args.dry_run, args.requested_by, combined=True, top_n=args.top)
                else:
                    failed = []
                    for h in handles:
                        try:
                            report(paths, settings, [h], args.brand, args.focus, args.dry_run, args.requested_by, top_n=args.top)
                        except TrackerError as e:
                            log(f"!! @{h}: {e}")
                            failed.append(h)
                            if "budget" in str(e).lower():
                                break
                    if len(failed) == len(handles):
                        raise TrackerError("Every report failed - see the messages above.")
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
            if args.brand:
                cfg = [a for a in cfg if args.brand in a.get("brands", [])]
                if not cfg:
                    raise TrackerError(f"No competitors tracked for '{args.brand}' yet.")
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
