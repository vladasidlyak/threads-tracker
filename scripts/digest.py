"""Email the reports written since a given time (used by the scheduled digest).

Needs GitHub secrets: SMTP_USER (a Gmail address), SMTP_PASSWORD (a Gmail *app password*), MAIL_TO (one or more
addresses, comma-separated). Without them the step just prints what it would send.

    python scripts/digest.py --since 2026-12-01T04:40:00Z
"""
from __future__ import annotations

import argparse
import json
import os
import smtplib
import sys
from email.message import EmailMessage
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
SITE = os.environ.get("TRACKER_SITE", "https://threads-tracker.vlada-sidlyak.workers.dev/")
CSS = """body{font:15px/1.55 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1d1d1f;max-width:860px;margin:24px auto;padding:0 16px}
h1{font-size:22px}h3{font-size:17px;margin-top:28px;border-top:1px solid #e5e5ea;padding-top:14px}h4{font-size:15px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border-bottom:1px solid #e5e5ea;padding:6px 8px;text-align:left;vertical-align:top}
th{color:#6e6e73}blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid #2f6fdb;background:#f3f6fd;border-radius:0 8px 8px 0}
a{color:#2f6fdb}code{background:#f2f2f7;padding:1px 4px;border-radius:4px}"""


def render(md_text: str, title: str) -> str:
    body = markdown.markdown(md_text, extensions=["tables", "sane_lists"])
    return f"<!doctype html><html><head><meta charset='utf-8'><title>{title}</title><style>{CSS}</style></head><body>{body}</body></html>"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", required=True, help="ISO time; reports created at or after it are sent")
    a = ap.parse_args()
    idx = json.loads((ROOT / "reports" / "index.json").read_text(encoding="utf-8"))
    brands = json.loads((ROOT / "config" / "brands.json").read_text(encoding="utf-8"))
    new = [r for r in idx if r.get("created", "") >= a.since]
    if not new:
        print("No new reports to send.")
        return 0
    new.sort(key=lambda r: (r.get("brand", ""), r.get("focus") != "own"))
    rows, files = [], []
    for r in new:
        f = ROOT / r["path"]
        if not f.exists():
            continue
        name = brands.get(r.get("brand"), {}).get("name", r.get("brand", "")).split(" (")[0]
        label = f"{name} - {r['title']}"
        who = ", ".join("@" + x for x in r["accounts"][:6]) + (" ..." if len(r["accounts"]) > 6 else "")
        rows.append(f"<li><b>{label}</b><br><span style='color:#6e6e73'>{who}</span></li>")
        tag = "" if r.get("scope") == "all" else "_@" + r["accounts"][0]
        fname = (label.replace(" ", "_").replace("/", "-") + tag + "_" + r["created"][:10] + ".html").replace("'", "")
        files.append((fname, render(f.read_text(encoding="utf-8"), label)))
    html = (f"<div style='font:15px/1.55 -apple-system,Segoe UI,Arial,sans-serif'><h2>Threads tracker: {len(files)} new report(s)</h2>"
            f"<ul>{''.join(rows)}</ul><p>The reports are attached (open them in a browser; Print → Save as PDF if needed).<br>"
            f"All reports are also on the site: <a href='{SITE}'>{SITE}</a></p></div>")
    user, pwd, to = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASSWORD"), os.environ.get("MAIL_TO")
    if not (user and pwd and to):
        print(f"Email not configured (SMTP_USER, SMTP_PASSWORD, MAIL_TO). Would send {len(files)} report(s):")
        for n, _ in files:
            print(" -", n)
        return 0
    msg = EmailMessage()
    msg["Subject"] = f"Threads tracker digest - {len(files)} report(s) - {a.since[:10]}"
    msg["From"], msg["To"] = user, to
    msg.set_content("Your Threads tracker reports are attached. Open them in a browser.")
    msg.add_alternative(html, subtype="html")
    for n, content in files:
        msg.add_attachment(content.encode("utf-8"), maintype="text", subtype="html", filename=n)
    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    with smtplib.SMTP_SSL(host, int(os.environ.get("SMTP_PORT", "465"))) as s:
        s.login(user, pwd)
        s.send_message(msg)
    print(f"Sent {len(files)} report(s) to {to}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
