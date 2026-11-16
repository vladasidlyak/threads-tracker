# Email sign-in for the dashboard (Cloudflare, free)

After this setup:
- You and your colleagues open one link and sign in with an email code.
- Everyone can run reports without a GitHub token.
- The GitHub repository can be private, because the dashboard is served from Cloudflare.

```
Colleague ──► Cloudflare Access (email + one-time code) ──► Worker ──► GitHub (data, reports, runs)
                                                              holds the only GitHub token
```

It takes about 20 minutes, all in the browser, with no code to run.

---

## Step 1. Make a GitHub token for the Worker

1. On GitHub, click your photo and go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Fill in the form:
   - **Name:** `cloudflare-worker`
   - **Expiration:** 1 year (put a calendar reminder to renew it)
   - **Repository access:** Only select repositories → `threads-tracker`
   - **Repository permissions:**
     - **Actions:** Read and write
     - **Contents:** Read-only
3. Click **Generate token** and copy it. It starts with `github_pat_`. Keep the tab open until step 4.

## Step 2. Create the Worker

1. Sign up or sign in at **dash.cloudflare.com**. The free plan is enough.
2. Go to **Workers & Pages → Create → Start with Hello World**.
3. Name it `threads-tracker` and click **Deploy**.
4. Click **Edit code**. Delete everything in `worker.js` and paste the full contents of [`cloudflare/worker.js`](worker.js) from this repository.
5. Click **Deploy**.

Your link is now `https://threads-tracker.<your-name>.workers.dev`. It shows "Sign-in is not set up yet", which is expected.

## Step 3, option A (simplest). Shared team password

Use this if Zero Trust won't load or you want the quickest setup.

1. In the Worker, go to **Settings → Variables and Secrets → Add** and add:

| Type | Name | Value |
|---|---|---|
| **Secret** | `GITHUB_TOKEN` | the token from step 1 |
| Text | `REPO` | `vladasidlyak/threads-tracker` |
| **Secret** | `TEAM_PASSWORD` | a long password you'll share with the team |

2. Click **Deploy**.
3. Open your link. You'll see a sign-in page with **Your name** and **Team password**.
   - People stay signed in for 30 days.
   - Each report shows the name of whoever ran it.
4. To remove access for everyone, change `TEAM_PASSWORD`. Everyone is signed out, and you share the new password with the people who should keep access.

Then skip to **Step 5**.

## Step 3, option B (more secure). Email sign-in with Cloudflare Access

1. Open the Worker. Depending on your Cloudflare dashboard version, use one of these:
   - **Access** tab → **Protect this Worker behind Access** → **All traffic**
   - or **Settings → Domains & Routes → workers.dev → Enable Cloudflare Access**
2. Choose who may sign in:
   - specific **emails** (yours and your colleagues'), or
   - an **email domain**, for example everyone at your company domain.
3. Save. Sign-in uses **One-time PIN** by default: people type their email and get a code by email.

> The first time, Cloudflare may ask you to set up **Zero Trust** and pick a team name and plan. Choose the **Free** plan (up to 50 users). Cloudflare may ask for a card even for the free plan.

## Step 4. Give the Worker its settings

1. Find the two values Cloudflare Access created:
   - **Team domain:** Zero Trust dashboard → **Settings**. It looks like `yourteam.cloudflareaccess.com`.
   - **AUD tag:** Zero Trust → **Access → Applications** → the app for `threads-tracker` → **Application Audience (AUD) Tag**. It's a long code; copy it.
2. In the Worker, go to **Settings → Variables and Secrets → Add** and add:

| Type | Name | Value |
|---|---|---|
| **Secret** | `GITHUB_TOKEN` | the token from step 1 |
| Text | `REPO` | `vladasidlyak/threads-tracker` |
| Text | `TEAM_DOMAIN` | e.g. `yourteam.cloudflareaccess.com` |
| Text | `POLICY_AUD` | the AUD tag |
| Text | `MAX_RUNS_PER_DAY` | `20` (optional limit per person) |

3. Click **Deploy** (or **Save and deploy**).

## Step 5. Try it

1. Open `https://threads-tracker.<your-name>.workers.dev`.
2. Enter your email, then type the code you receive.
3. The dashboard opens, with **Signed in as your@email** under the report form and no "Connect GitHub" button.
4. Run a report. In **AI reports**, it shows who requested it.

Send colleagues the same link. They sign in with their email only if you allowed it in step 3.

## Step 6 (recommended). Make the repository private

Now that Cloudflare serves the dashboard:
1. Go to GitHub → `threads-tracker` → **Settings → General → Danger Zone → Change visibility → Private**.
2. Go to **Settings → Pages** and turn off GitHub Pages. The old `github.io` link stops working, so share only the `workers.dev` link.

---

## Notes

- **To add or remove people:** Zero Trust → Access → Applications → `threads-tracker` → Policies.
- **Every run spends your Apify and Claude credits.** Keep the spending limits on in both, and keep the daily limit in `MAX_RUNS_PER_DAY`.
- **When the GitHub token expires,** create a new one (step 1) and replace `GITHUB_TOKEN` in the Worker.
- **When `worker.js` changes in this repository,** paste the new version into the Worker again (step 2.4) and deploy.
