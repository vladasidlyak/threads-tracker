/* Threads Competitor Tracker - Voice tab: linguistic analysis computed in the browser.
   Loaded after dashboard.js; uses window.TT (data + helpers) exposed there. */
(function () {
"use strict";
const TT = window.TT; if (!TT) return;
const { $, esc, fmt, eng, median } = TT;

const STOP = new Set(("de la que el en y a los se del las un por con no una su para es al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros os mío mía tuyo tuya suyo suya nuestro nuestra vuestro esos esas estoy estás está estamos están ser es soy eres son era fue sido tiene tener tienes tengo hace hacer puede puedes cada vez solo sólo ha han he has había y o u si así siempre nunca the a an and or but of to in on at for with is are was were be been it this that you your i my me we our they them he she his her not do does did have has had so if as by from what when who how all just can will would there their than then into about up out more one also very too").split(" "));
const ES_HINT = /\b(que|de|la|el|los|las|una|por|con|para|es|tu|te|ti|pero|muy|cuando)\b/gi;
const EN_HINT = /\b(the|and|you|your|is|are|to|of|that|with|for|this|it|when)\b/gi;
const EMOJI = /(\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|‍|[\u{1F3FB}-\u{1F3FF}])*|♡)/gu;
const EMOJI1 = new RegExp(EMOJI.source, "u");
const PRON = {
  "You (tú / you)": /\b(tú|tu|tus|te|ti|contigo|usted|you|your|yours|yourself)\b/i,
  "I (yo / I)": /\b(yo|me|mi|mis|conmigo|i|me|my|mine|myself)\b/i,
  "We (nosotros / we)": /\b(nosotros|nosotras|nos|nuestro|nuestra|nuestros|nuestras|we|us|our|ours)\b/i,
  "They / people": /\b(personas|gente|alguien|ellos|ellas|they|them|people|someone)\b/i
};

function sentences(t) {
  return t.split(/(?<=[.!?…])\s+|\n+/).map(s => s.trim()).filter(s => /\p{L}/u.test(s));
}
function words(t) { return (t.match(/[\p{L}\p{N}'’]+/gu) || []); }

function features(t) {
  const sents = sentences(t);
  return {
    "Question mark": /[?¿]/.test(t),
    "Exclamation": /[!¡]/.test(t),
    "Ellipsis …": /…|\.\.\./.test(t),
    "Quotation marks": /[“”"«»]/.test(t),
    "Colon :": /\p{L}\s?:\s/u.test(t) || /:\s*\n/.test(t),
    "Dash -": /\s[-–—]\s/.test(t),
    "Line breaks": /\n/.test(t),
    "CAPS for emphasis": /\b\p{Lu}{2,}\b/u.test(t.replace(/\b(TV|OK|DM|PDF|USA|UK|RAE|JJOO|AI)\b/g, "")),
    "Emoji": EMOJI1.test(t),
    "One sentence only": sents.length === 1,
    "Under 100 characters": t.length < 100,
    "Speaks to 'you'": PRON["You (tú / you)"].test(t),
    "Speaks as 'I'": PRON["I (yo / I)"].test(t),
    "Link": /https?:\/\//.test(t),
    "Hashtag": /(^|\s)#\p{L}/u.test(t)
  };
}

function analyze(list) {
  const items = list.filter(p => (p.text || "").trim());
  const n = items.length;
  if (!n) return null;
  const out = { n };
  const chars = items.map(p => p.text.length), wcount = items.map(p => words(p.text).length);
  const sentLens = [], perPost = [];
  items.forEach(p => { const s = sentences(p.text); perPost.push(s.length); s.forEach(x => sentLens.push(words(x).length)); });
  out.medChars = median(chars); out.medWords = median(wcount);
  out.avgSent = sentLens.length ? sentLens.reduce((a, b) => a + b, 0) / sentLens.length : 0;
  out.medSentPerPost = median(perPost);
  const allW = items.flatMap(p => words(p.text));
  out.avgWordLen = allW.length ? allW.reduce((a, w) => a + w.length, 0) / allW.length : 0;
  const txt = items.map(p => p.text).join("\n");
  const es = (txt.match(ES_HINT) || []).length, en = (txt.match(EN_HINT) || []).length;
  out.lang = es > en * 1.5 ? "Spanish" : en > es * 1.5 ? "English" : "Mixed";
  // features: share + engagement lift
  const feats = items.map(p => ({ p, f: features(p.text) }));
  const names = Object.keys(feats[0].f);
  out.features = names.map(k => {
    const yes = feats.filter(x => x.f[k]).map(x => eng(x.p)), no = feats.filter(x => !x.f[k]).map(x => eng(x.p));
    const my = median(yes), mn = median(no);
    return { k, share: yes.length / n, nYes: yes.length, nNo: no.length, medYes: my, medNo: mn, lift: yes.length >= 3 && no.length >= 3 && mn ? (my - mn) / mn : null };
  });
  // emojis
  const ec = {}; let withE = 0, endE = 0, totalE = 0;
  items.forEach(p => { const m = p.text.match(EMOJI) || []; if (m.length) { withE++; if (EMOJI1.test(p.text.trim().slice(-4))) endE++; } m.forEach(e => { ec[e] = (ec[e] || 0) + 1; totalE++; }); });
  out.emojiShare = withE / n; out.emojiPerPost = totalE / n; out.emojiEnd = withE ? endE / withE : 0;
  out.topEmoji = Object.entries(ec).sort((a, b) => b[1] - a[1]).slice(0, 10);
  // pronouns
  out.pron = Object.entries(PRON).map(([k, re]) => ({ k, share: items.filter(p => re.test(p.text)).length / n }));
  // openings
  const op = {};
  items.forEach(p => { const w = words(p.text).slice(0, 2).map(x => x.toLowerCase()).join(" "); if (!w) return; (op[w] = op[w] || []).push(eng(p)); });
  out.openings = Object.entries(op).filter(([, v]) => v.length >= 2).map(([k, v]) => ({ k, n: v.length, med: median(v) })).sort((a, b) => b.n - a.n || b.med - a.med).slice(0, 8);
  // favourite words
  const wc = {};
  allW.forEach(w => { const l = w.toLowerCase(); if (l.length < 4 || STOP.has(l) || /^\d+$/.test(l)) return; wc[l] = (wc[l] || 0) + 1; });
  out.words = Object.entries(wc).sort((a, b) => b[1] - a[1]).slice(0, 18);
  // examples: shortest top performers
  out.examples = [...items].sort((a, b) => eng(b) - eng(a)).slice(0, 3);
  return out;
}

function pctBars(rows) {
  const max = Math.max(...rows.map(r => r.v), 0.01);
  return '<div class="bars">' + rows.map(r => `<div class="bar-row" title="${esc(r.k)}: ${Math.round(r.v * 100)}%"><span class="lab">${esc(r.k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, r.v / max * 100)}%"></div></div><span class="val">${Math.round(r.v * 100)}%</span></div>`).join("") + "</div>";
}
function tile(k, v, h) { return `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="h">${h || ""}</div></div>`; }

function render() {
  const acc = $("#vAccount").value, src = $("#vSource").value;
  const list = TT.allPosts().filter(p => p.type === src && (!acc || p.account === acc));
  const a = analyze(list), box = $("#vBody");
  if (!a) { box.innerHTML = '<div class="card empty">No text to analyze for this selection.</div>'; return; }
  const feats = [...a.features].sort((x, y) => y.share - x.share);
  const lifts = a.features.filter(f => f.lift != null).sort((x, y) => y.lift - x.lift);
  const unit = src === "post" ? "posts" : "replies";
  box.innerHTML = `
  <div class="grid g4" style="margin-bottom:16px">
    ${tile("Language", a.lang, a.n + " " + unit + " with text")}
    ${tile("Median length", a.medChars + " chars", Math.round(a.medWords) + " words")}
    ${tile("Avg sentence", a.avgSent.toFixed(1) + " words", "median " + a.medSentPerPost + " sentence(s) per " + unit.slice(0, -1).replace("replie", "reply"))}
    ${tile("Emoji use", Math.round(a.emojiShare * 100) + "%", a.emojiShare ? Math.round(a.emojiEnd * 100) + "% of those end with the emoji" : "of " + unit)}
  </div>
  <div class="grid g2">
    <div class="card"><h2>Punctuation and style</h2><p class="sub">Share of ${unit} that use each device</p>${pctBars(feats.filter(f => !["Under 100 characters", "Speaks to 'you'", "Speaks as 'I'"].includes(f.k)).map(f => ({ k: f.k, v: f.share })))}</div>
    <div class="card"><h2>Who they talk to</h2><p class="sub">Share of ${unit} using each kind of pronoun</p>${pctBars(a.pron.map(p => ({ k: p.k, v: p.share })))}
      <h2 style="margin-top:18px">Emojis</h2><p class="sub">${a.emojiPerPost.toFixed(2)} per ${unit.slice(0, -1).replace("replie", "reply")} on average</p>
      <div class="chips">${a.topEmoji.length ? a.topEmoji.map(([e, c]) => `<span class="chip" style="padding:5px 12px">${esc(e)} <span class="muted small">${c}</span></span>`).join("") : '<span class="muted small">No emojis.</span>'}</div>
    </div>
  </div>
  <div class="card"><h2>What drives engagement</h2><p class="sub">Median engagement of ${unit} with each device vs without it. Shown when both groups have 3+ ${unit}. Patterns, not proof.</p>
    ${lifts.length ? `<div class="scroll"><table><tr><th>Device</th><th class="n">Used in</th><th class="n">With</th><th class="n">Without</th><th class="n">Difference</th></tr>${lifts.map(f => `<tr><td>${esc(f.k)}</td><td class="n">${f.nYes}</td><td class="n">${fmt(Math.round(f.medYes))}</td><td class="n">${fmt(Math.round(f.medNo))}</td><td class="n"><b>${f.lift >= 0 ? "▲ +" : "▼ "}${Math.round(f.lift * 100)}%</b></td></tr>`).join("")}</table></div>` : '<p class="muted small">Not enough data to compare.</p>'}
  </div>
  <div class="grid g2">
    <div class="card"><h2>How ${unit} open</h2><p class="sub">First two words used 2+ times</p>
      ${a.openings.length ? `<table><tr><th>Opening</th><th class="n">Times</th><th class="n">Median eng.</th></tr>${a.openings.map(o => `<tr><td>“${esc(o.k)}…”</td><td class="n">${o.n}</td><td class="n">${fmt(Math.round(o.med))}</td></tr>`).join("")}</table>` : '<p class="muted small">No repeated openings.</p>'}</div>
    <div class="card"><h2>Favourite words</h2><p class="sub">Most used words, without filler words</p>
      <div class="chips">${a.words.map(([w, c]) => `<span class="chip" style="padding:5px 12px">${esc(w)} <span class="muted small">${c}</span></span>`).join("")}</div></div>
  </div>
  <div class="card"><h2>Key takeaways</h2><p class="sub">Calculated from the numbers above.</p><ul style="margin:0;padding-left:20px">${takeaways(a, lifts, unit).map(t => `<li style="margin:4px 0">${t}</li>`).join("")}</ul>
</div>
  <div class="card" id="vAi"><div class="row" style="justify-content:space-between"><h2 style="margin:0">AI linguistic report</h2><button class="btn primary" id="vGuide" type="button">Generate a new one</button></div>
    <p class="sub">Claude's written analysis of tone, sentence patterns, punctuation, emojis, vocabulary, openings and closings, plus do / don't rules and rewrites for your brand. A few cents, no Apify cost.</p>
    <div class="md" id="vAiBody"><p class="muted small">Loading...</p></div></div>
  ${compare(src)}`;
  $("#vGuide").onclick = () => {
    const h = acc || Object.keys(TT.S.accounts)[0];
    TT.prefillRun(h, "voice", true);
    $("#runCard").scrollIntoView({ behavior: "smooth" });
    $("#runStatus").textContent = "Ready: AI linguistic report for @" + h + " from saved data. Check the brand and click Run.";
  };
  loadAi(acc);
}

let aiToken = 0;
async function loadAi(acc) {
  const my = ++aiToken, body = $("#vAiBody");
  const reps = ((TT.S.index && TT.S.index.reports) || []).filter(r => r.focus === "voice" && (!acc || r.accounts.includes(acc)));
  if (!reps.length) { body.innerHTML = `<p class="muted small">No AI linguistic report ${acc ? "for @" + esc(acc) + " " : ""}yet. Click <b>Generate a new one</b>.</p>`; return; }
  const r = reps[0];
  try {
    const t = await (await fetch(r.path + "?v=" + Date.now())).text();
    if (my !== aiToken) return;
    body.innerHTML = `<p class="small muted">${r.accounts.map(a => "@" + esc(a)).join(", ")} · for ${esc(r.brand)} · ${new Date(r.created).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}${reps.length > 1 ? ` · ${reps.length - 1} older in AI reports` : ""}</p>` + TT.md(t.replace(/^# .*\n+.*\n+/, ""));
  } catch (e) { body.innerHTML = '<p class="muted small">Couldn\'t load the report.</p>'; }
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function takeaways(a, lifts, unit) {
  const t = [];
  t.push(`Writes in ${a.lang === "Mixed" ? "a mix of languages" : a.lang}, with ${unit} of about ${a.medWords} words and sentences of about ${a.avgSent.toFixed(0)} words. ${a.avgSent < 12 ? "Short, punchy sentences." : a.avgSent < 20 ? "Medium-length, conversational sentences." : "Long, explanatory sentences."}`);
  const you = a.pron[0].share, me = a.pron[1].share;
  t.push(you > me ? `Speaks to the reader far more than about themselves (${Math.round(you * 100)}% "you" vs ${Math.round(me * 100)}% "I").` : `Uses a first-person voice (${Math.round(me * 100)}% "I" vs ${Math.round(you * 100)}% "you").`);
  if (a.emojiShare > 0) t.push(`Emoji in ${Math.round(a.emojiShare * 100)}% of ${unit}${a.topEmoji.length ? ", mostly " + a.topEmoji.slice(0, 3).map(e => e[0]).join(" ") : ""}${a.emojiEnd > 0.6 ? ", usually as a sign-off at the end" : ""}.`);
  else t.push("No emojis at all - the words carry the tone.");
  const best = lifts.filter(f => f.lift > 0.15).slice(0, 2), worst = lifts.filter(f => f.lift < -0.15).slice(-2).reverse();
  best.forEach(f => t.push(`${cap(unit)} with <b>${esc(f.k.toLowerCase())}</b> get ${Math.round(f.lift * 100)}% more engagement (median ${fmt(Math.round(f.medYes))} vs ${fmt(Math.round(f.medNo))}).`));
  worst.forEach(f => t.push(`${cap(unit)} with <b>${esc(f.k.toLowerCase())}</b> get ${Math.abs(Math.round(f.lift * 100))}% less engagement - use with care.`));
  if (a.openings[0]) t.push(`Signature opening: “${esc(a.openings[0].k)}…” (${a.openings[0].n} times).`);
  return t;
}

function compare(src) {
  const accs = Object.keys(TT.S.accounts);
  if (accs.length < 2) return "";
  const rows = accs.map(h => ({ h, a: analyze(TT.allPosts().filter(p => p.type === src && p.account === h)) })).filter(r => r.a);
  const f = (a, k) => Math.round((a.features.find(x => x.k === k) || { share: 0 }).share * 100) + "%";
  return `<div class="card"><h2>Compare voices</h2><div class="scroll"><table><tr><th>Account</th><th>Language</th><th class="n">Words</th><th class="n">Sentence</th><th class="n">Emoji</th><th class="n">Questions</th><th class="n">Line breaks</th><th class="n">"You"</th><th>Top emojis</th></tr>${rows.map(({ h, a }) => `<tr><td>@${esc(h)}</td><td>${a.lang}</td><td class="n">${a.medWords}</td><td class="n">${a.avgSent.toFixed(1)}</td><td class="n">${Math.round(a.emojiShare * 100)}%</td><td class="n">${f(a, "Question mark")}</td><td class="n">${f(a, "Line breaks")}</td><td class="n">${Math.round(a.pron[0].share * 100)}%</td><td>${a.topEmoji.slice(0, 3).map(e => esc(e[0])).join(" ")}</td></tr>`).join("")}</table></div></div>`;
}

function fill() {
  const el = $("#vAccount"), cur = el.value, accs = Object.keys(TT.S.accounts).sort();
  el.innerHTML = '<option value="">All accounts</option>' + accs.map(a => `<option value="${esc(a)}">@${esc(a)}</option>`).join("");
  if (accs.includes(cur)) el.value = cur; else if (accs.length === 1) el.value = accs[0];
}
$("#vAccount").onchange = render; $("#vSource").onchange = render;
TT.onData(() => { fill(); render(); });
})();
