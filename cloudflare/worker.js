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
 */

const ALLOWED_FILES = /^(index\.html|dashboard\.js|voice\.js|data\/[\w.\-\/]+\.json|reports\/[\w.\-\/]+\.(md|json))$/;
const TYPES = { html: "text/html", js: "application/javascript", json: "application/json", md: "text/markdown" };
const BRANDS = ["ines", "liven", "overwell"];
const FOCUS = ["full", "ideas", "replies", "voice"];
const runsToday = new Map(); // best-effort, per Worker instance

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!jwt) return text("Sign-in is not set up yet. In Cloudflare, open this Worker and protect it behind Cloudflare Access.", 401);
    if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return text("The Worker is missing TEAM_DOMAIN or POLICY_AUD in its settings.", 500);
    const email = await verifyAccess(jwt, env);
    if (!email) return text("Your sign-in couldn't be verified. Close the tab and open the link again.", 403);
    if (!env.GITHUB_TOKEN || !env.REPO) return text("The Worker is missing GITHUB_TOKEN or REPO in its settings.", 500);

    try {
      if (url.pathname === "/api/me") return json({ email });
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
  const url = String(b.profile_url || "").trim();
  if (!/^(https?:\/\/(www\.)?threads\.(com|net)\/@[A-Za-z0-9._]+\/?(\?.*)?|@?[A-Za-z0-9._]{1,40})$/.test(url))
    return json({ error: "That doesn't look like a Threads profile link." }, 400);
  if (!BRANDS.includes(b.brand) || !FOCUS.includes(b.focus) || !["30", "60", "100"].includes(String(b.max_posts)))
    return json({ error: "Bad form values." }, 400);

  const day = new Date().toISOString().slice(0, 10), k = day + "|" + email;
  const limit = parseInt(env.MAX_RUNS_PER_DAY || "20", 10);
  if ((runsToday.get(k) || 0) >= limit) return json({ error: `Daily limit of ${limit} reports reached for ${email}.` }, 429);

  const r = await gh(env, "/actions/workflows/report.yml/dispatches", {
    method: "POST",
    body: JSON.stringify({
      ref: env.BRANCH || "main",
      inputs: {
        profile_url: url, brand: b.brand, focus: b.focus, max_posts: String(b.max_posts),
        include_comments: !!b.include_comments, skip_collect: !!b.skip_collect, requested_by: email,
      },
    }),
  });
  if (!r.ok) return json({ error: "GitHub refused to start the run (" + r.status + "). Check the Worker's token permissions." }, 502);
  runsToday.set(k, (runsToday.get(k) || 0) + 1);
  return json({ ok: true });
}

async function findRun(url, env) {
  const since = url.searchParams.get("since") || new Date(Date.now() - 60000).toISOString();
  const r = await gh(env, `/actions/workflows/report.yml/runs?per_page=5&event=workflow_dispatch&created=%3E%3D${encodeURIComponent(since)}`);
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
