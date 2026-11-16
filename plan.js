/* Threads Competitor Tracker - Content plan tab: action steps, calendar, table, downloads. */
(function () {
"use strict";
const TT = window.TT; if (!TT) return;
const { $, esc } = TT;
let plan = null, view = "calendar", busy = false;
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/* ---------- downloads ---------- */
function download(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
const csvCell = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
function planCSV(p) {
  const cols = ["Post", "Date", "Time", "Status", "Pillar", "Format", "Hook", "Hook (EN)", "Draft", "Draft (EN)", "CTA", "Inspiration", "Why"];
  const rows = p.posts.map(x => [x.topic || x.hook, x.date, x.time, "Idea", x.pillar, x.format, x.hook, x.hook_en, x.draft, x.draft_en, x.cta, x.inspiration, x.why]);
  return "﻿" + [cols, ...rows].map(r => r.map(csvCell).join(",")).join("\r\n");
}
function actionsCSV(p) {
  const cols = ["Action", "Priority", "Effort", "Why", "How", "Done"];
  return "﻿" + [cols, ...p.actions.map(a => [a.title, a.priority, a.effort, a.why, a.how, "No"])].map(r => r.map(csvCell).join(",")).join("\r\n");
}
function planMD(p) {
  const L = [`# ${p.title}`, "", `Based on: ${p.basedOn.map(h => "@" + h).join(", ")} · ${p.weeks} weeks · ${p.perWeek} posts a week`, "", "## Strategy", p.summary || "", "",
    "## Content pillars", ...(p.pillars || []).map(x => `- **${x.name}** (${x.share}): ${x.why}`), "",
    "## Action steps", ...p.actions.map(a => `- [ ] **${a.title}** (${a.priority}, ${a.effort})\n  - Why: ${a.why}\n  - How: ${a.how}`), "",
    "## Posts"];
  p.posts.forEach(x => L.push("", `### ${x.date} ${x.time} · ${x.format} · ${x.pillar}`, `**${x.topic}**`, "", x.draft.split("\n").map(l => "> " + l).join("\n"), x.draft_en ? `\n*EN: ${x.draft_en}*` : "",
    "", x.cta ? `CTA: ${x.cta}` : "", `Inspiration: ${x.inspiration}`, `Why: ${x.why}`));
  return L.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}

/* ---------- action checkboxes (remembered in this browser) ---------- */
const doneKey = () => "tt_done_" + plan.id;
function getDone() { try { return JSON.parse(localStorage.getItem(doneKey()) || "[]"); } catch (e) { return []; } }
function setDone(v) { try { localStorage.setItem(doneKey(), JSON.stringify(v)); } catch (e) {} }

/* ---------- views ---------- */
function postDetail(x) {
  return `<div class="post"><div class="meta"><b>${esc(new Date(x.date + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }))} · ${esc(x.time)}</b><span class="tag">${esc(x.format)}</span><span class="tag">${esc(x.pillar)}</span></div>
    <div style="font-weight:600;margin-bottom:4px">${esc(x.topic)}</div>
    <div class="parent" style="white-space:pre-wrap">${esc(x.draft)}${x.draft_en ? `<div class="en">EN: ${esc(x.draft_en)}</div>` : ""}</div>
    ${x.cta ? `<div class="small"><b>Invite replies:</b> ${esc(x.cta)}</div>` : ""}
    <div class="small muted"><b>Inspired by:</b> ${esc(x.inspiration)}</div><div class="small muted"><b>Why:</b> ${esc(x.why)}</div>
    <div class="row" style="margin-top:6px"><button class="btn" type="button" data-copy="${esc(x.draft)}" style="padding:4px 10px;font-size:12px">Copy draft</button></div></div>`;
}
function calendar(p) {
  const byDay = {}; p.posts.forEach(x => (byDay[x.date] = byDay[x.date] || []).push(x));
  const first = new Date(p.posts[0].date + "T12:00"), last = new Date(p.posts[p.posts.length - 1].date + "T12:00");
  let html = "", m = new Date(first.getFullYear(), first.getMonth(), 1);
  while (m <= last) {
    const y = m.getFullYear(), mo = m.getMonth(), lead = (new Date(y, mo, 1).getDay() + 6) % 7, days = new Date(y, mo + 1, 0).getDate();
    html += `<h3 style="margin:14px 0 8px;font-size:15px">${MONTHS[mo]} ${y}</h3><div class="cal"><div class="cal-h">Mon</div><div class="cal-h">Tue</div><div class="cal-h">Wed</div><div class="cal-h">Thu</div><div class="cal-h">Fri</div><div class="cal-h">Sat</div><div class="cal-h">Sun</div>`;
    for (let i = 0; i < lead; i++) html += '<div class="cal-d empty"></div>';
    for (let d = 1; d <= days; d++) {
      const iso = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`, items = byDay[iso] || [];
      html += `<div class="cal-d${items.length ? " has" : ""}"><div class="cal-n">${d}</div>${items.map(x => `<button type="button" class="cal-i" data-post="${esc(p.posts.indexOf(x))}" title="${esc(x.topic)}"><b>${esc(x.time)}</b> ${esc(x.topic)}</button>`).join("")}</div>`;
    }
    html += "</div>";
    m = new Date(y, mo + 1, 1);
  }
  return html + '<div id="plDetail" style="margin-top:12px"></div>';
}
function table(p) {
  return `<div class="scroll"><table><tr><th>Date</th><th>Time</th><th>Pillar</th><th>Format</th><th>Topic and hook</th><th>Inspired by</th></tr>${p.posts.map((x, i) =>
    `<tr class="pl-row" data-post="${i}" style="cursor:pointer"><td style="white-space:nowrap">${esc(new Date(x.date + "T12:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }))}</td><td>${esc(x.time)}</td><td>${esc(x.pillar)}</td><td>${esc(x.format)}</td><td><b>${esc(x.topic)}</b><br><span class="muted">${esc(x.hook)}</span>${x.hook_en ? `<br><i class="small muted">EN: ${esc(x.hook_en)}</i>` : ""}</td><td class="small">${esc(x.inspiration)}</td></tr>`).join("")}</table></div><p class="small muted">Tap a row to see the full draft.</p><div id="plDetail"></div>`;
}

function render() {
  const box = $("#plBody");
  if (!plan) { box.innerHTML = '<div class="card empty">No content plans yet. Choose the brand and click Create plan.</div>'; return; }
  const p = plan, done = getDone();
  box.innerHTML = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="flex:1 1 220px;min-width:0"><h2 style="margin:0">${esc(p.title)}</h2>
      <p class="sub" style="margin:4px 0 0">Based on ${p.basedOn.map(h => "@" + esc(h)).join(", ")} · ${p.posts.length} posts over ${p.weeks} week${p.weeks > 1 ? "s" : ""}${p.requestedBy ? " · by " + esc(p.requestedBy) : ""}</p></div>
      <div class="row no-print">
        ${p.notionUrl ? `<a class="btn" href="${esc(p.notionUrl)}" target="_blank" rel="noopener" style="text-decoration:none">Open in Notion</a>` : ""}
        <button class="btn" type="button" id="dlCsv">Notion / Excel CSV</button>
        <button class="btn" type="button" id="dlMd">Markdown</button>
        <button class="btn" type="button" id="dlPrint">Print / PDF</button>
      </div>
    </div>
    <p style="margin:12px 0 8px">${esc(p.summary || "")}</p>
    <div class="chips">${(p.pillars || []).map(x => `<span class="chip" style="padding:5px 12px" title="${esc(x.why)}"><b>${esc(x.name)}</b>&nbsp;<span class="muted small">${esc(x.share)}</span></span>`).join("")}</div>
  </div>
  <div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">Action steps</h2><span class="small muted no-print">${done.length} of ${p.actions.length} done · <a href="#" id="dlActions">download as CSV</a></span></div>
    <p class="sub">What to change, based on the competitor data. Tick them off as you go (saved in this browser).</p>
    ${p.actions.map((a, i) => `<label class="act"><input type="checkbox" data-act="${i}" ${done.includes(i) ? "checked" : ""}><div><div><b>${esc(a.title)}</b> <span class="tag">${esc(a.priority)}</span> <span class="tag">${esc(a.effort)}</span></div><div class="small"><b>Why:</b> ${esc(a.why)}</div><div class="small"><b>How:</b> ${esc(a.how)}</div></div></label>`).join("")}
  </div>
  <div class="card">
    <div class="row no-print" style="justify-content:space-between;margin-bottom:6px"><h2 style="margin:0">Posts</h2>
      <div class="seg"><button type="button" data-view="calendar" class="${view === "calendar" ? "on" : ""}">Calendar</button><button type="button" data-view="table" class="${view === "table" ? "on" : ""}">Table</button><button type="button" data-view="list" class="${view === "list" ? "on" : ""}">All drafts</button></div></div>
    <div id="plView">${view === "calendar" ? calendar(p) : view === "table" ? table(p) : p.posts.map(postDetail).join("")}</div>
    <div class="print-only">${p.posts.map(postDetail).join("")}</div>
  </div>`;
  const slug = p.title.replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-");
  $("#dlCsv").onclick = () => download(slug + ".csv", planCSV(p), "text/csv;charset=utf-8");
  $("#dlMd").onclick = () => download(slug + ".md", planMD(p), "text/markdown;charset=utf-8");
  $("#dlPrint").onclick = () => { document.body.classList.add("printing-plan"); window.print(); setTimeout(() => document.body.classList.remove("printing-plan"), 500); };
  $("#dlActions").onclick = e => { e.preventDefault(); download(slug.replace("Content-plan", "Action-steps") + ".csv", actionsCSV(p), "text/csv;charset=utf-8"); };
  box.querySelectorAll("[data-act]").forEach(c => c.onchange = () => { const d = new Set(getDone()); c.checked ? d.add(+c.dataset.act) : d.delete(+c.dataset.act); setDone([...d]); render(); });
  box.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { view = b.dataset.view; render(); });
  box.querySelectorAll("[data-post]").forEach(el => el.onclick = () => { const d = $("#plDetail"); if (d) { d.innerHTML = postDetail(p.posts[+el.dataset.post]); wireCopy(d); d.scrollIntoView({ behavior: "smooth", block: "nearest" }); } });
  wireCopy(box);
}
function wireCopy(root) {
  root.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; } catch (e) { b.textContent = "Copy blocked"; } setTimeout(() => b.textContent = "Copy draft", 1500); });
}

async function loadList(select) {
  const list = (TT.S.index && TT.S.index.plans) || [], el = $("#plPick"), cur = el.value;
  el.innerHTML = list.map(e => `<option value="${esc(e.path)}">${esc(e.title)}</option>`).join("");
  el.classList.toggle("hidden", list.length < 2);
  const path = select || (list.some(e => e.path === cur) ? cur : list[0] && list[0].path);
  if (path) { el.value = path; try { plan = await TT.getJSON(path); plan.posts.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""))); } catch (e) { plan = null; } } else plan = null;
  render();
}

async function create() {
  if (busy) return;
  const st = $("#plStatus");
  if (TT.mode() === "token" && !TT.hasToken()) { TT.goto("reports"); $("#tokBox").classList.remove("hidden"); $("#runCard").scrollIntoView({ behavior: "smooth" }); $("#tokStatus").textContent = "Connect GitHub first (one time only), then go back to Content plan."; return; }
  if (!Object.keys(TT.S.accounts).length) { st.textContent = "Track at least one competitor first."; return; }
  busy = true; $("#plGo").disabled = true;
  const B = TT.B(), started = new Date(Date.now() - 30000).toISOString();
  try {
    st.textContent = "Starting...";
    await B.dispatch({ brand: $("#plBrand").value, weeks: $("#plWeeks").value, per_week: $("#plPer").value, start: $("#plStart").value || "", accounts: "" }, "plan");
    let run = null;
    for (let i = 0; i < 12 && !run; i++) { await TT.sleep(5000); run = await B.find(started, "plan"); }
    if (!run) throw new Error("The plan started but I couldn't find it. Check the Actions tab on GitHub.");
    const link = ` <a href="${esc(run.html_url)}" target="_blank" rel="noopener">View on GitHub</a>`, t0 = Date.now();
    while (run.status !== "completed") {
      if (Date.now() - t0 > 20 * 60e3) throw new Error("This is taking over 20 minutes. Check the run on GitHub.");
      st.innerHTML = `Reading the research and writing the plan... ${Math.round((Date.now() - t0) / 1000)}s.` + link;
      await TT.sleep(10000); const nr = await B.status(run.id); if (nr) run = nr;
    }
    if (run.conclusion !== "success") { st.innerHTML = "Creating the plan failed. Open it to see why." + link; return; }
    st.innerHTML = "Done. Loading the plan..." + link;
    const before = ((TT.S.index && TT.S.index.plans) || []).length;
    for (let i = 0; i < 24; i++) {
      await TT.sleep(10000);
      try { const idx = await TT.getJSON("data/index.json"); if ((idx.plans || []).length > before) { await TT.reloadData(); await loadList(idx.plans[0].path); st.innerHTML = "Done." + link; return; } } catch (e) {}
    }
    st.innerHTML = "Done. Still publishing - refresh this page in a minute." + link;
  } catch (e) { st.textContent = e.message || "Something went wrong."; }
  finally { busy = false; $("#plGo").disabled = false; }
}

$("#plGo").onclick = create;
$("#plPick").onchange = () => loadList($("#plPick").value);
TT.onData(() => loadList());
})();
