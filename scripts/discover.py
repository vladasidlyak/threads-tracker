#!/usr/bin/env python3
"""
Find competitors for a target account.

  python scripts/discover.py --handle https://www.threads.com/@quintanilla_iness [--min-followers 5000]
                             [--keywords "amor propio, ansiedad"] [--count 10] [--dry-run]

Steps
  1. Read the target account (bio + latest posts) with Apify.
  2. Claude picks search terms and the language (unless --keywords is given).
  3. Search Threads for accounts on those terms.
  4. Drop the target, private and small accounts, and accounts in another language.
  5. Look up the best ~25 candidates' latest 10 posts (one Apify item each).
  6. Score: topic similarity to the target, engagement rate, recent activity.
  7. Claude picks the final list and writes one line on why each is a useful benchmark.
Saves data/competitors/<target>.json and lists it in data/index.json.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import shutil
import statistics
import sys
import tempfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tracker as T  # noqa: E402

STOP = set("""de la que el en y a los se del las un por con no una su para es al lo como más pero sus le ya o este
sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni
contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes
nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas vosotros os ser es soy eres
son era fue tiene tener puede cada vez solo sólo ha han he has había así siempre nunca the a an and or but of to in on
at for with is are was were be been it this that you your i my me we our they them he she his her not do have has had
so if as by from what when who how all just can will would there their than then into about more one also very too
visita web pide consulta link aquí bio enlace""".split())
PT = re.compile(r"\b(você|voce|não|nao|sua|seu|uma|com|mais|ajudo|são|atendimento|também|para você|mulheres|relacionamentos?)\b|ção\b|ções\b|ã", re.I)
ES = re.compile(r"\b(tú|tu|te|ti|ayudo|con|una|más|que|el|los|las|mujeres|relaciones|terapia|para ti)\b|ñ|¿|¡", re.I)
EN = re.compile(r"\b(you|your|the|and|help|therapy|with|my|for|women|relationships)\b", re.I)


def lang_of(text: str) -> str:
    s = {"es": len(ES.findall(text)), "pt": len(PT.findall(text)), "en": len(EN.findall(text))}
    best = max(s, key=s.get)
    return best if s[best] else "unknown"


def terms(text: str) -> Counter:
    return Counter(w for w in re.findall(r"[a-záéíóúñüàâãçêõ]{4,}", text.lower()) if w not in STOP)


def cosine(a: Counter, b: Counter) -> float:
    common = set(a) & set(b)
    num = sum(a[w] * b[w] for w in common)
    den = math.sqrt(sum(v * v for v in a.values())) * math.sqrt(sum(v * v for v in b.values()))
    return num / den if den else 0.0


def post_eng(p: dict) -> int:
    return sum(T.num(p.get(k)) for k in ("likeCount", "replyCount", "repostCount", "quoteCount"))


def days_since(iso: str | None) -> float:
    if not iso:
        return 9999
    try:
        d = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return 9999
    return (dt.datetime.now(dt.timezone.utc) - d).total_seconds() / 86400


def parse_json(text: str):
    """Read the first JSON object or list in Claude's answer, ignoring any text around it."""
    dec = json.JSONDecoder()
    for i, ch in enumerate(text):
        if ch in "{[":
            try:
                return dec.raw_decode(text[i:])[0]
            except json.JSONDecodeError:
                continue
    raise T.TrackerError("Claude didn't return the expected list. Try again.")


def parse_picks(text: str) -> list[dict]:
    """Collect every complete {...} object that has a handle, even if the list itself was cut off."""
    dec, out, i = json.JSONDecoder(), [], 0
    try:
        whole = parse_json(text)
        if isinstance(whole, list) and len(whole) > 1:
            return whole
        if isinstance(whole, dict) and any(isinstance(v, list) and len(v) > 1 for v in whole.values()):
            return whole
    except T.TrackerError:
        pass
    while True:
        i = text.find("{", i)
        if i < 0:
            return out
        try:
            obj, end = dec.raw_decode(text[i:])
            if isinstance(obj, dict) and (obj.get("handle") or obj.get("username")):
                out.append(obj)
            i += max(end, 1)
        except json.JSONDecodeError:
            i += 1


def normalize_picks(raw) -> list[dict]:
    """Accept whatever shape Claude returned: a list of objects, a list of handles, or {"anything": [...]}."""
    if isinstance(raw, dict):
        lists = [v for v in raw.values() if isinstance(v, list)]
        raw = lists[0] if lists else [raw]
    out = []
    for p in raw if isinstance(raw, list) else []:
        if isinstance(p, str):
            out.append({"handle": p, "reason": ""})
        elif isinstance(p, dict):
            h = p.get("handle") or p.get("username") or p.get("account") or ""
            out.append({"handle": str(h), "reason": str(p.get("reason") or p.get("why") or ""),
                        "best_post_en": str(p.get("best_post_en") or ""), "bio_en": str(p.get("bio_en") or "")})
    return out


def discover(paths: T.Paths, settings: dict, apify: T.Apify, handle: str, min_followers: int,
             keywords: list[str], count: int, dry_run: bool, requested_by: str = "") -> Path:
    T.log(f"\n=== Finding competitors for @{handle} ===")
    actor_profile, actor_search = settings["apify_profile_actor"], settings["apify_comments_actor"]
    cap = settings["max_cost_usd_per_run"]

    # 1. target
    rows = apify.run(actor_profile, {"usernames": [handle], "profileContent": ["profile", "posts"], "maxItemsPerInput": 20,
                                     "includeViewCounts": False, "proxyConfiguration": {"useApifyProxy": True}},
                     cap, "profile_run.json")
    prof = next((r for r in rows if r.get("dataType") == "profile"), {}) or {}
    target_posts = [r.get("text") or "" for r in rows if r.get("dataType") != "profile" and not r.get("isReply")]
    target_posts += [p.get("text") or "" for p in (prof.get("latestPosts") or [])]
    target_text = (prof.get("bio") or "") + "\n" + "\n".join(target_posts)
    if len(target_text.strip()) < 40:
        raise T.TrackerError(f"Couldn't read enough of @{handle} to understand it. Is the profile public?")
    target_terms = terms(target_text)
    target_followers = T.num(prof.get("followerCount"))
    T.log(f"Target: {len(target_posts)} posts read, {target_followers} followers")

    # 2. keywords + language
    if keywords:
        lang = lang_of(target_text)
    elif dry_run:
        k = T.read_json(T.FIXTURES / "keywords.json")
        lang, keywords = k["language"], k["keywords"]
    else:
        prompt = ("Here is a Threads account's bio and recent posts.\n\n" + target_text[:6000] +
                  "\n\nReturn JSON only: {\"language\": two-letter code of the language it writes in, "
                  "\"keywords\": 6 short search terms (1-2 words, in that language) that people in the same niche "
                  "would have in their name or bio - mix the profession (e.g. psicóloga) with the main topics}.")
        k = parse_json(T.ask_claude(prompt, {**settings, "claude_max_tokens": 400}, False))
        lang, keywords = k.get("language", lang_of(target_text)), [str(x) for x in k.get("keywords", [])][:8]
    T.log(f"Language: {lang}. Search terms: {', '.join(keywords)}")

    # 3. search
    search_lang = lang if lang in ("en", "es", "pt", "fr", "de", "it", "ja", "ko", "zh", "hi", "id", "tr") else "any"
    found = apify.run(actor_search, {"searchQueries": keywords, "searchType": "profiles", "searchLanguage": search_lang,
                                     "maxItemsPerInput": 30, "proxyConfiguration": {"useApifyProxy": True}},
                      cap, "search_run.json")
    cands: dict[str, dict] = {}
    for r in found:
        u = (r.get("username") or "").lower()
        if not u or u == handle:
            continue
        c = cands.setdefault(u, {"handle": u, "fullName": r.get("fullName") or "", "bio": r.get("bio") or "",
                                 "followers": T.num(r.get("followerCount")), "verified": bool(r.get("isVerified")),
                                 "private": bool(r.get("isPrivate")), "terms": set()})
        c["terms"].add(r.get("searchQuery") or "")
    T.log(f"Search found {len(cands)} accounts")

    # 4. filter
    tracked = {a["handle"] for a in T.read_json(paths.config / "accounts.json", {"accounts": []})["accounts"]}
    kept = []
    for c in cands.values():
        why = None
        if c["private"]:
            why = "private"
        elif c["followers"] < min_followers:
            why = "small"
        else:
            bl = lang_of(c["fullName"] + " " + c["bio"])
            if lang in ("es", "pt", "en") and bl not in (lang, "unknown"):
                why = f"language {bl}"
        if not why:
            kept.append(c)
    T.log(f"After filters: {len(kept)} (min {min_followers} followers, language {lang})")
    if not kept:
        raise T.TrackerError("No accounts passed the filters. Lower the minimum followers or add your own search terms.")
    pre = sorted(kept, key=lambda c: (len(c["terms"]) + cosine(target_terms, terms(c["fullName"] + " " + c["bio"])) * 3,
                                      math.log10(c["followers"] + 10)), reverse=True)[:25]

    # 5. latest posts of the shortlist
    looked = apify.run(actor_profile, {"usernames": [c["handle"] for c in pre], "profileContent": ["profile"],
                                       "maxItemsPerInput": 10, "proxyConfiguration": {"useApifyProxy": True}},
                       cap, "candidates_run.json")
    latest = {(r.get("username") or "").lower(): r for r in looked if r.get("dataType") == "profile"}

    # 6. score
    scored = []
    for c in pre:
        r = latest.get(c["handle"], {})
        posts = [p for p in (r.get("latestPosts") or []) if p]
        engs = [post_eng(p) for p in posts]
        last = min((days_since(p.get("createdAt")) for p in posts), default=9999)
        recent = sum(1 for p in posts if days_since(p.get("createdAt")) <= 30)
        followers = T.num(r.get("followerCount")) or c["followers"]
        text = c["bio"] + "\n" + "\n".join(p.get("text") or "" for p in posts)
        sim = cosine(target_terms, terms(text))
        med = statistics.median(engs) if engs else 0
        er = med / followers * 100 if followers else 0
        best = max(posts, key=post_eng) if posts else None
        scored.append({
            "handle": c["handle"], "fullName": c["fullName"], "bio": c["bio"][:300], "verified": c["verified"],
            "followers": followers, "similarity": round(sim, 3), "medianEngagement": round(med),
            "engagementRate": round(er, 3), "postsLast30d": recent, "daysSinceLastPost": round(last) if last < 9999 else None,
            "matchedTerms": sorted(t for t in c["terms"] if t), "alreadyTracked": c["handle"] in tracked,
            "topPost": {"text": (best.get("text") or "")[:280], "engagement": post_eng(best), "url": best.get("url") or ""} if best else None,
        })
    if not scored:
        raise T.TrackerError("Couldn't read any candidate profiles.")
    maxsim = max(s["similarity"] for s in scored) or 1
    ers = sorted(s["engagementRate"] for s in scored)
    for s in scored:
        er_rank = ers.index(s["engagementRate"]) / max(1, len(ers) - 1)
        active = 1.0 if (s["daysSinceLastPost"] or 9999) <= 30 else 0.4 if (s["daysSinceLastPost"] or 9999) <= 90 else 0.0
        s["score"] = round(100 * (0.45 * s["similarity"] / maxsim + 0.35 * er_rank + 0.20 * active) * (0.25 if active == 0 else 1))
        s["active"] = active >= 1.0
    scored.sort(key=lambda s: s["score"], reverse=True)

    # 7. final pick with reasons
    pool = scored[:max(count + 5, 15)]
    if dry_run:
        picks = [{"handle": s["handle"], "reason": "(dry run) high score"} for s in pool[:count]]
    else:
        lines = "\n".join(
            f"- @{s['handle']} | {s['followers']} followers | eng. rate {s['engagementRate']}% | median eng. {s['medianEngagement']} | "
            f"last post {s['daysSinceLastPost']} days ago | {s['postsLast30d']} posts in 30 days | similarity {s['similarity']} | "
            f"bio: {T.squash(s['bio'])[:160]} | best recent post: {T.squash((s['topPost'] or {}).get('text', ''))[:160]}"
            for s in pool)
        prompt = (f"We want benchmark competitors on Threads for @{handle}.\nAbout @{handle}:\n{target_text[:2500]}\n\n"
                  f"Candidates:\n{lines}\n\nPick the {count} most useful benchmarks: same niche and audience, active, "
                  "and good engagement for their size. Skip brands, clinics, aggregators and accounts in another language "
                  "unless nothing better exists. Return JSON only: [{\"handle\": \"...\", \"reason\": \"one sentence in "
                  "English on why it's a good benchmark and what to learn from it\", \"best_post_en\": \"English translation "
                  "of their best recent post shown above (empty if it is already English)\", \"bio_en\": \"English translation of "
                  "the bio (empty if English)\"}]. Use hyphens, never em dashes.")
        try:
            picks = parse_picks(T.ask_claude(prompt, {**settings, "claude_max_tokens": 4000}, False))
        except T.TrackerError as e:
            if "budget" in str(e):
                raise
            T.log(f"Couldn't read Claude's picks ({e}); using the score ranking instead.")
            picks = []
    picks = normalize_picks(picks)
    by = {s["handle"]: s for s in scored}
    final = []
    for p in picks:
        h = str(p.get("handle", "")).lstrip("@").lower()
        if h in by and h not in {f["handle"] for f in final}:
            item = {**by[h], "reason": str(p.get("reason", "")).replace("—", " - "), "bioEn": p.get("bio_en", "")}
            if item.get("topPost") and p.get("best_post_en"):
                item["topPost"] = {**item["topPost"], "textEn": p["best_post_en"]}
            final.append(item)
    for s in scored:  # top up if Claude returned fewer
        if len(final) >= count:
            break
        if s["handle"] not in {f["handle"] for f in final}:
            final.append({**s, "reason": ""})
    others = [s for s in scored if s["handle"] not in {f["handle"] for f in final}][:15]

    out = {"target": handle, "targetFollowers": target_followers, "language": lang, "keywords": keywords,
           "minFollowers": min_followers, "created": T.now_iso(), "requestedBy": requested_by[:120],
           "competitors": final[:count], "others": others,
           "stats": {"found": len(cands), "afterFilters": len(kept), "lookedUp": len(pre)}}
    rel = f"data/competitors/{handle}.json"
    T.write_json(paths.root / rel, out)
    idx_path = paths.data / "competitors" / "index.json"
    idx = [e for e in T.read_json(idx_path, []) if e["target"] != handle]
    idx.insert(0, {"target": handle, "path": rel, "created": out["created"], "count": len(out["competitors"])})
    T.write_json(idx_path, idx)
    T.log("Top competitors: " + ", ".join(f"@{c['handle']}" for c in out["competitors"]))
    T.log(f"Saved: {rel}")
    return paths.root / rel


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Find competitors for a Threads account")
    ap.add_argument("--handle", required=True)
    ap.add_argument("--min-followers", type=int, default=5000)
    ap.add_argument("--keywords", default="", help="comma-separated search terms (optional)")
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--requested-by", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    root = T.ROOT
    if a.dry_run:
        root = Path(tempfile.mkdtemp(prefix="discover-dry-"))
        for d in ("data", "reports"):
            if (T.ROOT / d).exists():
                shutil.copytree(T.ROOT / d, root / d)
        T.log(f"[dry run] working in {root}")
    paths = T.Paths(root)
    settings = T.read_json(paths.config / "settings.json")
    T.setup_budget(paths, settings, a.dry_run)
    try:
        import os
        apify = T.Apify(os.environ.get("APIFY_TOKEN"), a.dry_run)
        kws = [k.strip() for k in a.keywords.split(",") if k.strip()]
        discover(paths, settings, apify, T.clean_handle(a.handle), a.min_followers, kws, a.count, a.dry_run, a.requested_by)
        T.update_index(paths)
        return 0
    except T.TrackerError as e:
        T.log(f"\nERROR: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
