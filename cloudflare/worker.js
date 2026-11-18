/**
 * Threads Competitor Tracker - Cloudflare Worker
 *
 * What it does:
 *  - Serves the dashboard (index.html, scripts, data, reports) straight from the GitHub repository,
 *    so the repository can be private.
 *  - Lets signed-in people start reports with POST /api/run - nobody needs a GitHub token.
 *
 * Sign-in is handled by Cloudflare Access (email one-time code) in front of this Worker.
 * The Worker refuses every request that didn't come through Access.
 *
 * Settings (Worker → Settings → Variables and Secrets):
 *   GITHUB_TOKEN  (Secret)  fine-grained token for this one repository:
 *                           Actions: Read and write, Contents: Read-only
 *   REPO          (Text)    vladasidlyak/threads-tracker
 *   BRANCH        (Text)    main            (optional)
 *   MAX_RUNS_PER_DAY (Text) 20              (optional safety limit per person)
 *   TEAM_DOMAIN   (Text)    your-team.cloudflareaccess.com   (Zero Trust → Settings → Team name)
 *   POLICY_AUD    (Text)    Access application's "Application Audience (AUD) Tag"
 *
 * TEAM_DOMAIN and POLICY_AUD let the Worker check Cloudflare's signature on every request,
 * so nobody can pretend to be signed in.
 *
 * Simpler alternative without Cloudflare Access - a shared team password:
 *   TEAM_PASSWORD (Secret)  the password colleagues type on the login page
 * If TEAM_PASSWORD is set and Access isn't, people see a login page (name + password)
 * and stay signed in for 30 days on that browser.
 */

const ALLOWED_FILES = /^(config\/brands\.json|index\.html|dashboard\.js|voice\.js|competitors\.js|plan\.js|data\/[\w.\-\/]+\.json|reports\/[\w.\-\/]+\.(md|json))$/;
const TYPES = { html: "text/html", js: "application/javascript", json: "application/json", md: "text/markdown" };
const BRAND_RE = /^[a-z0-9_-]{1,30}$/; // brands live in config/brands.json; the scripts check the name
const FOCUS = ["full", "ideas", "replies", "voice"];
const WORKFLOWS = { report: "report.yml", competitors: "competitors.yml", plan: "plan.yml" };
const PROFILE_RE = /^(https?:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]+\/?(\?.*)?|@?[A-Za-z0-9._]{1,40})$/;
const runsToday = new Map(); // best-effort, per Worker instance

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    let email = null;
    if (jwt && env.TEAM_DOMAIN && env.POLICY_AUD) {
      email = await verifyAccess(jwt, env);
      if (!email) return text("Your sign-in couldn't be verified. Close the tab and open the link again.", 403);
    } else if (env.TEAM_PASSWORD) {
      if (url.pathname === "/login") return request.method === "POST" ? await doLogin(request, env) : loginPage();
      if (url.pathname === "/logout") return new Response(null, { status: 302, headers: { Location: "/login", "Set-Cookie": cookie("", 0) } });
      email = await readSession(request, env);
      if (!email) {
        if (url.pathname.startsWith("/api/")) return json({ error: "Please sign in again." }, 401);
        return new Response(null, { status: 302, headers: { Location: "/login" } });
      }
      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return json({ error: "Blocked." }, 403);
      }
    } else if (jwt) {
      return text("The Worker is missing TEAM_DOMAIN or POLICY_AUD in its settings.", 500);
    } else {
      return text("Sign-in is not set up yet. Add TEAM_PASSWORD in the Worker's settings, or protect it with Cloudflare Access.", 401);
    }
    if (!env.GITHUB_TOKEN || !env.REPO) return text("The Worker is missing GITHUB_TOKEN or REPO in its settings.", 500);

    try {
      if (url.pathname === "/api/me") return json({ email, logout: !!env.TEAM_PASSWORD && !jwt });
      if (url.pathname === "/api/run" && request.method === "POST") return await startRun(request, env, email);
      if (url.pathname === "/api/runs") return await findRun(url, env);
      const m = url.pathname.match(/^\/api\/runs\/(\d+)$/);
      if (m) return await runStatus(m[1], env);
      return await serveFile(url.pathname, env);
    } catch (e) {
      return json({ error: "Something went wrong talking to GitHub. Try again in a minute." }, 502);
    }
  },
};

/* ---- Shared-password login ---- */
const SESSION_DAYS = 30;
const attempts = new Map(); // ip -> [count, windowStart], best effort
const enc = new TextEncoder();
const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode("tt-session:" + env.TEAM_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64e(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const cookie = (v, maxAge) => `tt_session=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function readSession(request, env) {
  const m = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)tt_session=([^;]+)/);
  if (!m) return null;
  const [data, sig] = m[1].split(".");
  if (!data || !sig || !safeEqual(sig, await hmac(env, data))) return null;
  let s; try { s = JSON.parse(new TextDecoder().decode(b64u(data))); } catch { return null; }
  return s.exp > Date.now() ? s.name : null;
}
async function doLogin(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "?";
  const a = attempts.get(ip) || [0, Date.now()];
  if (Date.now() - a[1] > 15 * 60e3) { a[0] = 0; a[1] = Date.now(); }
  if (a[0] >= 10) return loginPage("Too many attempts. Wait 15 minutes and try again.", 429);
  const f = await request.formData();
  const name = String(f.get("name") || "").trim().replace(/[<>"]/g, "").slice(0, 60);
  const pw = String(f.get("password") || "");
  if (!name) return loginPage("Please enter your name.", 400);
  if (!safeEqual(enc.encode(pw).join(","), enc.encode(env.TEAM_PASSWORD).join(","))) {
    a[0]++; attempts.set(ip, a);
    return loginPage("Wrong password.", 401);
  }
  attempts.delete(ip);
  const data = b64e(enc.encode(JSON.stringify({ name, exp: Date.now() + SESSION_DAYS * 864e5 })));
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie(data + "." + await hmac(env, data), SESSION_DAYS * 86400) } });
}
function loginPage(msg = "", status = 200) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Threads Competitor Tracker</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f6f4;color:#0b0b0b}
@media(prefers-color-scheme:dark){body{background:#121211;color:#f0efec}.box{background:#1f1f1e!important;border-color:#33332f!important}input{background:#1a1a19!important;color:#f0efec!important;border-color:#33332f!important}}
.box{background:#fff;border:1px solid #e4e3df;border-radius:14px;padding:28px;width:100%;max-width:340px;margin:16px}
h1{font-size:19px;margin:0 0 4px}p{margin:0 0 18px;color:#8a8984;font-size:13px}label{display:block;font-size:13px;margin:12px 0 4px;color:#52514e}
input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid #e4e3df;border-radius:9px;background:#fcfcfb}
button{width:100%;margin-top:18px;padding:11px;border:0;border-radius:9px;background:#2a78d6;color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#d03b3b;font-size:13px;margin-top:12px}</style></head><body>
<form class="box" method="POST" action="/login"><h1>Threads Competitor Tracker</h1><p>Sign in with the team password.</p>
<label for="n">Your name</label><input id="n" name="name" autocomplete="name" required maxlength="60">
<label for="p">Team password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>${msg ? `<div class="err">${msg}</div>` : ""}</form></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/* ---- Cloudflare Access signature check (RS256 JWT) ---- */
let certCache = { at: 0, keys: [] };
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
async function verifyAccess(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); payload = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch { return null; }
  const team = "https://" + env.TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== team || !aud.includes(env.POLICY_AUD) || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (Date.now() - certCache.at > 3600e3) {
    const r = await fetch(team + "/cdn-cgi/access/certs");
    if (!r.ok) return null;
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  return ok ? (payload.email || payload.common_name || "signed-in user") : null;
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: init.accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "threads-tracker-worker",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function serveFile(pathname, env) {
  let path = decodeURIComponent(pathname.replace(/^\/+/, "")) || "index.html";
  if (path.includes("..") || !ALLOWED_FILES.test(path)) return text("Not found", 404);
  const cache = caches.default;
  const key = new Request(`https://cache.local/${env.REPO}/${path}`);
  let res = await cache.match(key);
  if (!res) {
    const r = await gh(env, `/contents/${path}?ref=${env.BRANCH || "main"}`, { accept: "application/vnd.github.raw" });
    if (r.status === 404) return text("Not found", 404);
    if (!r.ok) return text("Couldn't load from GitHub (" + r.status + "). Check the Worker's GITHUB_TOKEN.", 502);
    const ext = path.split(".").pop();
    res = new Response(await r.arrayBuffer(), {
      headers: { "Content-Type": `${TYPES[ext] || "text/plain"}; charset=utf-8`, "Cache-Control": "private, max-age=30" },
    });
    await cache.put(key, res.clone());
  }
  return res;
}

async function startRun(request, env, email) {
  let b;
  try { b = await request.json(); } catch { return json({ error: "Bad request." }, 400); }
  const wf = b.workflow || "report";
  if (!WORKFLOWS[wf]) return json({ error: "Unknown action." }, 400);
  let inputs;
  if (wf === "report") {
    const scope = String(b.scope || "single");
    if (!["single", "all", "each"].includes(scope)) return json({ error: "Bad form values." }, 400);
    const url = scope === "single" ? String(b.profile_url || "").trim() : "";
    if (scope === "single" && !PROFILE_RE.test(url)) return json({ error: "That doesn't look like a Threads profile link." }, 400);
    if (!BRAND_RE.test(String(b.brand)) || !FOCUS.includes(b.focus) || !["30", "60", "100"].includes(String(b.max_posts)))
      return json({ error: "Bad form values." }, 400);
    inputs = { scope, profile_url: url, brand: b.brand, focus: b.focus, max_posts: String(b.max_posts),
               include_comments: !!b.include_comments, skip_collect: !!b.skip_collect, model: b.model === "economy" ? "economy" : "standard", requested_by: email };
  } else if (wf === "plan") {
    if (!BRAND_RE.test(String(b.brand)) || !["1", "2", "4", "6", "8"].includes(String(b.weeks)) || !["2", "3", "4", "5", "7", "14", "21", "28", "35", "42", "49", "56", "63", "70"].includes(String(b.per_week)))
      return json({ error: "Bad form values." }, 400);
    const start = String(b.start || "");
    if (start && !/^\d{4}-\d{2}-\d{2}$/.test(start)) return json({ error: "Bad start date." }, 400);
    inputs = { brand: b.brand, weeks: String(b.weeks), per_week: String(b.per_week), start, accounts: String(b.accounts || "").slice(0, 300), model: b.model === "economy" ? "economy" : "standard", requested_by: email };
  } else {
    const url = String(b.target_url || "").trim();
    if (!PROFILE_RE.test(url)) return json({ error: "That doesn't look like a Threads profile link." }, 400);
    if (!["1000", "5000", "10000", "30000"].includes(String(b.min_followers))) return json({ error: "Bad form values." }, 400);
    inputs = { target_url: url, min_followers: String(b.min_followers), keywords: String(b.keywords || "").slice(0, 200), requested_by: email };
  }

  const day = new Date().toISOString().slice(0, 10), k = day + "|" + email;
  const limit = parseInt(env.MAX_RUNS_PER_DAY || "20", 10);
  if ((runsToday.get(k) || 0) >= limit) return json({ error: `Daily limit of ${limit} reports reached for ${email}.` }, 429);

  const r = await gh(env, `/actions/workflows/${WORKFLOWS[wf]}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: env.BRANCH || "main", inputs }),
  });
  if (!r.ok) return json({ error: "GitHub refused to start the run (" + r.status + "). Check the Worker's token permissions." }, 502);
  runsToday.set(k, (runsToday.get(k) || 0) + 1);
  return json({ ok: true });
}

async function findRun(url, env) {
  const since = url.searchParams.get("since") || new Date(Date.now() - 60000).toISOString();
  const wf = WORKFLOWS[url.searchParams.get("workflow") || "report"] || "report.yml";
  const r = await gh(env, `/actions/workflows/${wf}/runs?per_page=5&event=workflow_dispatch&created=%3E%3D${encodeURIComponent(since)}`);
  if (!r.ok) return json({ run: null });
  const d = await r.json();
  return json({ run: slim((d.workflow_runs || [])[0]) });
}

async function runStatus(id, env) {
  const r = await gh(env, `/actions/runs/${id}`);
  if (!r.ok) return json({ error: "Run not found." }, 404);
  return json({ run: slim(await r.json()) });
}

const slim = run => run ? { id: run.id, status: run.status, conclusion: run.conclusion, html_url: run.html_url } : null;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const text = (t, status = 200) => new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
