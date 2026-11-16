/* Threads Competitor Tracker - Competitors tab: find 10 benchmark accounts for a target account. */
(function () {
"use strict";
const TT = window.TT; if (!TT) return;
const { $, esc, fmt } = TT;
let current = null, busy = false;

function card(c, i) {
  const last = c.daysSinceLastPost == null ? "no recent posts" : c.daysSinceLastPost <= 1 ? "posted today" : `last post ${c.daysSinceLastPost} days ago`;
  return `<div class="post">
    <div class="meta"><b style="font-size:15px">${i + 1}. <a href="https://www.threads.com/@${esc(c.handle)}" target="_blank" rel="noopener">@${esc(c.handle)}</a></b>${c.verified ? '<span class="tag">verified</span>' : ""}${c.alreadyTracked ? '<span class="tag">tracked</span>' : ""}${c.active ? "" : '<span class="tag">inactive</span>'}<span class="muted">${esc(c.fullName || "")}</span></div>
    ${c.reason ? `<div class="txt" style="margin:4px 0 6px">${esc(c.reason)}</div>` : ""}
    <div class="stats"><span><b>${fmt(c.followers)}</b> followers</span><span><b>${c.engagementRate}%</b> eng. rate</span><span>median ${fmt(c.medianEngagement)} per post</span><span>${c.postsLast30d} posts / 30 days · ${last}</span><span>match ${c.score}/100</span></div>
    ${c.bio ? `<div class="small muted" style="margin-top:6px">${esc(c.bio)}</div>` : ""}
    ${c.topPost && c.topPost.text ? `<div class="parent" style="margin-top:8px"><span class="small muted">Best recent post (${fmt(c.topPost.engagement)} engagement):</span><br>${esc(c.topPost.text)}</div>` : ""}
    <div class="row" style="margin-top:8px">${c.alreadyTracked ? '<span class="small muted">Already in the monthly refresh.</span>' : `<button class="btn" type="button" data-track="${esc(c.handle)}">Track and analyze</button>`}</div>
  </div>`;
}

function render() {
  const box = $("#coBody");
  if (!current) { box.innerHTML = '<div class="card empty">No competitor searches yet. Enter your account above and click Find competitors.</div>'; return; }
  const o = current;
  box.innerHTML = `
  <div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Top ${o.competitors.length} for @${esc(o.target)}</h2><span class="small muted">${new Date(o.created).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${o.requestedBy ? " · by " + esc(o.requestedBy) : ""}</span></div>
    <p class="sub">Searched for: ${o.keywords.map(k => `<span class="tag">${esc(k)}</span>`).join(" ")} · language ${esc(o.language)} · ${o.stats.found} accounts found, ${o.stats.afterFilters} passed the filters (${fmt(o.minFollowers)}+ followers, same language), ${o.stats.lookedUp} checked in detail.<br>
    Ranked by topic match with @${esc(o.target)}, engagement rate on their 10 latest posts and recent activity.</p>
    ${o.competitors.map(card).join("")}
  </div>
  ${o.others && o.others.length ? `<div class="card"><h2>Also considered</h2><div class="scroll"><table><tr><th>Account</th><th class="n">Followers</th><th class="n">Eng. rate</th><th class="n">Posts / 30d</th><th class="n">Match</th><th></th></tr>${o.others.map(c => `<tr><td><a href="https://www.threads.com/@${esc(c.handle)}" target="_blank" rel="noopener">@${esc(c.handle)}</a></td><td class="n">${fmt(c.followers)}</td><td class="n">${c.engagementRate}%</td><td class="n">${c.postsLast30d}</td><td class="n">${c.score}</td><td>${c.alreadyTracked ? "" : `<button class="btn" type="button" data-track="${esc(c.handle)}" style="padding:4px 8px;font-size:12px">Track</button>`}</td></tr>`).join("")}</table></div></div>` : ""}`;
  box.querySelectorAll("[data-track]").forEach(b => b.onclick = () => {
    TT.goto("reports"); $("#runUrl").value = "https://www.threads.com/@" + b.dataset.track; $("#runFocus").value = "full"; $("#runSkip").checked = false;
    $("#runCard").scrollIntoView({ behavior: "smooth" });
    $("#runStatus").textContent = `Ready: @${b.dataset.track}. Choose the brand and click Run - it collects their posts, adds them to the monthly refresh and writes a report.`;
  });
}

async function loadList(select) {
  const list = (TT.S.index && TT.S.index.competitors) || [];
  const el = $("#coPick"), cur = el.value;
  el.innerHTML = list.length ? list.map(e => `<option value="${esc(e.path)}">@${esc(e.target)}</option>`).join("") : '<option value="">No searches yet</option>';
  el.classList.toggle("hidden", list.length < 2);
  const path = select || (list.some(e => e.path === cur) ? cur : list[0] && list[0].path);
  if (path) { el.value = path; try { current = await TT.getJSON(path); } catch (e) { current = null; } } else current = null;
  render();
}

async function find() {
  if (busy) return;
  const st = $("#coStatus"), url = $("#coUrl").value.trim();
  if (!/^(https?:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]+|@?[A-Za-z0-9._]+)\/?(\?.*)?$/.test(url)) { st.textContent = "Paste your Threads profile link or @handle."; return; }
  if (TT.mode() === "token" && !TT.hasToken()) { TT.goto("reports"); $("#tokBox").classList.remove("hidden"); $("#runCard").scrollIntoView({ behavior: "smooth" }); $("#tokStatus").textContent = "Connect GitHub first (one time only), then go back to Competitor search."; return; }
  busy = true; $("#coGo").disabled = true;
  const B = TT.B(), started = new Date(Date.now() - 30000).toISOString();
  try {
    st.textContent = "Starting...";
    await B.dispatch({ target_url: url, min_followers: $("#coMin").value, keywords: $("#coKw").value.trim() }, "competitors");
    let run = null;
    for (let i = 0; i < 12 && !run; i++) { await TT.sleep(5000); run = await B.find(started, "competitors"); }
    if (!run) throw new Error("The search started but I couldn't find it. Check the Actions tab on GitHub.");
    const link = ` <a href="${esc(run.html_url)}" target="_blank" rel="noopener">View on GitHub</a>`;
    const t0 = Date.now(), steps = ["Reading your account", "Choosing search terms", "Searching Threads for similar accounts", "Checking their latest posts", "Ranking and writing reasons"];
    while (run.status !== "completed") {
      if (Date.now() - t0 > 25 * 60e3) throw new Error("This is taking over 25 minutes. Check the run on GitHub.");
      st.innerHTML = `${steps[Math.min(steps.length - 1, Math.floor((Date.now() - t0) / 40000))]}... ${Math.round((Date.now() - t0) / 1000)}s.` + link;
      await TT.sleep(10000);
      const nr = await B.status(run.id); if (nr) run = nr;
    }
    if (run.conclusion !== "success") { st.innerHTML = "The search failed. Open it to see why (the last lines explain the problem)." + link; return; }
    st.innerHTML = "Done. Loading results..." + link;
    const h = url.replace(/.*@/, "").replace(/[/?].*$/, "").toLowerCase();
    for (let i = 0; i < 24; i++) {
      await TT.sleep(10000);
      try { const o = await TT.getJSON(`data/competitors/${h}.json`); if (new Date(o.created) > new Date(started)) { await TT.reloadData(); await loadList(`data/competitors/${h}.json`); st.innerHTML = "Done." + link; return; } } catch (e) {}
    }
    st.innerHTML = "Done. Still publishing - refresh this page in a minute." + link;
  } catch (e) { st.textContent = e.message || "Something went wrong."; }
  finally { busy = false; $("#coGo").disabled = false; }
}

$("#coGo").onclick = find;
$("#coUrl").onkeydown = e => { if (e.key === "Enter") find(); };
$("#coPick").onchange = () => loadList($("#coPick").value);
TT.onData(() => loadList());
})();
