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
function barChart(el, groups, order) {
  const keys = order.filter(k => groups[k] && groups[k].length);
  if (!keys.length) { el.innerHTML = '<p class="muted small">Not enough data.</p>'; return; }
  const rows = keys.map(k => { const a = groups[k].map(eng); return { k, avg: Math.round(a.reduce((x, y) => x + y, 0) / a.length), n: a.length, med: Math.round(median(a)) }; });
  const max = Math.max(...rows.map(r => r.avg), 1);
  el.innerHTML = '<div class="bars" role="img" aria-label="Average engagement by group">' + rows.map(r =>
    `<div class="bar-row" data-t="<b>${esc(r.k)}</b><br>Avg ${fmt(r.avg)} · median ${fmt(r.med)}<br>${r.n} post${r.n > 1 ? "s" : ""}"><span class="lab">${esc(r.k)}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, r.avg / max * 100)}%"></div></div><span class="val">${fmt(r.avg)}</span></div>`).join("") + "</div>" +
    `<details class="tbl"><summary>Show as table</summary><table><tr><th>Group</th><th class="n">Posts</th><th class="n">Avg</th><th class="n">Median</th></tr>${rows.map(r => `<tr><td>${esc(r.k)}</td><td class="n">${r.n}</td><td class="n">${fmt(r.avg)}</td><td class="n">${fmt(r.med)}</td></tr>`).join("")}</table></details>`;
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
function fillSelects() {
  const accs = Object.keys(S.accounts).sort();
  ["#ovAccount", "#pAccount", "#rAccount", "#repAccount"].forEach(sel => {
    const el = $(sel), cur = el.value;
    el.innerHTML = '<option value="">All competitors</option>' + accs.map(a => `<option value="${esc(a)}">@${esc(a)}</option>`).join("");
    if (accs.includes(cur)) el.value = cur;
  });
}
function renderOverview() {
  const acc = $("#ovAccount").value, range = $("#ovRange").value;
  const posts = filtered(acc, range, "post"), reps = filtered(acc, range, "reply");
  $("#kPosts").textContent = fmt(posts.length);
  const accs = new Set(posts.map(p => p.account));
  $("#kPostsH").textContent = accs.size ? `across ${accs.size} account${accs.size > 1 ? "s" : ""}` : "none in range";
  $("#kReplies").textContent = fmt(reps.length);
  $("#kRepliesH").textContent = reps.length ? `median ${fmt(median(reps.map(eng)))} engagement` : "none in range";
  $("#kMed").textContent = fmt(Math.round(median(posts.map(eng))));
  const byDay = groupBy(posts.filter(p => p.date), p => dayOf(p.date));
  let best = null; Object.entries(byDay).forEach(([k, v]) => { if (v.length < 2) return; const a = v.reduce((s, p) => s + eng(p), 0) / v.length; if (!best || a > best.a) best = { k, a, n: v.length }; });
  $("#kDay").textContent = best ? best.k : "-"; $("#kDayH").textContent = best ? `avg ${fmt(Math.round(best.a))} over ${best.n} posts` : "needs 2+ posts per day";
  const vw = posts.filter(p => p.views > 0);
  $("#kViews").textContent = vw.length ? fmt(Math.round(median(vw.map(p => p.views)))) : "-";
  $("#kViewsH").textContent = vw.length ? `${vw.length} of ${posts.length} posts show views` : "views not available";
  const ers = posts.map(p => { const f = p.followers || (S.accounts[p.account] && S.accounts[p.account].profile.followers); return f ? eng(p) / f * 100 : null; }).filter(x => x != null);
  const er = median(ers); $("#kER").textContent = ers.length ? (er < 1 ? er.toFixed(2) : er.toFixed(1)) + "%" : "-";
  $("#kEPV").textContent = vw.length ? String(Math.round(median(vw.map(p => eng(p) / p.views * 1000)))) : "-";
  const fol = followersOf(acc); $("#kFol").textContent = fol ? fmt(fol) : "-";
  const hist = acc && S.accounts[acc] ? S.accounts[acc].followersHistory || [] : [];
  $("#kFolH").textContent = hist.length > 1 ? `${hist[hist.length - 1].followers - hist[0].followers >= 0 ? "+" : ""}${fmt(hist[hist.length - 1].followers - hist[0].followers)} since ${hist[0].d}` : (acc ? "trend after the next refresh" : "all tracked accounts");
  barChart($("#chFormat"), groupBy(posts, p => formatOf(p.text)), FMT_ORDER);
  barChart($("#chLen"), groupBy(posts, p => lenOf(p.text)), LEN_ORDER);
  barChart($("#chDay"), byDay, DAYS);
  barChart($("#chHour"), groupBy(posts.filter(p => p.date), p => { const h = new Date(p.date).getHours(); return HOURS.find(x => h >= x[1] && h < x[2])[0]; }), HOURS.map(h => h[0]));
  const ranked = [...posts].sort((a, b) => eng(b) - eng(a));
  $("#topPosts").innerHTML = ranked.length ? ranked.slice(0, 5).map(p => postHTML(p, false)).join("") : '<p class="muted small">No posts in this range.</p>';
  $("#weakPosts").innerHTML = ranked.length > 10 ? ranked.slice(-5).reverse().map(p => postHTML(p, false)).join("") : '<p class="muted small">Needs more than 10 posts.</p>';
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
  const lines = esc(t).split("\n"); let out = "", inList = false;
  const inline = s => s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|\s)\*(.+?)\*(?=\s|$)/g, "$1<i>$2</i>");
  let quote = [];
  const flushQuote = () => { if (quote.length) { out += "<blockquote>" + quote.map(inline).join("\n") + "</blockquote>"; quote = []; } };
  for (const l of lines) {
    const q = l.match(/^\s*&gt;\s?(.*)/);
    if (q) { if (inList) { out += "</ul>"; inList = false; } quote.push(q[1]); continue; }
    flushQuote();
    const h = l.match(/^(#{1,4})\s+(.*)/), li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { if (!inList) { out += "<ul>"; inList = true; } out += "<li>" + inline(li[1]) + "</li>"; continue; }
    if (inList) { out += "</ul>"; inList = false; }
    if (h) out += (h[1].length === 1 ? "<h2>" : "<h3>") + inline(h[2]) + (h[1].length === 1 ? "</h2>" : "</h3>");
    else if (l.trim()) out += "<p>" + inline(l) + "</p>";
  }
  flushQuote();
  if (inList) out += "</ul>"; return out;
}
const brandName = k => ((S.index && S.index.brands || {})[k] || {}).name || k;
function renderReportList() {
  const rb = $("#repBrand"), ra = $("#repAccount");
  if (rb.value && S.index && S.index.accounts) {
    const mine = S.index.accounts.filter(a => (a.brands || []).includes(rb.value)).map(a => a.handle), cur = ra.value;
    ra.innerHTML = `<option value="">All ${esc(brandName(rb.value).split(" (")[0])}'s competitors</option>` + mine.map(h => `<option value="${esc(h)}">@${esc(h)}</option>`).join("");
    ra.value = mine.includes(cur) ? cur : "";
  } else if (ra.options.length && ra.options[0].textContent !== "All competitors") fillSelects();
  const acc = ra.value, br = rb.value, sc = $("#repScope").value;
  if (S.index && S.index.brands && rb.options.length < 2)
    rb.innerHTML = '<option value="">All ambassadors</option>' + Object.keys(S.index.brands).map(k => `<option value="${esc(k)}">${esc(brandName(k))}</option>`).join("");
  const scopeOf = r => r.scope || (r.accounts.length > 1 ? "all" : "single");
  const list = (S.index.reports || []).filter(r => (!acc || r.accounts.includes(acc)) && (!br || r.brand === br) && (!sc || scopeOf(r) === sc));
  $("#repList").innerHTML = list.length ? list.map((r, i) => `<div class="ins-item" data-path="${esc(r.path)}"><b>${esc(r.title)}</b> · ${r.accounts.map(a => "@" + esc(a)).join(", ")}<div class="small muted">${new Date(r.created).toLocaleString("en-GB", {day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"})} · for ${esc(brandName(r.brand))}${scopeOf(r) === "all" ? ' · <span class="tag">combined</span>' : ""}${r.requestedBy ? " · by " + esc(r.requestedBy) : ""}</div></div>`).join("") : '<p class="muted small">No reports match. Change the filters above or get a new report.</p>';
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
  pick.innerHTML = list.map(a => `<option value="${esc(a.handle)}">@${esc(a.handle)}${a.fullName ? " - " + esc(a.fullName) : ""}</option>`).join("") +
    '<option value="__new">+ Another account (paste a link)</option>';
  if ([...pick.options].some(o => o.value === cur)) pick.value = cur;
  const single = scope === "single";
  $("#runOne").classList.toggle("hidden", !single);
  $("#runUrl").classList.toggle("hidden", !(single && pick.value === "__new"));
  const info = $("#runAllInfo"); info.classList.toggle("hidden", single);
  if (!single) info.innerHTML = list.length
    ? `${scope === "all" ? "One report comparing" : "A separate report for each of"} ${name}'s ${list.length} competitor${list.length > 1 ? "s" : ""}: ${list.map(a => "@" + esc(a.handle)).join(", ")}. ` +
      `New posts are collected first. About $${scope === "all" ? "0.15-0.30" : (0.12 * list.length).toFixed(2) + "-" + (0.25 * list.length).toFixed(2)}.`
    : `${esc(name)} has no competitors yet. Use <b>Competitor search</b> on their Threads account, then <b>Track and analyze</b> a few accounts with "For: ${esc(name)}" selected.`;
  $("#runMax").classList.toggle("hidden", !single);
  $("#runComments").closest("label").classList.toggle("hidden", !single);
}
["#runBrand", "#runScope", "#runPick"].forEach(id => $(id).addEventListener("change", runFormUI));
window.addEventListener("tt-brands", runFormUI);

function prefillRun(handle, focus, skip) {
  goto("reports");
  $("#runScope").value = "single"; runFormUI();
  const has = [...$("#runPick").options].some(o => o.value === handle);
  $("#runPick").value = has ? handle : "__new";
  $("#runUrl").value = "https://www.threads.com/@" + handle;
  $("#runFocus").value = focus; $("#runSkip").checked = !!skip; runFormUI();
  $("#runCard").scrollIntoView({ behavior: "smooth" });
}

let running = false;
async function runReport() {
  if (running) return;
  const st = $("#runStatus"), scope = $("#runScope").value;
  const url = $("#runPick").value && $("#runPick").value !== "__new" ? "@" + $("#runPick").value : $("#runUrl").value.trim();
  if (scope === "single") {
    if (!url) { st.textContent = "Choose a competitor or paste a Threads profile link."; return; }
    if (!/^(https?:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]+|@?[A-Za-z0-9._]+)\/?(\?.*)?$/.test(url)) { st.textContent = "That doesn't look like a Threads profile link."; return; }
  } else if (!competitorsOf($("#runBrand").value).length) { st.innerHTML = $("#runAllInfo").innerHTML; return; }
  if (MODE === "token" && !memToken) { $("#tokBox").classList.remove("hidden"); st.textContent = "Connect GitHub first (one time only)."; return; }
  running = true; $("#runGo").disabled = true;
  const started = new Date(Date.now() - 30000).toISOString();
  try {
    st.textContent = "Starting...";
    await B.dispatch({ scope, profile_url: scope === "single" ? url : "", brand: $("#runBrand").value, focus: $("#runFocus").value, max_posts: $("#runMax").value,
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
$("#ghReport").addEventListener("click", () => setTimeout(() => { $("#runScope").value = "single"; $("#runPick").value = "__new"; runFormUI(); $("#runUrl").focus(); }, 450));
tokenUI();

const dataHooks = [];
window.TT = { prefillRun, $, esc, fmt, eng, median, allPosts, S, goto: t => goto(t), onData: fn => dataHooks.push(fn),
  md: t => md(t), B: () => B, mode: () => MODE, hasToken: () => !!memToken, sleep, getJSON, reloadData: () => reloadData() };
/* ---------- wiring ---------- */
function goto(tab) { $$("#nav button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab)); $$("main > section").forEach(s => s.classList.toggle("hidden", s.id !== "tab-" + tab)); hideTip(); }
$$("#nav button").forEach(b => b.onclick = () => goto(b.dataset.tab));
["#ovAccount", "#ovRange"].forEach(s => $(s).onchange = renderOverview);
$("#pSearch").oninput = () => { S.pLimit = 30; renderPosts(); }; $("#pAccount").onchange = $("#pSort").onchange = () => { S.pLimit = 30; renderPosts(); };
$("#pMore").onclick = () => { S.pLimit += 30; renderPosts(); };
$("#rSearch").oninput = () => { S.rLimit = 30; renderReplies(); }; $("#rAccount").onchange = () => { S.rLimit = 30; renderReplies(); };
$("#rMore").onclick = () => { S.rLimit += 30; renderReplies(); };
$("#repAccount").onchange = renderReportList; $("#repBrand").onchange = renderReportList; $("#repScope").onchange = renderReportList;

const gh = repoUrl();
if (gh) $("#ghRepo").href = gh;
$("#ghReport").onclick = e => { e.preventDefault(); goto("reports"); $("#runCard").scrollIntoView({ behavior: "smooth" }); setTimeout(() => $("#runUrl").focus(), 400); };

async function reloadData() {
  S.index = await getJSON("data/index.json"); S.accounts = {};
  await Promise.all(S.index.accounts.filter(a => a.posts || a.replies).map(async a => { try { S.accounts[a.handle] = await getJSON(`data/accounts/${a.handle}.json`); } catch (e) {} }));
  fillSelects(); renderOverview(); renderPosts(); renderReplies(); renderCompare(); renderReportList(); runFormUI();
  dataHooks.forEach(f => { try { f(); } catch (e) { console.error(e); } });
}
(async function loadBrands() {
  try {
    let brands;
    try { brands = await getJSON("config/brands.json"); } catch (e) { brands = (await getJSON("data/index.json")).brands; }
    $$(".brand-select").forEach(sel => {
      const cur = sel.value;
      sel.innerHTML = Object.entries(brands).map(([k, b]) => `<option value="${esc(k)}">For: ${esc(b.name)}</option>`).join("");
      if (brands[cur]) sel.value = cur;
    });
    window.dispatchEvent(new Event("tt-brands"));
  } catch (e) {}
})();
(async function load() {
  try {
    S.index = await getJSON("data/index.json");
    await Promise.all(S.index.accounts.filter(a => a.posts || a.replies).map(async a => { try { S.accounts[a.handle] = await getJSON(`data/accounts/${a.handle}.json`); } catch (e) {} }));
    $("#updated").textContent = "Data updated " + new Date(S.index.updated).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const u = S.index.usage;
    if (u && u.budget) $("#updated").textContent += ` · Spent this month $${Number(u.spent || 0).toFixed(2)} of $${u.budget}`;
    fillSelects(); renderOverview(); renderPosts(); renderReplies(); renderCompare(); renderReportList(); runFormUI();
    dataHooks.forEach(f => { try { f(); } catch (e) { console.error(e); } });
    if (!Object.keys(S.accounts).length) $("#loadMsg").textContent = "No data yet. Run \"Get report\" in GitHub Actions to collect the first account.";
    else $("#loadMsg").classList.add("hidden");
  } catch (e) {
    $("#loadMsg").textContent = "Couldn't load data/index.json. If you opened this file directly from your computer, use the GitHub Pages link instead.";
  }
})();
})();
