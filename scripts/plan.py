#!/usr/bin/env python3
"""
Turn the tracked competitors' data and AI reports into action steps and a dated content plan.

  python scripts/plan.py --brand ines --weeks 4 --per-week 4 [--start 2026-11-23] [--accounts a,b] [--dry-run]

Reads data/accounts/*.json and the latest reports per account, asks Claude for a JSON plan, and saves
data/plans/<id>.json (shown on the dashboard's Content plan tab). If NOTION_TOKEN is set, the plan is also created in Notion
as a database, under the brand's "notion_page" in config/brands.json (or NOTION_PARENT_PAGE as a fallback).
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
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tracker as T  # noqa: E402

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def next_monday() -> dt.date:
    d = dt.date.today()
    return d + dt.timedelta(days=(7 - d.weekday()) % 7 or 7)


def account_brief(paths: T.Paths, acc: dict) -> str:
    posts = [p for p in acc["posts"].values() if p["type"] == "post"]
    replies = [p for p in acc["posts"].values() if p["type"] == "reply"]
    ranked = sorted(posts, key=T.engagement, reverse=True)
    top = "\n".join(f"  - [{T.format_of(p['text'])}, {T.weekday_of(p['date'])}, eng {T.engagement(p)}, views {p.get('views', 0)}] "
                    f"\"{T.squash(p['text'])[:220]}\"" for p in ranked[:10])
    lines = [f"@{acc['handle']} - {acc['profile'].get('followers', '?')} followers, {len(posts)} posts, {len(replies)} replies tracked",
             "Language stats (posts):", T.voice_stats(posts), "Top posts:", top or "  (none)"]
    # latest reports for this account (most useful context), trimmed
    idx = T.read_json(paths.reports / "index.json", [])
    for r in [r for r in idx if acc["handle"] in r["accounts"]][:2]:
        f = paths.root / r["path"]
        if f.exists():
            txt = f.read_text(encoding="utf-8")
            lines.append(f"Latest AI report ({r['title']}), excerpt:\n{txt[:5000]}")
    return "\n".join(lines)


# Fixed, consistent schedule: which weekdays (0=Mon) and which times of day.
WEEKDAYS = {1: [2], 2: [1, 3], 3: [0, 2, 4], 4: [0, 1, 3, 4], 5: [0, 1, 2, 3, 4], 6: [0, 1, 2, 3, 4, 5]}
DEFAULT_TIMES = {
    1: ["21:30"],
    2: ["13:00", "21:30"],
    3: ["09:00", "14:00", "21:30"],
    4: ["09:00", "13:00", "18:00", "21:30"],
    5: ["08:30", "11:30", "14:30", "18:00", "21:30"],
    6: ["08:30", "11:00", "13:30", "16:00", "19:00", "21:30"],
    7: ["08:00", "10:30", "12:30", "14:30", "17:00", "19:30", "22:00"],
    8: ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"],
    9: ["08:00", "09:30", "11:00", "12:30", "14:00", "16:00", "18:00", "20:00", "22:00"],
    10: ["08:00", "09:30", "11:00", "12:30", "14:00", "15:30", "17:00", "18:30", "20:00", "21:30"],
}
PER_WEEK_OPTIONS = [2, 3, 4, 5] + [7 * n for n in range(1, 11)]   # 7 = 1 a day ... 70 = 10 a day
MAX_POSTS_PER_PLAN = 140   # e.g. 10 a day for 2 weeks
POSTS_PER_CALL = 28        # longer plans are written in parts


def slot_role(t: str, last: bool) -> str:
    h = int(t[:2])
    if last:
        return "last post of the day, the main one: strongest idea, a story or a question that invites replies"
    if h < 12:
        return "morning: short, soft, comforting (1-2 sentences)"
    if h < 17:
        return "daytime: practical - a list, signs, a clear tip or a quick opinion"
    return "evening: relatable - a story, a confession-style line or a question"


def schedule(start: dt.date, weeks: int, per_week: int, brand: dict) -> list[dict]:
    """Every slot in order: same weekdays every week, same times every day, morning to evening."""
    per_day = max(1, per_week // 7) if per_week >= 7 else 1
    days = list(range(7)) if per_week >= 7 else WEEKDAYS[per_week]
    times = (brand.get("post_times") or {}).get(str(per_day)) or DEFAULT_TIMES[per_day]
    slots = []
    for i in range(weeks * 7):
        d = start + dt.timedelta(days=i)
        if d.weekday() in days:
            for t in times:
                slots.append({"date": d.isoformat(), "time": t, "slot": slot_name(t)})
    return slots


def slot_name(t: str) -> str:
    h = int(t[:2])
    return "Morning" if h < 12 else "Afternoon" if h < 18 else "Evening"


def slot_lines(slots: list[dict], first: int = 1) -> str:
    last_time = {}
    for x in slots:
        last_time[x["date"]] = max(last_time.get(x["date"], ""), x["time"])
    return "\n".join(f"{first + i}. {dt.date.fromisoformat(x['date']).strftime('%a %d %b')} {x['time']} - "
                     f"{slot_role(x['time'], x['time'] == last_time[x['date']])}" for i, x in enumerate(slots))


def common_rules(per_day: int) -> str:
    many = per_day >= 4
    return f"""- Within a day, posts must not repeat the same topic; across days, rotate pillars evenly.
{"- With " + str(per_day) + " posts a day, vary the length and format a lot: mostly one-liners and short thoughts, at most 2 lists a day, at least 1 question a day. Never two posts in a row with the same format." if many else "- Mix formats according to what worked."}
- Vary topics; never copy competitor text - adapt the pattern in the brand's voice.
- Drafts: Threads length (mostly under 300 characters), no hashtags unless the research shows they help.
- Wellbeing brand: no medical claims, no diagnoses, no promises of cure. Use hyphens, never em dashes.
- Everything except hook and draft in English. When hook and draft are not in English, always fill hook_en and draft_en.
- When "why" or an action quotes a non-English post, add the English translation in brackets right after the quote."""


POST_SHAPE = """{{"slot": 1, "pillar": "one of the pillar names", "format": "Statement|Question|List|Personal story|Quote|Thread",
             "topic": "short", "hook": "first line, in {lang}", "draft": "full ready-to-post text in {lang}",
             "hook_en": "English translation of the hook (empty if already English)", "draft_en": "English translation of the draft (empty if already English)",
             "cta": "how to invite replies, or empty", "inspiration": "@handle and the pattern it builds on", "why": "one sentence"}}"""


def build_more_prompt(brand: dict, briefs: list[str], plan: dict, slots: list[dict], first: int, used: list[str], per_day: int) -> str:
    """Prompt for the next part of a long plan: same strategy, new slots, no repeated topics."""
    pillars = "; ".join(f"{p['name']} ({p.get('share', '')})" for p in plan.get("pillars", []))
    return f"""You are a content strategist continuing a content plan that is already partly written.

BRAND
{brand['name']} - {brand['context']}
Posts are written in: {brand['drafts_language']}

STRATEGY (already decided)
{plan.get('summary', '')}
Pillars: {pillars}

COMPETITOR RESEARCH
{chr(10).join(briefs)}

TOPICS ALREADY USED (do not repeat or closely rephrase any of them)
{chr(10).join('- ' + t for t in used[-120:])}

TASK
Return ONLY valid JSON, no commentary: {{"posts": [{POST_SHAPE.format(lang=brand['drafts_language'])}]}}

RULES
- The posting schedule is FIXED. Write exactly {len(slots)} posts, one per slot, in this order (slot = the number):
{slot_lines(slots, first)}
- Use only the pillars above.
{common_rules(per_day)}"""


def build_prompt(brand: dict, briefs: list[str], slots: list[dict], per_day: int = 1, total: int = 0) -> str:
    lines = slot_lines(slots)
    return f"""You are a content strategist. Using the competitor research below, create action steps and a content plan.

BRAND
{brand['name']} - {brand['context']}
Posts are written in: {brand['drafts_language']}

COMPETITOR RESEARCH
{chr(10).join(briefs)}

TASK
Return ONLY valid JSON, no commentary, in exactly this shape:
{{
  "summary": "2-3 sentences: the strategy in plain English",
  "pillars": [{{"name": "short content pillar name", "share": "e.g. 40%", "why": "one sentence with evidence"}}],
  "actions": [{{"title": "imperative, max 10 words", "priority": "High|Medium|Low", "why": "evidence from the data, cite numbers or posts",
               "how": "1-2 concrete sentences", "effort": "Quick|Medium|Big"}}],
  "posts": [{POST_SHAPE.format(lang=brand['drafts_language'])}]
}}

RULES
- 3-5 pillars; 6-10 actions ordered by priority; each action must rest on something in the research.
- The whole plan has {total or len(slots)} posts ({per_day} a day); the summary and pillars must fit that rhythm.
- The posting schedule is FIXED. Here, write exactly {len(slots)} posts (the first part), one per slot, in this order (slot = the number):
{lines}
- Follow each slot's role.
{common_rules(per_day)}"""


def parse_plan(text: str, require_actions: bool = True) -> dict:
    start = text.find("{")
    if start < 0:
        raise T.TrackerError("Claude didn't return a plan in the expected format. Try again.")
    try:
        plan = json.JSONDecoder().raw_decode(text[start:])[0]
    except json.JSONDecodeError:
        raise T.TrackerError("The plan came back incomplete (probably too long). Try fewer weeks or posts per week.")
    for k in (("actions", "posts") if require_actions else ("posts",)):
        if not isinstance(plan.get(k), list) or not plan[k]:
            raise T.TrackerError(f"The plan is missing '{k}'. Try again.")
    return plan


def dry_plan(slots: list[dict]) -> dict:
    posts = []
    for i, _ in enumerate(slots):
            posts.append({"slot": i + 1, "pillar": ["Validation", "Relationships"][i % 2],
                          "format": ["Statement", "List"][i % 2], "topic": f"Sample topic {i + 1}",
                          "hook": "Hook de ejemplo", "draft": "Texto de ejemplo (dry run).", "cta": "",
                          "inspiration": "@esmipsicologa - 'tú' validation", "why": "(dry run)"})
    return {"summary": "(dry run) sample plan.", "pillars": [{"name": "Validation", "share": "60%", "why": "(dry run)"},
                                                              {"name": "Relationships", "share": "40%", "why": "(dry run)"}],
            "actions": [{"title": "Speak to the reader as 'tú'", "priority": "High", "why": "(dry run)", "how": "(dry run)", "effort": "Quick"}],
            "posts": posts}


def place_on_slots(posts: list[dict], slots: list[dict]) -> list[dict]:
    """Put the posts on the fixed schedule, whatever dates Claude wrote."""
    def key(ip):
        i, p = ip
        try:
            return int(p.get("slot", i + 1))
        except (TypeError, ValueError):
            return i + 1
    ordered = [p for _, p in sorted(enumerate(posts), key=key)][:len(slots)]
    for p, sl in zip(ordered, slots):
        p.update(sl)
    return ordered


# ------------------------------------------------------------------ Notion (optional)

def push_notion(plan: dict, title: str, page: str = "") -> str | None:
    token, parent = os.environ.get("NOTION_TOKEN"), page or os.environ.get("NOTION_PARENT_PAGE", "")
    if not token or not parent:
        return None
    parent = re.sub(r"[^0-9a-fA-F]", "", parent.split("?")[0])[-32:]
    h = {"Authorization": f"Bearer {token}", "Notion-Version": "2022-06-28", "Content-Type": "application/json"}
    rt = lambda s: [{"type": "text", "text": {"content": str(s)[:1900]}}]
    sel = lambda names: [{"name": n[:90]} for n in dict.fromkeys(n for n in names if n)]
    pillars = [p["name"] for p in plan.get("pillars", [])] + [p.get("pillar", "") for p in plan["posts"]]
    db = requests.post("https://api.notion.com/v1/databases", headers=h, timeout=60, json={
        "parent": {"type": "page_id", "page_id": parent},
        "title": rt(title),
        "properties": {
            "Post": {"title": {}}, "Date": {"date": {}}, "#": {"number": {}},
            "Slot": {"select": {"options": [{"name": "Morning", "color": "yellow"}, {"name": "Afternoon", "color": "orange"},
                                            {"name": "Evening", "color": "purple"}]}},
            "Status": {"select": {"options": [{"name": "Idea", "color": "gray"}, {"name": "Draft", "color": "yellow"},
                                              {"name": "Scheduled", "color": "blue"}, {"name": "Published", "color": "green"}]}},
            "Pillar": {"select": {"options": sel(pillars)}},
            "Format": {"select": {"options": sel(p.get("format", "") for p in plan["posts"])}},
            "Hook": {"rich_text": {}}, "Draft": {"rich_text": {}}, "Time": {"rich_text": {}},
            "Inspiration": {"rich_text": {}}, "Why": {"rich_text": {}},
        }})
    if db.status_code >= 300:
        T.log(f"Notion: couldn't create the database ({db.status_code}): {db.text[:200]}. "
              "Check NOTION_TOKEN and that the parent page is shared with the integration.")
        return None
    db_id, url = db.json()["id"], db.json().get("url")
    tz = plan.get("timezone") or "Europe/Madrid"
    for n, p in enumerate(plan["posts"], 1):
        when = {"start": f"{p['date']}T{p['time']}:00", "time_zone": tz} if p.get("time") else {"start": p["date"]}
        r = requests.post("https://api.notion.com/v1/pages", headers=h, timeout=60, json={
            "parent": {"database_id": db_id},
            "properties": {
                "Post": {"title": rt(p.get("topic") or p.get("hook", "Post"))},
                "Date": {"date": when}, "#": {"number": n},
                **({"Slot": {"select": {"name": p["slot"]}}} if p.get("slot") else {}),
                "Status": {"select": {"name": "Idea"}},
                **({"Pillar": {"select": {"name": p["pillar"][:90]}}} if p.get("pillar") else {}),
                **({"Format": {"select": {"name": p["format"][:90]}}} if p.get("format") else {}),
                "Hook": {"rich_text": rt(p.get("hook", ""))}, "Draft": {"rich_text": rt(p.get("draft", ""))},
                "Time": {"rich_text": rt(p.get("time", ""))}, "Inspiration": {"rich_text": rt(p.get("inspiration", ""))},
                "Why": {"rich_text": rt(p.get("why", ""))},
            },
            "children": [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": rt(p.get("draft", ""))}}]})
        if r.status_code >= 300:
            T.log(f"Notion: a post failed ({r.status_code}): {r.text[:150]}")
    # action steps as a to-do page under the same parent
    blocks = [{"object": "block", "type": "to_do", "to_do": {"rich_text": rt(f"[{a.get('priority', '')}] {a.get('title', '')} - {a.get('how', '')}"), "checked": False}}
              for a in plan["actions"]]
    requests.post("https://api.notion.com/v1/pages", headers=h, timeout=60, json={
        "parent": {"type": "page_id", "page_id": parent},
        "properties": {"title": {"title": rt(title.replace("Content plan", "Action steps"))}},
        "children": [{"object": "block", "type": "paragraph", "paragraph": {"rich_text": rt(plan.get("summary", ""))}}] + blocks[:90]})
    T.log(f"Notion: plan created {url}")
    return url


# ------------------------------------------------------------------ main

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Create action steps and a content plan")
    ap.add_argument("--brand", default="ines")
    ap.add_argument("--weeks", type=int, default=4)
    ap.add_argument("--per-week", type=int, default=4)
    ap.add_argument("--start", default="")
    ap.add_argument("--accounts", default="", help="comma-separated handles; default = all tracked")
    ap.add_argument("--requested-by", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    root = T.ROOT
    if a.dry_run:
        root = Path(tempfile.mkdtemp(prefix="plan-dry-"))
        for d in ("data", "reports"):
            if (T.ROOT / d).exists():
                shutil.copytree(T.ROOT / d, root / d)
        T.log(f"[dry run] working in {root}")
    paths = T.Paths(root)
    settings = T.read_json(paths.config / "settings.json")
    T.setup_budget(paths, settings, a.dry_run)
    try:
        brands = T.read_json(paths.config / "brands.json")
        if a.brand not in brands:
            raise T.TrackerError(f"Unknown brand '{a.brand}'.")
        if a.per_week not in PER_WEEK_OPTIONS:
            raise T.TrackerError(f"Posts per week must be one of {PER_WEEK_OPTIONS}.")
        per_week = a.per_week
        weeks = max(1, min(a.weeks, 8, max(1, MAX_POSTS_PER_PLAN // per_week)))
        if weeks < a.weeks:
            T.log(f"Note: {per_week} posts a week is a lot for one plan - making {weeks} weeks instead of {a.weeks}.")
        start = dt.date.fromisoformat(a.start) if a.start else next_monday()
        slots = schedule(start, weeks, per_week, brands[a.brand])
        handles = [T.clean_handle(h) for h in a.accounts.split(",") if h.strip()] or T.accounts_for(paths, a.brand)
        if not handles:
            raise T.TrackerError(f"No competitors tracked for {brands[a.brand]['name']} yet. Use Competitor search on their "
                                 "Threads account, then 'Track and analyze' a few of the accounts it finds.")
        accs = [T.read_json(paths.account_file(h)) for h in handles]
        accs = [x for x in accs if x and x.get("posts")][:6]
        if not accs:
            raise T.TrackerError("No competitor data yet. Run a report on at least one account first.")
        T.log(f"\n=== Content plan for {brands[a.brand]['name']}: {weeks} weeks x {per_week} posts from {start} ===")
        T.log("Based on: " + ", ".join("@" + x["handle"] for x in accs))
        if a.dry_run:
            plan = dry_plan(slots)
        else:
            briefs = [account_brief(paths, x) for x in accs]
            per_day = max(1, per_week // 7)
            parts = [slots[i:i + POSTS_PER_CALL] for i in range(0, len(slots), POSTS_PER_CALL)]
            cfg = {**settings, "claude_max_tokens": 16000}
            if len(parts) > 1:
                T.log(f"Writing {len(slots)} posts in {len(parts)} parts.")
            plan = parse_plan(T.ask_claude(build_prompt(brands[a.brand], briefs, parts[0], per_day, len(slots)), cfg, False))
            plan["posts"] = place_on_slots(plan["posts"], parts[0])
            for n, part in enumerate(parts[1:], 2):
                first = len(plan["posts"]) + 1
                used = [p.get("topic", "") for p in plan["posts"]]
                T.log(f"Part {n} of {len(parts)}...")
                try:
                    more = parse_plan(T.ask_claude(build_more_prompt(brands[a.brand], briefs, plan, part, first, used, per_day),
                                                   cfg, False), require_actions=False)
                except T.TrackerError as e:
                    T.log(f"!! Part {n} failed ({e}). Keeping the {len(plan['posts'])} posts written so far.")
                    break
                for p in more["posts"]:
                    try:
                        p["slot"] = int(p.get("slot", 0)) - first + 1
                    except (TypeError, ValueError):
                        pass
                plan["posts"] += place_on_slots(more["posts"], part)
        if a.dry_run:
            plan["posts"] = place_on_slots(plan["posts"], slots)
        pid = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d-%H%M") + f"-{a.brand}"
        title = f"Content plan - {brands[a.brand]['name']} - {start.isoformat()}"
        out = {"id": pid, "title": title, "brand": a.brand, "brandName": brands[a.brand]["name"], "start": start.isoformat(),
               "weeks": weeks, "perWeek": per_week, "basedOn": [x["handle"] for x in accs], "created": T.now_iso(),
               "requestedBy": a.requested_by[:120], **plan}
        if not a.dry_run:
            plan["timezone"] = brands[a.brand].get("timezone", "Europe/Madrid")
            out["notionUrl"] = push_notion(plan, title, brands[a.brand].get("notion_page", ""))
        rel = f"data/plans/{pid}.json"
        T.write_json(paths.root / rel, out)
        idx = T.read_json(paths.data / "plans" / "index.json", [])
        idx.insert(0, {"id": pid, "path": rel, "title": title, "brand": a.brand, "created": out["created"],
                       "posts": len(out["posts"]), "requestedBy": out["requestedBy"]})
        T.write_json(paths.data / "plans" / "index.json", idx[:100])
        T.update_index(paths)
        T.log(f"Saved: {rel} ({len(out['posts'])} posts, {len(out['actions'])} action steps)")
        return 0
    except T.TrackerError as e:
        T.log(f"\nERROR: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
