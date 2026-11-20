/* Threads Competitor Tracker - dashboard (vanilla JS, no dependencies).
   Reads data/index.json, data/accounts/<handle>.json and reports/*.md from this repository. */
(function () {
"use strict";
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = n => { n = Number(n) || 0; return n >= 10000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k" : n.toLocaleString("en-US"); };
const DAYS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const S = { index: null, accounts: {}, pLimit: 30, rLimit: 30 };

/* ---------- link to the GitHub "Get report" workflow ---------- */
function repoUrl() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}` : null;
}

/* ---------- helpers ---------- */
const eng = p => (p.likes || 0) + (p.replies || 0) + (p.reposts || 0) + (p.quotes || 0);
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function formatOf(t) {
  t = (t || "").trim();
  if (/^\s*["“«]/.test(t) || /\n\s*[-–—]\s*[A-ZÁÉÍÓÚÑ][^\n]{1,40}$/.test(t)) return "Quote";
  if (t.split("\n").filter(l => /^\s*(\d+[.)]|[-•*–])\s/.test(l)).length >= 2) return "List";
  const first = (t.split(/[.!\n]/)[0] || "");
  if (/[?¿]/.test(first) || /\?$/.test(t)) return "Question";
  if (/https?:\/\//.test(t)) return "With link";
  if (/^(i |yo |me |mi |my |when i|cuando )/i.test(t)) return "Personal story";
  return "Statement";
}
const lenOf = t => { const n = (t || "").length; return n < 100 ? "< 100" : n < 250 ? "100-250" : n < 500 ? "250-500" : "500+"; };
const FMT_ORDER = ["Quote","Question","List","Personal story","Statement","With link"];
const LEN_ORDER = ["< 100","100-250","250-500","500+"];
const HOURS = [["Night 0-6",0,6],["Morning 6-12",6,12],["Afternoon 12-18",12,18],["Evening 18-24",18,24]];
const dayOf = d => DAYS[(new Date(d).getDay() + 6) % 7];
function groupBy(list, fn) { const g = {}; list.forEach(p => { const k = fn(p); if (k == null) return; (g[k] = g[k] || []).push(p); }); return g; }
async function getJSON(path) { const r = await fetch(path + "?v=" + Date.now()); if (!r.ok) throw new Error(path + " " + r.status); return r.json(); }

/* ---------- data ---------- */
function allPosts() { return Object.values(S.accounts).flatMap(a => Object.values(a.posts || {})); }
function filtered(acc, range, type) {
  const now = Date.now();
  return allPosts().filter(p => (!type || p.type === type) && (!acc || p.account === acc) && (!+range || (p.date && now - new Date(p.date) < +range * 864e5)));
}
function followersOf(acc) {
  const list = acc ? [S.accounts[acc]] : Object.values(S.accounts);
  return list.reduce((s, a) => s + ((a && a.profile && a.profile.followers) || 0), 0);
}

/* ---------- charts ---------- */
const tip = $("#tip");
function showTip(e, html) { tip.innerHTML = html; tip.style.opacity = 1; tip.style.left = Math.min(e.clientX + 12, innerWidth - 250) + "px"; tip.style.top = (e.clientY + 14) + "px"; }
function hideTip() { tip.style.opacity = 0; }
function barChart(el, groups, order, val = eng, vf = n => fmt(Math.round(n))) {
  const keys = order.filter(k => groups[k] && groups[k].length);
  if (!keys.length) { el.innerHTML = '<p class="muted small">Not enough data.</p>'; return; }
  const rows = keys.map(k => { const a = groups[k].map(val); return { k, avg: a.reduce((x, y) => x + y, 0) / a.length, n: a.length, med: median(a) }; });
  const max = Math.max(...rows.map(r => r.avg), 1);
  el.innerHTML = '<div class="bars" role="img" aria-label="Average engagement by group">' + rows.map(r =>
    `<div class="bar-row" data-t="<b>${esc(r.k)}</b><br>Avg ${vf(r.avg)} · median ${vf(r.med)}<br>${r.n} post${r.n > 1 ? "s" : ""}"><span class="lab">${esc(r.k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, r.avg / max * 100)}%"></div></div><span class="val">${vf(r.avg)}</span></div>`).join("") + "</div>" +
    `<details class="tbl"><summary>Show as table</summary><table><tr><th>Group</th><th class="n">Posts</th><th class="n">Avg</th><th class="n">Median</th></tr>${rows.map(r => `<tr><td>${esc(r.k)}</td><td class="n">${r.n}</td><td class="n">${vf(r.avg)}</td><td class="n">${vf(r.med)}</td></tr>`).join("")}</table></details>`;
  el.querySelectorAll(".bar-row").forEach(b => { b.addEventListener("mousemove", e => showTip(e, b.dataset.t)); b.addEventListener("mouseleave", hideTip); });
}

/* ---------- render ---------- */
function postHTML(p, showParent) {
  const d = p.date ? new Date(p.date) : null;
  return `<div class="post">
    <div class="meta"><b>@${esc(p.account)}</b><span>${d ? d.toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric"}) + " " + d.toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit"}) : "no date"}</span><span class="tag">${esc(p.type === "reply" ? "reply" : formatOf(p.text))}</span>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">open</a>` : ""}</div>
    ${showParent && (p.parentText || p.parentAuthor) ? `<div class="parent">${p.parentAuthor ? "<b>@" + esc(p.parentAuthor) + "</b>: " : ""}${esc(p.parentText || "(original text not available)")}</div>` : ""}
    <div class="txt">${esc(p.text) || '<span class="muted">(image or video without text)</span>'}</div>
    <div class="stats"><span>♥ ${fmt(p.likes)}</span><span>💬 ${fmt(p.replies)}</span><span>↻ ${fmt(p.reposts)}</span>${p.quotes ? `<span>❝ ${fmt(p.quotes)}</span>` : ""}${p.views ? `<span>👁 ${fmt(p.views)}</span>` : ""}${p.shares ? `<span>➤ ${fmt(p.shares)}</span>` : ""}<span><b>${fmt(eng(p))}</b> total</span></div>
  </div>`;
}
function fillOvAccounts() {
  const br = $("#ovBrand").value, el = $("#ovAccount"), cur = el.value;
  const meta = h => (S.index.accounts || []).find(a => a.handle === h) || {};
  const comp = Object.keys(S.accounts).filter(h => !isOwn(h) && (!br || (meta(h).brands || []).includes(br))).sort();
  const own = Object.keys(S.accounts).filter(h => isOwn(h) && (!br || meta(h).own === br || (S.brands && S.brands[br] && S.brands[br].own_account === h)));
  el.innerHTML = `<option value="">${br ? "All their competitors" : "All competitors"}</option>` + comp.map(a => `<option value="${esc(a)}">@${esc(a)}</option>`).join("") + (own.length ? `<optgroup label="Own account">${own.map(a => `<option value="${esc(a)}">👤 @${esc(a)}</option>`).join("")}</optgroup>` : "");
  if ([...comp, ...own].includes(cur)) el.value = cur;
}
function fillSelects() {
  const accs = Object.keys(S.accounts).sort();
  fillOvAccounts();
  ["#pAccount", "#rAccount", "#repAccount"].forEach(sel => {
    const el = $(sel), cur = el.value;
    el.innerHTML = '<option value="">All competitors</option>' + accs.map(a => `<option value="${esc(a)}">@${esc(a)}</option>`).join("");
    if (accs.includes(cur)) el.value = cur;
  });
}
/* ---------- overview ---------- */
const engB = p => (p.likes || 0) + (p.replies || 0) + (p.reposts || 0) + (p.shares || 0); // brand team's formula
const medCache = {};
function authorMedian(h) {
  if (h in medCache) return medCache[h];
  const a = S.accounts[h]; if (!a) return (medCache[h] = 0);
  const base = Object.values(a.posts || {}).filter(p => p.type === "post" && p.date).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 40);
  return (medCache[h] = base.length >= 5 ? Math.max(1, median(base.map(engB))) : 0);
}
const xOf = p => { const m = authorMedian(p.account); return m ? engB(p) / m : 0; };
const xFmt = x => (x >= 10 ? Math.round(x) : x.toFixed(1)) + "x";
const firstLine = t => { t = (t || "").trim(); const m = t.match(/^[^\n]*?[.!?¿¡…](?=\s|$)|^[^\n]+/); return (m ? m[0] : t).slice(0, 160); };
function isOwn(h) {
  const a = (S.index.accounts || []).find(x => x.handle === h);
  return !!((a && a.own) || Object.values(S.brands || {}).some(b => b.own_account === h));
}
function ovHandles() {
  const acc = $("#ovAccount").value, br = $("#ovBrand").value;
  if (acc) return [acc];
  return Object.keys(S.accounts).filter(h => !isOwn(h) && (!br || ((S.index.accounts.find(a => a.handle === h) || {}).brands || []).includes(br)));
}
const STOP = new Set(("a al algo algunos ante antes como con contra cual cuando de del desde donde dos el ella ellas ellos en entre era es esa ese eso esta este esto estos ha hay la las le les lo los más me mi mis muy nada ni no nos o os otra otro para pero poco por porque que qué quien se sea ser si sí sin sobre su sus también te tu tus un una uno unos y ya yo tú él va ver vas has son está están estás puede hace hacer cada todo toda todos todas solo sólo bien tan tanto así mismo misma vez veces eres fue será tiene tienes tener " +
  "the a an and or but if of to in on at for with from by is are was were be been being it its this that these those i you he she we they me my your our their his her them us not no so do does did done have has had will would can could should just than then there here what when where who why how all any more most some such only own same too very also into about up out over again once really get got make made one like dont don't it's i'm you're").split(" "));
function topWords(posts) {
  if (posts.length < 8) return [];
  const sorted = [...posts].sort((a, b) => xOf(b) - xOf(a)), q = Math.max(3, Math.round(sorted.length / 4));
  const tok = t => [...new Set((t || "").toLowerCase().replace(/https?:\S+|@\w+/g, " ").match(/[a-záéíóúñü']{4,}/g) || [])].filter(w => !STOP.has(w));
  const cnt = list => { const c = {}; list.forEach(p => tok(p.text).forEach(w => c[w] = (c[w] || 0) + 1)); return c; };
  const top = cnt(sorted.slice(0, q)), rest = cnt(sorted.slice(q)), nr = sorted.length - q;
  return Object.entries(top).filter(([, n]) => n >= 2).map(([w, n]) => ({ w, n, lift: (n / q) / (((rest[w] || 0) + 0.5) / nr) }))
    .filter(r => r.lift > 1.5).sort((a, b) => b.lift * b.n - a.lift * a.n).slice(0, 18);
}
function goView(focus) { goto("reports", "r-" + focus); openReportView(focus); }
function renderOverview() {
  const range = $("#ovRange").value, hs = ovHandles(), hset = new Set(hs);
  const inScope = p => hset.has(p.account);
  const posts = filtered("", range, "post").filter(inScope), reps = filtered("", range, "reply").filter(inScope);
  $("#ovScope").textContent = hs.length ? (hs.length === 1 ? (isOwn(hs[0]) ? "Own account" : "") : `${hs.length} competitors`) : "No competitors for this ambassador yet";
  $("#kPosts").textContent = fmt(posts.length);
  $("#kPostsH").textContent = posts.length ? `across ${new Set(posts.map(p => p.account)).size} account(s)` : "none in range";
  const xs = posts.map(p => ({ p, x: xOf(p) })).sort((a, b) => b.x - a.x);
  const hot = xs.filter(o => o.x >= 5), warm = xs.filter(o => o.x >= 3 && o.x < 5);
  $("#kOut").textContent = hot.length; $("#kOutH").textContent = `✅ 5x+ · plus ${warm.length} 🟡 at 3-5x`;
  $("#kMed").textContent = fmt(Math.round(median(posts.map(engB))));
  const ers = posts.map(p => { const f = p.followers || (S.accounts[p.account] && S.accounts[p.account].profile.followers); return f ? engB(p) / f * 100 : null; }).filter(x => x != null);
  const er = median(ers); $("#kER").textContent = ers.length ? (er < 1 ? er.toFixed(2) : er.toFixed(1)) + "%" : "-";
  const vw = posts.filter(p => p.views > 0);
  $("#kViews").textContent = vw.length ? fmt(Math.round(median(vw.map(p => p.views)))) : "-";
  $("#kViewsH").textContent = vw.length ? `${vw.length} of ${posts.length} posts show views` : "views not available";
  const best = (groups, min) => { let b = null; Object.entries(groups).forEach(([k, v]) => { if (v.length < min) return; const a = median(v.map(xOf)); if (!b || a > b.a) b = { k, a, n: v.length }; }); return b; };
  const bd = best(groupBy(posts.filter(p => p.date), p => dayOf(p.date)), 2);
  $("#kDay").textContent = bd ? bd.k : "-"; $("#kDayH").textContent = bd ? `${xFmt(bd.a)} usual · ${bd.n} posts` : "needs more posts";
  const slot = p => { const h = new Date(p.date).getHours(); return String(Math.floor(h / 3) * 3).padStart(2, "0") + "-" + String(Math.floor(h / 3) * 3 + 3).padStart(2, "0"); };
  const bt = best(groupBy(posts.filter(p => p.date), slot), 3);
  $("#kTime").textContent = bt ? bt.k : "-"; $("#kTimeH").textContent = bt ? `${xFmt(bt.a)} usual · ${bt.n} posts · your time` : "needs more posts";
  $("#kReplies").textContent = fmt(reps.length);
  $("#kRepliesH").textContent = posts.length ? `${(reps.length / Math.max(1, posts.length)).toFixed(1)} replies per post` : "";

  // outliers
  const outs = xs.filter(o => o.x >= 3).slice(0, 6);
  $("#ovOutliers").innerHTML = outs.length ? outs.map(({ p, x }) => {
    const h = firstLine(p.text), rest = (p.text || "").trim().slice(h.length).trim();
    return `<div class="ol"><div class="meta"><span class="xb">${x >= 5 ? "✅" : "🟡"} ${xFmt(x)} usual</span><b>@${esc(p.account)}</b><span>${p.date ? new Date(p.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</span><span class="tag">${esc(formatOf(p.text))}</span>${p.topicTag ? `<span class="tag">#${esc(p.topicTag)}</span>` : ""}<span>♥ ${fmt(p.likes)} 💬 ${fmt(p.replies)} ↻ ${fmt(p.reposts)}${p.views ? " 👁 " + fmt(p.views) : ""}</span>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">open ↗</a>` : ""}</div><div class="hook">${esc(h) || '<span class="muted">(image or video)</span>'}</div>${rest ? `<div class="rest">${esc(rest)}</div>` : ""}</div>`;
  }).join("") : '<p class="muted small">No post reached 3x its author\'s usual engagement in this range. Try "All time".</p>';

  // hooks
  barChart($("#chHook"), groupBy(posts, p => formatOf(p.text)), FMT_ORDER, xOf, xFmt);
  const hookList = xs.filter(o => (o.p.text || "").trim().length > 10).slice(0, 6);
  $("#ovHooks").innerHTML = hookList.map(({ p, x }) => `<div class="mini"><div class="meta"><span class="xb">${xFmt(x)}</span><span>@${esc(p.account)}</span><span class="tag">${esc(formatOf(p.text))}</span></div>“${esc(firstLine(p.text))}”</div>`).join("");

  // topics & words
  const tagG = {}; posts.forEach(p => { const tags = [p.topicTag, ...(p.hashtags || [])].filter(Boolean).map(t => String(t).replace(/^#/, "").toLowerCase()); [...new Set(tags)].forEach(t => (tagG[t] = tagG[t] || []).push(p)); });
  const tagRows = Object.entries(tagG).map(([t, l]) => ({ t, n: l.length, x: median(l.map(xOf)) })).sort((a, b) => (b.n >= 2) - (a.n >= 2) || b.x - a.x).slice(0, 8);
  const tagged = posts.filter(p => p.topicTag || (p.hashtags || []).length).length;
  $("#ovTags").innerHTML = tagRows.length ? `<p class="small muted" style="margin:0 0 6px">${tagged} of ${posts.length} posts use a tag</p><table><tr><th>Tag</th><th class="n">Posts</th><th class="n">× usual</th></tr>${tagRows.map(r => `<tr><td>#${esc(r.t)}</td><td class="n">${r.n}</td><td class="n">${xFmt(r.x)}</td></tr>`).join("")}</table>` : '<p class="muted small">No topic tags in this range.</p>';
  const ws = topWords(posts);
  $("#ovWords").innerHTML = ws.length ? ws.map(r => `<span class="wchip" title="in ${r.n} top posts, ${r.lift.toFixed(1)}x more often than in the rest">${esc(r.w)} <small>${r.n}</small></span>`).join("") : '<span class="muted small">Needs at least 8 posts.</span>';

  // communication
  const rt = reps.map(r => (r.text || "").trim()).filter(Boolean);
  const pct = f => rt.length ? Math.round(rt.filter(f).length / rt.length * 100) + "%" : "-";
  const words = rt.map(t => t.split(/\s+/).length);
  let cm = 0, ca = 0; hs.forEach(h => Object.values((S.accounts[h] || {}).comments || {}).forEach(l => l.forEach(c => { if (c.isAuthor) ca++; else cm++; })));
  const topReps = [...reps].sort((a, b) => engB(b) - engB(a)).slice(0, 4);
  $("#ovComm").innerHTML = reps.length ? `<div class="mstats">
      <div><b>${median(words)}</b>words in a typical reply</div>
      <div><b>${pct(t => /[?¿]/.test(t))}</b>of replies ask a question back</div>
      <div><b>${pct(t => /\p{Extended_Pictographic}/u.test(t))}</b>use emoji${rt.length ? ` · ${pct(t => /^\p{Extended_Pictographic}+$/u.test(t.replace(/\s/g, "")))} are emoji-only` : ""}</div>
      <div><b>${cm ? Math.round(ca / (cm + ca) * 100) + "%" : pct(t => /\b(gracias|thank|thanks)\b/i.test(t))}</b>${cm ? "of comment threads get an author answer" : "say thanks"}</div></div>
      <h3 class="small muted" style="margin:0 0 4px">Their most liked replies</h3>${topReps.map(r => `<div class="mini">${r.parentText ? `<div class="par">↳ ${r.parentAuthor ? "@" + esc(r.parentAuthor) + ": " : ""}${esc(r.parentText.slice(0, 90))}${r.parentText.length > 90 ? "…" : ""}</div>` : ""}<div class="meta"><b>@${esc(r.account)}</b><span>♥ ${fmt(r.likes)}</span></div>${esc(r.text)}</div>`).join("")}`
    : '<p class="muted small">No replies collected in this range.</p>';

  // hypotheses & reports
  const br = $("#ovBrand").value, bname = br && S.brands && S.brands[br] ? S.brands[br].name : "";
  const hyps = (S.hyps || []).filter(h => !bname || bname.toLowerCase().startsWith(String(h.persona || "").toLowerCase().slice(0, 3))).slice(-4).reverse();
  $("#ovHyp").innerHTML = hyps.length ? hyps.map(h => `<div class="hc"><div class="meta small muted">${esc(h.type || "")} · ${esc(h.persona || "")} · ${esc(h.verdict || "")}${h.x_median ? ` · ref ${esc(h.x_median)}x median` : ""}</div><b>${esc(h.name)}</b><div style="margin-top:4px">${esc(h.hook || "")}</div>${h.mechanic ? `<div class="small muted" style="margin-top:4px">Mechanic: ${esc(h.mechanic)}</div>` : ""}</div>`).join("")
    : '<p class="muted small">No hypothesis cards yet. Run a "Hypothesis cards" report.</p>';
  const reportsList = (S.index.reports || []).filter(r => !br || r.brand === br).slice(0, 4);
  const FI = { full: "📋", replies: "💬", hooks: "🪝", topics: "🏷", hypotheses: "🧪", voice: "Aa", own: "👤", ideas: "✍️" };
  $("#ovReps").innerHTML = reportsList.length ? '<h3 class="small muted" style="margin:0 0 4px">Latest reports</h3>' + reportsList.map(r => `<div class="mini"><a href="#" data-rep="${esc(r.path)}">${FI[r.focus] || "📄"} ${esc(r.title)}</a> <span class="muted small">· ${r.scope === "single" ? "@" + esc((r.accounts || [])[0] || "") : "all competitors"} · ${new Date(r.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></div>`).join("") : "";
  $$("#ovReps [data-rep]").forEach(a => a.onclick = e => { e.preventDefault(); goto("reports", "r-all"); openReportView(""); openReport(a.dataset.rep); });

  // format & timing
  barChart($("#chLen"), groupBy(posts, p => lenOf(p.text)), LEN_ORDER, xOf, xFmt);
  barChart($("#chMedia"), groupBy(posts, p => ({ text: "Text only", image: "Image", video: "Video", carousel: "Carousel" })[p.media] || (p.media ? p.media[0].toUpperCase() + p.media.slice(1) : null)), ["Text only", "Image", "Carousel", "Video"], xOf, xFmt);
  barChart($("#chDay"), groupBy(posts.filter(p => p.date), p => dayOf(p.date)), DAYS, xOf, xFmt);
  barChart($("#chHour"), groupBy(posts.filter(p => p.date), p => { const h = new Date(p.date).getHours(); return HOURS.find(x => h >= x[1] && h < x[2])[0]; }), HOURS.map(h => h[0]), xOf, xFmt);
  const weak = xs.filter(o => authorMedian(o.p.account)).slice(-5).reverse();
  $("#weakPosts").innerHTML = posts.length > 10 ? weak.map(o => `<div class="mini"><div class="meta"><span class="xb">${xFmt(o.x)}</span><b>@${esc(o.p.account)}</b><span class="tag">${esc(formatOf(o.p.text))}</span></div>${esc((o.p.text || "").slice(0, 220))}</div>`).join("") : '<p class="muted small">Needs more than 10 posts.</p>';
}
function renderPosts() {
  const q = $("#pSearch").value.toLowerCase(), acc = $("#pAccount").value, sort = $("#pSort").value;
  const l = filtered(acc, 0, "post").filter(p => !q || p.text.toLowerCase().includes(q));
  l.sort(sort === "eng" ? (a, b) => eng(b) - eng(a) : sort === "views" ? (a, b) => (b.views || 0) - (a.views || 0) : (a, b) => (b.date || "").localeCompare(a.date || ""));
  $("#pList").innerHTML = l.length ? l.slice(0, S.pLimit).map(p => postHTML(p, false)).join("") : '<p class="empty">No posts match.</p>';
  $("#pMore").classList.toggle("hidden", l.length <= S.pLimit);
}
function renderReplies() {
  const q = $("#rSearch").value.toLowerCase(), acc = $("#rAccount").value;
  const l = filtered(acc, 0, "reply").filter(p => !q || (p.text + " " + p.parentText).toLowerCase().includes(q)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("#rList").innerHTML = l.length ? l.slice(0, S.rLimit).map(p => postHTML(p, true)).join("") : '<p class="empty">No replies collected.</p>';
  $("#rMore").classList.toggle("hidden", l.length <= S.rLimit);
  // conversations under posts
  const threads = [];
  Object.values(S.accounts).forEach(a => { if (acc && a.handle !== acc) return; Object.entries(a.comments || {}).forEach(([pid, items]) => threads.push({ a, post: (a.posts || {})[pid], items })); });
  const authorAnswers = threads.reduce((s, t) => s + t.items.filter(c => c.isAuthor).length, 0);
  const totalComments = threads.reduce((s, t) => s + t.items.length, 0);
  $("#cSummary").textContent = threads.length ? `${totalComments} comments under ${threads.length} posts · the author answered ${authorAnswers} of them` : "";
  $("#cList").innerHTML = threads.length ? threads.map(t => `<details class="thread"><summary><b>@${esc(t.a.handle)}</b> · ${esc((t.post && t.post.text || "").slice(0, 90))}… <span class="muted small">${t.items.length} comments${t.items.some(c => c.isAuthor) ? " · author replied" : ""}</span></summary>${t.items.map(c => `<div class="cmt d${Math.min(c.depth, 3)}${c.isAuthor ? " author" : ""}"><div class="meta"><b>@${esc(c.username)}</b>${c.isAuthor ? '<span class="tag">author</span>' : ""}<span>♥ ${fmt(c.likes)}</span></div><div class="txt">${esc(c.text)}</div></div>`).join("")}</details>`).join("")
    : '<p class="muted small">Comments under posts are not collected yet. Run "Get report" with "Also collect comments" ticked, or set "comments": true for the account in config/accounts.json.</p>';
}
function renderCompare() {
  const rows = Object.values(S.accounts).map(a => {
    const posts = Object.values(a.posts || {}).filter(p => p.type === "post");
    const reps = Object.values(a.posts || {}).filter(p => p.type === "reply");
    const vw = posts.filter(p => p.views > 0); const f = a.profile.followers || 0;
    const dates = posts.map(p => p.date).filter(Boolean).sort();
    const weeks = dates.length > 1 ? (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 6048e5 : 0;
    const fmts = groupBy(posts, p => formatOf(p.text)); let bestF = "-", bestA = -1;
    Object.entries(fmts).forEach(([k, v]) => { if (v.length < 3) return; const av = v.reduce((s, p) => s + eng(p), 0) / v.length; if (av > bestA) { bestA = av; bestF = k; } });
    return { h: a.handle, f, posts: posts.length, reps: reps.length, med: Math.round(median(posts.map(eng))), views: vw.length ? Math.round(median(vw.map(p => p.views))) : 0, er: f ? median(posts.map(p => eng(p) / f * 100)) : 0, perWeek: weeks ? posts.length / weeks : 0, bestF };
  }).sort((a, b) => b.er - a.er);
  $("#cmpTable").innerHTML = rows.length ? `<table><tr><th>Account</th><th class="n">Followers</th><th class="n">Posts</th><th class="n">Replies</th><th class="n">Posts / week</th><th class="n">Median eng.</th><th class="n">Median views</th><th class="n">Eng. rate</th><th>Best format</th></tr>${rows.map(r => `<tr><td><a href="https://www.threads.com/@${esc(r.h)}" target="_blank" rel="noopener">@${esc(r.h)}</a></td><td class="n">${fmt(r.f)}</td><td class="n">${r.posts}</td><td class="n">${r.reps}</td><td class="n">${r.perWeek ? r.perWeek.toFixed(1) : "-"}</td><td class="n">${fmt(r.med)}</td><td class="n">${r.views ? fmt(r.views) : "-"}</td><td class="n">${r.er ? r.er.toFixed(2) + "%" : "-"}</td><td>${esc(r.bestF)}</td></tr>`).join("")}</table>` : '<p class="muted small">No accounts yet.</p>';
}

/* ---------- reports ---------- */
function md(t) {
  const lines = esc(t).split("\n"); let out = "", list = null, quote = [], table = [];
  const inline = s => s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*(.+?)\*(?=[\s).,;:]|$)/g, "$1<i>$2</i>")
    .replace(/(^|\s)(🟢|🟡|🔴)/g, "$1<span class=\"verdict\">$2</span>");
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  const flushQuote = () => {
    if (!quote.length) return;
    out += '<blockquote class="post">' + quote.map(q => /^<i>EN:|^\*EN:|^EN:/.test(q.trim()) ? `<span class="en">${inline(q)}</span>` : inline(q)).join("\n") + "</blockquote>";
    quote = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
    const [head, ...body] = rows;
    out += '<div class="tbl"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" +
      body.map(r => "<tr>" + r.map(c => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table></div>";
    table = [];
  };
  for (const l of lines) {
    if (/^\s*\|.*\|\s*$/.test(l)) { closeList(); flushQuote(); table.push(l); continue; }
    flushTable();
    const q = l.match(/^\s*&gt;\s?(.*)/);
    if (q) { closeList(); quote.push(q[1]); continue; }
    if (/^\*?EN:/.test(l.trim()) && quote.length) { quote.push(l); continue; }
    flushQuote();
    const h = l.match(/^(#{1,4})\s+(.*)/);
    const task = l.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i);
    const ol = l.match(/^\s*\d+[.)]\s+(.*)/), li = l.match(/^\s*[-*•]\s+(.*)/);
    if (task) { if (list !== "ul") { closeList(); out += '<ul class="todo">'; list = "ul"; }
      out += `<li><label><input type="checkbox"${task[1].trim() ? " checked" : ""}> <span>${inline(task[2])}</span></label></li>`; continue; }
    if (ol) { if (list !== "ol") { closeList(); out += "<ol>"; list = "ol"; } out += "<li>" + inline(ol[1]) + "</li>"; continue; }
    if (li) { if (list !== "ul") { closeList(); out += "<ul>"; list = "ul"; } out += "<li>" + inline(li[1]) + "</li>"; continue; }
    closeList();
    if (/^\s*---+\s*$/.test(l)) { out += "<hr>"; continue; }
    if (h) { const n = h[1].length; out += `<h${n + 1} class="h${n}">${inline(h[2])}</h${n + 1}>`; }
    else if (l.trim()) out += "<p>" + inline(l) + "</p>";
  }
  flushTable(); flushQuote(); closeList();
  return out;
}
const brandName = k => ((S.index && S.index.brands || {})[k] || {}).name || k;
let REP_SHOWN = [];
const fileName = p => p.split("/").slice(-2).join("-");
function saveFile(text, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 500);
}
async function loadShown() {
  return Promise.all(REP_SHOWN.map(async r => { try { return [r, await (await fetch(r.path + "?v=" + Date.now())).text()]; } catch (e) { return [r, "(couldn't load " + r.path + ")"]; } }));
}
function bulkName(ext) {
  const br = $("#repBrand").value, acc = $("#repAccount").value;
  return ["reports", br && brandName(br).split(" (")[0], acc && "@" + acc, new Date().toISOString().slice(0, 10)].filter(Boolean).join("-").replace(/[^\p{L}\p{N}@._-]+/gu, "_") + ext;
}
async function downloadAll() {
  const btn = $("#repDlAll"), label = btn.textContent; btn.textContent = "Preparing..."; btn.disabled = true;
  try {
    const all = await loadShown();
    const toc = all.map(([r], i) => `${i + 1}. ${r.title} - ${r.accounts.map(a => "@" + a).join(", ")} (${r.created.slice(0, 10)})`).join("\n");
    saveFile(`# ${$("#repCount").textContent}\n\n${toc}\n\n` + all.map(([, t]) => t.trim()).join("\n\n---\n\n") + "\n", bulkName(".md"));
  } finally { btn.textContent = label; btn.disabled = false; }
}
async function pdfAll() {
  const btn = $("#repPdfAll"), label = btn.textContent; btn.textContent = "Preparing..."; btn.disabled = true;
  try {
    const all = await loadShown();
    $("#repOut").innerHTML = `<h1>${esc($("#repCount").textContent)}</h1>` + all.map(([, t], i) => `<div class="${i ? "rep-sep" : ""}">${md(t)}</div>`).join("");
    $("#repOutCard").classList.remove("hidden");
    document.title = bulkName("");
    document.body.classList.add("printing-report"); window.print();
    setTimeout(() => { document.body.classList.remove("printing-report"); document.title = "Threads Competitor Tracker"; }, 500);
  } finally { btn.textContent = label; btn.disabled = false; }
}
function renderReportList() {
  const rb = $("#repBrand"), ra = $("#repAccount");
  if (rb.value && S.index && S.index.accounts) {
    const mine = S.index.accounts.filter(a => (a.brands || []).includes(rb.value)).map(a => a.handle), cur = ra.value;
    ra.innerHTML = `<option value="">All ${esc(brandName(rb.value).split(" (")[0])}'s competitors</option>` + mine.map(h => `<option value="${esc(h)}">@${esc(h)}</option>`).join("");
    ra.value = mine.includes(cur) ? cur : "";
  } else if (ra.options.length && ra.options[0].textContent !== "All competitors") fillSelects();
  const acc = ra.value, br = rb.value, sc = $("#repScope").value, fo = $("#repFocus").value;
  if (S.index && S.index.brands && rb.options.length < 2)
    rb.innerHTML = '<option value="">All ambassadors</option>' + Object.keys(S.index.brands).map(k => `<option value="${esc(k)}">${esc(brandName(k))}</option>`).join("");
  const scopeOf = r => r.scope || (r.accounts.length > 1 ? "all" : "single");
  const list = (S.index.reports || []).filter(r => (!acc || r.accounts.includes(acc)) && (!br || r.brand === br) && (!sc || scopeOf(r) === sc) && (!fo || r.focus === fo));
  REP_SHOWN = list;
  const who = br ? brandName(br).split(" (")[0] : "";
  $("#repCount").textContent = list.length ? `${list.length} report${list.length > 1 ? "s" : ""}${who ? " for " + who : ""}${acc ? " on @" + acc : ""}` : "";
  $("#repBulk").classList.toggle("hidden", !list.length);
  $("#repList").innerHTML = list.length ? list.map(r => `<div class="ins-item rep-row" data-path="${esc(r.path)}"><div><b>${esc(r.title)}</b> · ${r.accounts.map(a => "@" + esc(a)).join(", ")}<div class="small muted">${new Date(r.created).toLocaleString("en-GB", {day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})} · for ${esc(brandName(r.brand))}${scopeOf(r) === "all" ? ' · <span class="tag">combined</span>' : ""}${r.requestedBy ? " · by " + esc(r.requestedBy) : ""}</div></div><button class="btn rep-dl" type="button" data-dl="${esc(r.path)}" title="Download this report">Download</button></div>`).join("") : `<p class="muted small">${$("#repFocus").value === "own" ? "The first ambassador account reviews arrive with the monthly digest on the 1st." : "No reports of this kind yet. Choose the ambassador above and press Run, or change the filters."}</p>`;
  $$("#repList .rep-dl").forEach(btn => btn.onclick = async e => { e.stopPropagation(); const t = await (await fetch(btn.dataset.dl + "?v=" + Date.now())).text(); saveFile(t, fileName(btn.dataset.dl)); });
  $$("#repList .ins-item").forEach(d => d.onclick = () => openReport(d.dataset.path));
}
async function openReport(path) {
  $("#repOut").innerHTML = '<p class="muted">Loading...</p>'; $("#repOutCard").classList.remove("hidden");
  try {
    const r = await fetch(path + "?v=" + Date.now()); const t = await r.text(); $("#repOut").innerHTML = md(t); $("#repRaw").href = path; $("#repOutCard").scrollIntoView({ behavior: "smooth" });
    $("#repDl").onclick = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([t], { type: "text/markdown;charset=utf-8" })); a.download = path.split("/").slice(-2).join("-"); document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 500); };
    $("#repPrint").onclick = () => { document.body.classList.add("printing-report"); window.print(); setTimeout(() => document.body.classList.remove("printing-report"), 500); };
  }
  catch (e) { $("#repOut").innerHTML = '<p class="muted">Couldn\'t load this report.</p>'; }
}

/* ---------- run a report from the dashboard (GitHub API) ---------- */
const REPO = (() => { const u = repoUrl(); return u ? u.replace("https://github.com/", "") : "vladasidlyak/threads-tracker"; })();
const API = "https://api.github.com/repos/" + REPO;
const store = { get() { try { return localStorage.getItem("tt_token") || ""; } catch (e) { return ""; } },
  set(v) { try { v ? localStorage.setItem("tt_token", v) : localStorage.removeItem("tt_token"); return true; } catch (e) { return false; } } };
let memToken = store.get();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ghApi(path, opts = {}) {
  return fetch(API + path, Object.assign({}, opts, { headers: Object.assign({ "Authorization": "Bearer " + memToken, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, opts.body ? { "Content-Type": "application/json" } : {}) }));
}
function tokenUI() {
  const on = !!memToken;
  $("#tokBtn").textContent = on ? "GitHub connected ✓" : "Connect GitHub";
  $("#tokForget").classList.toggle("hidden", !on);
  $("#runGo").disabled = false;
}
$("#tokBtn").onclick = () => $("#tokBox").classList.toggle("hidden");
$("#tokHelpLink").onclick = e => { e.preventDefault(); $("#tokHelp").classList.toggle("hidden"); };
$("#tokSave").onclick = async () => {
  const v = $("#tokIn").value.trim(); const st = $("#tokStatus");
  if (!v) { st.textContent = "Paste the token first."; return; }
  memToken = v; st.textContent = "Checking...";
  try {
    const r = await ghApi("/actions/workflows/report.yml");
    if (r.status === 401) { memToken = store.get(); st.textContent = "GitHub rejected this token. Check you copied all of it."; return; }
    if (!r.ok) { memToken = store.get(); st.textContent = "This token can't see the repository. Give it access to threads-tracker with Actions: Read and write."; return; }
    const saved = store.set(v); $("#tokIn").value = "";
    st.textContent = saved ? "Connected. The token is saved in this browser only." : "Connected for this visit (this browser can't save it).";
    tokenUI(); setTimeout(() => $("#tokBox").classList.add("hidden"), 1500);
  } catch (e) { memToken = store.get(); st.textContent = "Couldn't reach GitHub. Check your connection."; }
};
$("#tokForget").onclick = () => { memToken = ""; store.set(""); tokenUI(); $("#tokStatus").textContent = "Token removed from this browser."; };

/* Two ways to start runs:
   - "worker": the dashboard is served by the Cloudflare Worker; people sign in with email, no token.
   - "token":  GitHub Pages; the owner pastes a GitHub token once. */
let MODE = "token", ME = "";
const B = {
  async dispatch(inputs, wf = "report") {
    if (MODE === "worker") {
      const r = await fetch("api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ workflow: wf }, inputs)) });
      if (!r.ok) { let m = "Couldn't start the run (" + r.status + ")."; try { m = (await r.json()).error || m; } catch (e) {}
        if (/bad form values|unknown brand/i.test(m) || (inputs.scope && inputs.scope !== "single" && /profile link/i.test(m))) m = "The sign-in server (Cloudflare Worker) runs old code that doesn't know this option yet. Paste the latest cloudflare/worker.js into Cloudflare (Edit code, select all, paste, Deploy) and try again.";
        throw new Error(m); }
      return;
    }
    const r = await ghApi("/actions/workflows/" + wf + ".yml/dispatches", { method: "POST", body: JSON.stringify({ ref: "main", inputs }) });
    if (r.status === 401) throw new Error("GitHub rejected the token. Connect GitHub again.");
    if (r.status === 403 || r.status === 404) throw new Error("The token isn't allowed to run workflows. It needs Actions: Read and write on threads-tracker.");
    if (!r.ok) throw new Error("GitHub refused the request (" + r.status + ").");
  },
  async find(since, wf = "report") {
    if (MODE === "worker") { const r = await fetch("api/runs?workflow=" + wf + "&since=" + encodeURIComponent(since), { cache: "no-store" }); return r.ok ? (await r.json()).run : null; }
    const lr = await ghApi("/actions/workflows/" + wf + ".yml/runs?per_page=5&event=workflow_dispatch&created=%3E%3D" + encodeURIComponent(since));
    return lr.ok ? ((await lr.json()).workflow_runs || [])[0] || null : null;
  },
  async status(id) {
    if (MODE === "worker") { const r = await fetch("api/runs/" + id, { cache: "no-store" }); return r.ok ? (await r.json()).run : null; }
    const rr = await ghApi("/actions/runs/" + id); return rr.ok ? rr.json() : null;
  }
};
(async () => {
  try {
    const r = await fetch("api/me", { cache: "no-store" });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      ME = (await r.clone().json()).email || ""; MODE = "worker";
      $("#tokBtn").classList.add("hidden"); $("#tokBox").classList.add("hidden");
      const me = await r.clone().json().catch(() => ({}));
      $("#whoami").innerHTML = ME ? "Signed in as " + esc(ME) + (me.logout ? ' · <a href="logout">Log out</a>' : "") : ""; $("#whoami").classList.remove("hidden");
    }
  } catch (e) {}
})();

/* who are this ambassador's competitors */
const competitorsOf = b => ((S.index && S.index.accounts) || []).filter(a => (a.brands || []).includes(b));
function runFormUI() {
  const b = $("#runBrand").value, scope = $("#runScope").value, list = competitorsOf(b), name = brandName(b).split(" (")[0];
  const pick = $("#runPick"), cur = pick.value;
  const extra = pick.dataset.extra && !list.some(a => a.handle === pick.dataset.extra) ? pick.dataset.extra : "";
  pick.innerHTML = list.map(a => `<option value="${esc(a.handle)}">@${esc(a.handle)}${a.fullName ? " - " + esc(a.fullName) : ""}</option>`).join("") +
    (extra ? `<option value="${esc(extra)}">@${esc(extra)} (new)</option>` : "");
  if (!pick.options.length) pick.innerHTML = '<option value="">No competitors yet - paste a link</option>';
  if ([...pick.options].some(o => o.value === cur)) pick.value = cur;
  const single = scope === "single";
  $("#runOne").classList.toggle("hidden", !single);
  $("#runUrl").classList.toggle("hidden", !single);
  pick.disabled = !!$("#runUrl").value.trim() || !list.length && !extra;
  const info = $("#runAllInfo"); info.classList.toggle("hidden", single);
  if (!single) info.innerHTML = list.length
    ? `${scope === "all" ? "One report comparing" : "A separate report for each of"} ${name}'s ${list.length} competitor${list.length > 1 ? "s" : ""}: ${list.map(a => "@" + esc(a.handle)).join(", ")}. ` +
      `New posts are collected first. About $${scope === "all" ? "0.15-0.30" : (0.12 * list.length).toFixed(2) + "-" + (0.25 * list.length).toFixed(2)}.`
    : `${esc(name)} has no competitors yet. Choose "One competitor", paste a competitor's Threads link and press Run - it's saved as ${esc(name)}'s competitor.`;
  
  $("#runComments").closest("label").classList.toggle("hidden", !single);
}
["#runBrand", "#runScope", "#runPick"].forEach(id => $(id).addEventListener("change", runFormUI));
window.addEventListener("tt-brands", runFormUI);

function prefillRun(handle, focus, skip) {
  goto("reports", "r-all"); openReportView($("#repFocus").value || "");
  $("#runScope").value = "single"; runFormUI();
  $("#runUrl").value = ""; $("#runPick").dataset.extra = handle; runFormUI();
  $("#runPick").value = handle;
  $("#runFocus").value = focus; $("#runSkip").checked = !!skip; runFormUI();
  $("#runCard").scrollIntoView({ behavior: "smooth" });
}

let running = false;
async function runReport() {
  if (running) return;
  const st = $("#runStatus"), scope = $("#runScope").value;
  const url = $("#runUrl").value.trim() || ($("#runPick").value ? "@" + $("#runPick").value : "");
  if (scope === "single") {
    if (!url) { st.textContent = "Paste the new competitor's Threads link."; return; }
    if (!/^(https?:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]+|@?[A-Za-z0-9._]+)\/?(\?.*)?$/.test(url)) { st.textContent = "That doesn't look like a Threads profile link."; return; }
  } else if (!competitorsOf($("#runBrand").value).length) { st.innerHTML = $("#runAllInfo").innerHTML; return; }
  if (MODE === "token" && !memToken) { $("#tokBox").classList.remove("hidden"); st.textContent = "Connect GitHub first (one time only)."; return; }
  running = true; $("#runGo").disabled = true;
  const started = new Date(Date.now() - 30000).toISOString();
  try {
    st.textContent = "Starting...";
    await B.dispatch({ model: $("#runModel").value, scope, profile_url: scope === "single" ? url : "", brand: $("#runBrand").value, focus: $("#runFocus").value, max_posts: $("#runMax").value,
      include_comments: $("#runComments").checked, skip_collect: $("#runSkip").checked });
    let run = null;
    for (let i = 0; i < 12 && !run; i++) {
      await sleep(5000);
      run = await B.find(started);
    }
    if (!run) throw new Error("The run started but I couldn't find it. Check the Actions tab on GitHub.");
    const link = ` <a href="${esc(run.html_url)}" target="_blank" rel="noopener">View on GitHub</a>`;
    const t0 = Date.now();
    while (run.status !== "completed") {
      if (Date.now() - t0 > 30 * 60e3) throw new Error("This is taking over 30 minutes. Check the run on GitHub.");
      const label = scope !== "single" ? ($("#runSkip").checked ? "Writing the reports" : "Collecting new posts and writing the report" + (scope === "each" ? "s" : "")) : $("#runSkip").checked ? "Writing the report" : (Date.now() - t0 < 90e3 ? "Collecting posts from Threads" : "Collecting posts and writing the report");
      st.innerHTML = `${label}... ${Math.round((Date.now() - t0) / 1000)}s.` + link;
      await sleep(10000);
      const nr = await B.status(run.id); if (nr) run = nr;
    }
    if (run.conclusion !== "success") { st.innerHTML = "The run failed. Open it to see why (the last lines explain the problem)." + link; return; }
    st.innerHTML = "Done. Publishing to the dashboard (1-2 minutes)..." + link;
    const before = (S.index && S.index.reports || []).length;
    for (let i = 0; i < 24; i++) {
      await sleep(10000);
      try { const idx = await getJSON("data/index.json"); if ((idx.reports || []).length > before) { await reloadData(); goto("reports"); const p = (S.index.reports[0] || {}).path; if (p) openReport(p); st.innerHTML = "Done. The new report is open in Reports." + link; return; } } catch (e) {}
    }
    st.innerHTML = "Done. The dashboard is still publishing - refresh this page in a minute." + link;
  } catch (e) { st.textContent = e.message || "Something went wrong."; }
  finally { running = false; $("#runGo").disabled = false; }
}
$("#runGo").onclick = runReport;
$("#runUrl").onkeydown = e => { if (e.key === "Enter") runReport(); };

tokenUI();

const dataHooks = [];
window.TT = { openReportView, prefillRun, $, esc, fmt, eng, median, allPosts, S, goto: t => goto(t), onData: fn => dataHooks.push(fn),
  md: t => md(t), B: () => B, mode: () => MODE, hasToken: () => !!memToken, sleep, getJSON, reloadData: () => reloadData() };
/* ---------- wiring ---------- */
const REPORT_VIEWS = {
  "": ["All reports", "Every report, newest first. Use the filters to narrow down."],
  replies: ["💬 Communication reports", "ORM: how competitors talk to their audience - tone, best replies, techniques to adopt and reply templates."],
  hooks: ["🪝 Hooks & outliers", "Posts that got 5x+ their author's usual engagement, why they worked, and hooks to borrow (🆕 new / 📚 library)."],
  topics: ["🏷 Topics & tags", "What to post about (✅ Core / 🧪 Test / 🔍 Gap / ❌ Skip), pain clusters, tags, words, and search seeds."],
  hypotheses: ["🧪 Hypothesis cards", "Cards in the brand team's format: Mechanic × Insight × Reach/Quiz reason, H1-H3, references with × median."],
  own: ["👤 Ambassador accounts", "How Inés's and Jeff's own accounts are doing compared with their competitors. Written automatically every month."],
};
function goto(tab, key) {
  key = key || tab;
  $$("#nav button").forEach(b => b.classList.toggle("on", (b.dataset.key || b.dataset.tab) === key));
  $$("main > section").forEach(s => s.classList.toggle("hidden", s.id !== "tab-" + tab)); hideTip();
}
function openReportView(focus) {
  const [head, sub] = REPORT_VIEWS[focus] || REPORT_VIEWS[""];
  $("#repHead").textContent = head;
  $("#repFocus").value = focus;
  if (focus !== "own") $("#runFocus").value = [...$("#runFocus").options].some(o => o.value === focus) ? focus : "full";
  $("#runSub").textContent = focus ? sub : "Choose the ambassador, then one competitor, or all of their competitors at once.";
  $("#runCard").classList.toggle("hidden", focus === "own");
  renderReportList();
}
$$("#nav button").forEach(b => b.onclick = () => { goto(b.dataset.tab, b.dataset.key); if (b.dataset.tab === "reports") openReportView(b.dataset.focus || ""); });
["#ovAccount", "#ovRange"].forEach(s => $(s).onchange = renderOverview);
$("#ovBrand").onchange = () => { fillOvAccounts(); renderOverview(); };
$$("#tab-overview [data-go]").forEach(a => a.onclick = e => { e.preventDefault(); goView(a.dataset.go); });
$("#pSearch").oninput = () => { S.pLimit = 30; renderPosts(); }; $("#pAccount").onchange = $("#pSort").onchange = () => { S.pLimit = 30; renderPosts(); };
$("#pMore").onclick = () => { S.pLimit += 30; renderPosts(); };
$("#rSearch").oninput = () => { S.rLimit = 30; renderReplies(); }; $("#rAccount").onchange = () => { S.rLimit = 30; renderReplies(); };
$("#rMore").onclick = () => { S.rLimit += 30; renderReplies(); };
$("#repFocus").onchange = () => { $("#repHead").textContent = (REPORT_VIEWS[$("#repFocus").value] || ["Reports"])[0]; renderReportList(); };
$("#repDlAll").onclick = downloadAll; $("#repPdfAll").onclick = pdfAll;
$("#repAccount").onchange = renderReportList; $("#repBrand").onchange = renderReportList; $("#repScope").onchange = renderReportList;

const gh = repoUrl();
if (gh) $("#ghRepo").href = gh;
$("#ghReport").onclick = e => { e.preventDefault(); goto("reports", "r-all"); openReportView(""); $("#runCard").scrollIntoView({ behavior: "smooth" }); setTimeout(() => $("#runBrand").focus(), 400); };
$("#runUrl").addEventListener("input", runFormUI);

async function reloadData() {
  S.index = await getJSON("data/index.json"); S.accounts = {}; Object.keys(medCache).forEach(k => delete medCache[k]);
  try { S.hyps = await getJSON("data/hypotheses.json"); } catch (e) {}
  await Promise.all(S.index.accounts.filter(a => a.posts || a.replies).map(async a => { try { S.accounts[a.handle] = await getJSON(`data/accounts/${a.handle}.json`); } catch (e) {} }));
  fillSelects(); renderOverview(); renderPosts(); renderReplies(); renderCompare(); renderReportList(); runFormUI();
  dataHooks.forEach(f => { try { f(); } catch (e) { console.error(e); } });
}
(async function loadBrands() {
  try {
    let brands;
    try { brands = await getJSON("config/brands.json"); } catch (e) { brands = (await getJSON("data/index.json")).brands; }
    S.brands = brands;
    $("#ovBrand").innerHTML = '<option value="">All ambassadors</option>' + Object.entries(brands).filter(([k]) => !["liven", "overwell"].includes(k)).map(([k, b]) => `<option value="${esc(k)}">${esc(b.name)}</option>`).join("");
    if (S.index) { fillOvAccounts(); renderOverview(); }
    $$(".brand-select").forEach(sel => {
      const cur = sel.value;
      const opt = ([k, b]) => `<option value="${esc(k)}">For: ${esc(b.name)}</option>`;
      const amb = Object.entries(brands).filter(([k, b]) => b.ambassador !== false && !["liven", "overwell"].includes(k));
      const other = Object.entries(brands).filter(([k]) => !amb.some(([a]) => a === k));
      sel.innerHTML = `<optgroup label="Ambassadors">${amb.map(opt).join("")}</optgroup>` + (other.length ? `<optgroup label="Other brands">${other.map(opt).join("")}</optgroup>` : "");
      if (brands[cur]) sel.value = cur;
    });
    window.dispatchEvent(new Event("tt-brands"));
  } catch (e) {}
})();
(async function load() {
  try {
    S.index = await getJSON("data/index.json");
    try { S.hyps = await getJSON("data/hypotheses.json"); } catch (e) { S.hyps = []; }
    await Promise.all(S.index.accounts.filter(a => a.posts || a.replies).map(async a => { try { S.accounts[a.handle] = await getJSON(`data/accounts/${a.handle}.json`); } catch (e) {} }));
    $("#updated").textContent = "Data updated " + new Date(S.index.updated).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const u = S.index.usage;
    if (u && u.apifyBudget) $("#updated").textContent += ` · This month: Apify $${Number(u.apify || 0).toFixed(2)} of $${u.apifyBudget} (free credit), Claude $${Number(u.claude || 0).toFixed(2)} of $${u.claudeBudget}`;
    else if (u && u.budget) $("#updated").textContent += ` · Spent this month $${Number(u.spent || 0).toFixed(2)} of $${u.budget}`;
    fillSelects(); renderOverview(); renderPosts(); renderReplies(); renderCompare(); renderReportList(); runFormUI();
    dataHooks.forEach(f => { try { f(); } catch (e) { console.error(e); } });
    if (!Object.keys(S.accounts).length) $("#loadMsg").textContent = "No data yet. Run \"Get report\" in GitHub Actions to collect the first account.";
    else $("#loadMsg").classList.add("hidden");
  } catch (e) {
    $("#loadMsg").textContent = "Couldn't load data/index.json. If you opened this file directly from your computer, use the GitHub Pages link instead.";
  }
})();
})();
