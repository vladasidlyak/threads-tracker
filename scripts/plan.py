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


def build_prompt(brand: dict, briefs: list[str], start: dt.date, weeks: int, per_week: int) -> str:
    end = start + dt.timedelta(days=7 * weeks - 1)
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
  "posts": [{{"date": "YYYY-MM-DD", "time": "HH:MM", "pillar": "one of the pillar names", "format": "Statement|Question|List|Personal story|Quote|Thread",
             "topic": "short", "hook": "first line, in {brand['drafts_language']}", "draft": "full ready-to-post text in {brand['drafts_language']}",
             "hook_en": "English translation of the hook (empty if already English)", "draft_en": "English translation of the draft (empty if already English)",
             "cta": "how to invite replies, or empty", "inspiration": "@handle and the pattern it builds on", "why": "one sentence"}}]
}}

RULES
- 3-4 pillars; 6-10 actions ordered by priority; each action must rest on something in the research.
- Exactly {per_week * weeks} posts between {start.isoformat()} and {end.isoformat()}, {per_week} per week, spread across the week
  using the weekdays and times that performed best in the research (times in the audience's local time, 24h).
- Mix formats according to what worked; vary topics; never copy competitor text - adapt the pattern in the brand's voice.
- Drafts: Threads length (mostly under 300 characters), no hashtags unless the research shows they help.
- Wellbeing brand: no medical claims, no diagnoses, no promises of cure. Use hyphens, never em dashes.
- Everything except hook and draft in English. When hook and draft are not in English, always fill hook_en and draft_en.
- When "why" or an action quotes a non-English post, add the English translation in brackets right after the quote."""


def parse_plan(text: str) -> dict:
    start = text.find("{")
    if start < 0:
        raise T.TrackerError("Claude didn't return a plan in the expected format. Try again.")
    try:
        plan = json.JSONDecoder().raw_decode(text[start:])[0]
    except json.JSONDecodeError:
        raise T.TrackerError("The plan came back incomplete (probably too long). Try fewer weeks or posts per week.")
    for k in ("actions", "posts"):
        if not isinstance(plan.get(k), list) or not plan[k]:
            raise T.TrackerError(f"The plan is missing '{k}'. Try again.")
    return plan


def dry_plan(start: dt.date, weeks: int, per_week: int) -> dict:
    posts = []
    for w in range(weeks):
        for i in range(per_week):
            d = start + dt.timedelta(days=7 * w + [1, 2, 3, 5, 6][i % 5])
            posts.append({"date": d.isoformat(), "time": "21:30", "pillar": ["Validation", "Relationships"][i % 2],
                          "format": ["Statement", "List"][i % 2], "topic": f"Sample topic {w + 1}.{i + 1}",
                          "hook": "Hook de ejemplo", "draft": "Texto de ejemplo (dry run).", "cta": "",
                          "inspiration": "@esmipsicologa - 'tú' validation", "why": "(dry run)"})
    return {"summary": "(dry run) sample plan.", "pillars": [{"name": "Validation", "share": "60%", "why": "(dry run)"},
                                                              {"name": "Relationships", "share": "40%", "why": "(dry run)"}],
            "actions": [{"title": "Speak to the reader as 'tú'", "priority": "High", "why": "(dry run)", "how": "(dry run)", "effort": "Quick"}],
            "posts": posts}


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
            "Post": {"title": {}}, "Date": {"date": {}},
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
    for p in plan["posts"]:
        r = requests.post("https://api.notion.com/v1/pages", headers=h, timeout=60, json={
            "parent": {"database_id": db_id},
            "properties": {
                "Post": {"title": rt(p.get("topic") or p.get("hook", "Post"))},
                "Date": {"date": {"start": p["date"]}},
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
        weeks, per_week = max(1, min(a.weeks, 8)), max(1, min(a.per_week, 7))
        start = dt.date.fromisoformat(a.start) if a.start else next_monday()
        handles = [T.clean_handle(h) for h in a.accounts.split(",") if h.strip()] or \
                  [x["handle"] for x in T.read_json(paths.config / "accounts.json")["accounts"]]
        accs = [T.read_json(paths.account_file(h)) for h in handles]
        accs = [x for x in accs if x and x.get("posts")][:6]
        if not accs:
            raise T.TrackerError("No competitor data yet. Run a report on at least one account first.")
        T.log(f"\n=== Content plan for {brands[a.brand]['name']}: {weeks} weeks x {per_week} posts from {start} ===")
        T.log("Based on: " + ", ".join("@" + x["handle"] for x in accs))
        if a.dry_run:
            plan = dry_plan(start, weeks, per_week)
        else:
            prompt = build_prompt(brands[a.brand], [account_brief(paths, x) for x in accs], start, weeks, per_week)
            plan = parse_plan(T.ask_claude(prompt, {**settings, "claude_max_tokens": 16000}, False))
        plan["posts"].sort(key=lambda p: (p.get("date", ""), p.get("time", "")))
        pid = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d-%H%M") + f"-{a.brand}"
        title = f"Content plan - {brands[a.brand]['name']} - {start.isoformat()}"
        out = {"id": pid, "title": title, "brand": a.brand, "brandName": brands[a.brand]["name"], "start": start.isoformat(),
               "weeks": weeks, "perWeek": per_week, "basedOn": [x["handle"] for x in accs], "created": T.now_iso(),
               "requestedBy": a.requested_by[:120], **plan}
        if not a.dry_run:
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
