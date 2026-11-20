"""Hypothesis cards: pull them out of a report and send them to the Notion 'Threads hypothesis cards' database.

Used automatically after every report that contains cards ("Hypothesis cards" and "Full analysis").
Needs NOTION_TOKEN (GitHub secret) and settings.notion_hypotheses_db; without them the cards are only saved to data/hypotheses.json.
"""
from __future__ import annotations

import os
import re

import requests

TYPES = {"H1": "H1 Strong Expert POV", "H2": "H2 Pattern Recognition", "H3": "H3 Cost of Inaction"}


def _field(block: str, name: str) -> str:
    m = re.search(rf"\*\*{re.escape(name)}:?\*\*:?\s*(.+)", block)
    return m.group(1).strip() if m else ""


def parse_cards(md: str) -> list[dict]:
    """Every '#### H1 · name · Persona' block in the report."""
    cards = []
    parts = re.split(r"(?m)^#### (?=H\d)", md)
    for part in parts[1:]:
        block = part.split("\n### ", 1)[0]
        head = block.split("\n", 1)[0]
        bits = [b.strip() for b in head.split("·")]
        htype = re.match(r"H\d", bits[0]).group(0) if re.match(r"H\d", bits[0]) else ""
        topic_line = _field(block, "Topic")
        topic, _, guard = topic_line.partition("· **Guardrails:**")
        verdict = next((v for v in ("✅ Core", "🧪 Test", "🔍 Gap") if v in topic), "")
        hook = _field(block, "Hook")
        rows = [r for r in block.split("\n") if r.startswith("|") and not re.match(r"^\|\s*-", r) and "Account" not in r]
        ref_url = ""
        xmed = None
        if rows:
            m = re.search(r"\((https?://[^)\s]+)\)", rows[0])
            ref_url = m.group(1) if m else ""
            m = re.search(r"~?(\d+(?:\.\d+)?)\s*×", rows[0])
            xmed = float(m.group(1)) if m else None
        posts = re.split(r"\*\*Posts to test:?\*\*:?", block, 1)
        posts = posts[1].split("\n---")[0].strip() if len(posts) > 1 else ""
        cards.append({
            "name": bits[1] if len(bits) > 1 else head,
            "persona": bits[2] if len(bits) > 2 else "",
            "type": TYPES.get(htype, ""),
            "topic": re.sub(r"\s*\((✅|🧪|🔍)[^)]*\)\s*", "", topic).strip(" ·"),
            "verdict": verdict,
            "guardrails": guard.strip(),
            "mechanic": _field(block, "Mechanic"),
            "insight": _field(block, "Insight"),
            "hook": re.split(r"\s*\((?:🆕|📚)", hook)[0].strip(),
            "novelty": "🆕 New" if "🆕" in hook else "📚 Library" if "📚" in hook else "",
            "reach": _field(block, "Reach because"),
            "quiz_because": _field(block, "Quiz because").split(" · quiz:")[0],
            "ref_url": ref_url,
            "x_median": xmed,
            "refs_table": "\n".join(r for r in block.split("\n") if r.startswith("|")),
            "posts": posts,
        })
    return [c for c in cards if c["mechanic"] or c["insight"]]


def _rt(text: str) -> list:
    text = (text or "")[:1900]
    return [{"type": "text", "text": {"content": text}}] if text else []


def push_cards(cards: list[dict], brand_short: str, report_url: str, created: str, settings: dict, log=print) -> int:
    token, db = os.environ.get("NOTION_TOKEN"), settings.get("notion_hypotheses_db")
    if not (token and db and cards):
        if cards and not token:
            log("Hypothesis cards saved in the repository. Add the NOTION_TOKEN secret to also send them to Notion.")
        return 0
    headers = {"Authorization": f"Bearer {token}", "Notion-Version": "2022-06-28", "Content-Type": "application/json"}
    sent = 0
    for c in cards:
        props = {
            "Name": {"title": _rt(f"{c['name']} · {brand_short}")},
            "Ambassador": {"select": {"name": brand_short}},
            "Status": {"status": {"name": "Backlog"}},
            "Platform": {"select": {"name": "Threads"}},
            "Topic": {"rich_text": _rt(c["topic"])}, "Mechanic": {"rich_text": _rt(c["mechanic"])},
            "Insight": {"rich_text": _rt(c["insight"])}, "Hook": {"rich_text": _rt(c["hook"])},
            "Reach because": {"rich_text": _rt(c["reach"])}, "Quiz because": {"rich_text": _rt(c["quiz_because"])},
            "Guardrails": {"rich_text": _rt(c["guardrails"])}, "Report": {"url": report_url or None},
            "Created": {"date": {"start": created[:10]}},
        }
        for key, name in (("type", "Type"), ("verdict", "Topic verdict"), ("novelty", "Hook novelty")):
            if c[key]:
                props[name] = {"select": {"name": c[key]}}
        if c["ref_url"]:
            props["Ref URL"] = {"url": c["ref_url"]}
        if c["x_median"] is not None:
            props["Ref × median"] = {"number": c["x_median"]}
        if settings.get("notion_owner_id"):
            props["Owner"] = {"people": [{"id": settings["notion_owner_id"]}]}
        body = [{"object": "block", "type": "heading_3", "heading_3": {"rich_text": _rt("References")}},
                {"object": "block", "type": "code", "code": {"language": "markdown", "rich_text": _rt(c["refs_table"])}},
                {"object": "block", "type": "heading_3", "heading_3": {"rich_text": _rt("Posts to test")}},
                {"object": "block", "type": "paragraph", "paragraph": {"rich_text": _rt(c["posts"])}}]
        r = requests.post("https://api.notion.com/v1/pages", headers=headers, timeout=60,
                          json={"parent": {"database_id": db}, "properties": props, "children": body})
        if r.status_code >= 400:
            log(f"!! Notion refused a card ({r.status_code}): {r.text[:200]}")
            continue
        sent += 1
    log(f"Sent {sent} hypothesis card(s) to Notion.")
    return sent
