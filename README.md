# Threads Competitor Tracker

This tool tracks competitor accounts on Threads. It collects their posts, their replies to other people and, optionally, the comments under their posts. It shows everything on a dashboard and writes AI reports with ready-to-post ideas for your brands.

Everything runs on GitHub, so you don't need a server.

```
Apify (collects posts) ──► GitHub Actions (runs the scripts) ──► data/ and reports/ in this repo
                                        │                                   │
                                        └── Claude API (writes reports)     └── Dashboard on GitHub Pages
```

---

## 1. One-time setup (about 15 minutes)

### 1.1 Claude API key
1. Go to **platform.claude.com** and sign in. This is a separate account from claude.ai.
2. **Settings → Billing → Buy credits.** $5 is enough to start.
3. **Settings → API keys → Create key.** Name it `threads-tracker`.
4. Copy the key straight away. It starts with `sk-ant-` and is shown only once.

### 1.2 Apify token
1. Go to **apify.com**, sign in, open **Settings → API & Integrations**.
2. Copy your **Personal API token**.

### 1.3 Put both keys into this repository
**Never paste keys into code, chat or files.**

1. In this repository: **Settings → Secrets and variables → Actions → New repository secret**.
2. Add two secrets, with exactly these names:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Claude API key |
| `APIFY_TOKEN` | your Apify token |

### 1.4 Turn on the dashboard website
1. **Settings → Pages → Build and deployment → Source: Deploy from a branch.**
2. **Branch:** `main`, folder `/ (root)`, then **Save**.
3. After a minute, the page shows your dashboard link, for example `https://your-name.github.io/threads-tracker/`.

> A dashboard on a **public** repository can be opened by anyone with the link (competitor data is public anyway, but your reports would be too).
> To keep it private, the repository must be private, and GitHub Pages for private repositories needs a paid GitHub plan.

### 1.5 Allow the robot to save results
**Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**

---

## 2. Everyday use

### Get a report for any account ("paste a link")
**For a team: email sign-in.** See [cloudflare/SETUP.md](cloudflare/SETUP.md). After about 20 minutes of setup, everyone signs in with an email code and can run reports. No GitHub tokens, and the repository can be private.

**Easiest: from the dashboard.** The "Get a report" form sits at the top of the Overview tab.

1. The first time, click **Connect GitHub** and paste a token that is allowed to run this repository's workflows. Create it in GitHub:
   - your photo → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**;
   - repository access: **only threads-tracker**;
   - permissions: **Actions: Read and write**.

   The token is saved only in that browser.
2. Paste a profile link, choose the brand and report type, and click **Run**.
3. The form shows the progress. When the run finishes, it opens the new report.

**Or from GitHub:**
1. Open the **Actions** tab, or tap **Get a new report** on the dashboard.
2. Choose **Get report → Run workflow**.
3. Fill in the form:
   - **Threads profile link or @handle:** for example `https://www.threads.com/@esmipsicologa`
   - **Write post ideas for:** `ines`, `liven` or `overwell`
   - **Report type:**
     - `full`: complete analysis + 5 post drafts
     - `ideas`: 8 post drafts
     - `replies`: tone of voice and reply templates
   - **Posts to collect:** 60 is a good default
   - **Also collect comments:** tick this to see conversations under their top 10 posts (costs more)
   - **Only write a new report:** tick this to reuse data you already have (no Apify cost)
4. Press **Run workflow**. In 3-10 minutes the report appears on the dashboard under **AI reports**, and in the `reports/` folder.

You can do all of this in the **GitHub mobile app**: Repository → Actions → Get report → Run workflow.

### Monthly refresh (automatic)
On the 1st of every month, **Monthly refresh** collects new posts from every tracked account and writes one summary report. You can also run it by hand from the Actions tab.

### Add or remove tracked accounts
- **Add:** running **Get report** with a new link adds the account automatically.
- **Remove:** edit `config/accounts.json` on GitHub (pencil icon) and delete the account's line. Its saved data stays in `data/accounts/` until you delete that file too.
- To always collect comments for an account, set `"comments": true` in its line.

### Content plan
On the dashboard, open **Content plan**, choose the brand, the number of weeks, the posts per week and a start date, then click **Create plan**. Claude uses everything collected about the tracked competitors to write:
- a short strategy and 3-4 content pillars;
- **action steps**, each with priority, evidence and how to do it. You can tick them off in the browser or download them as CSV;
- **dated posts** with time, format, hook, full draft, call to action and which competitor pattern each one builds on. You can view them as a calendar, a table or a list of drafts.

**Downloads:**
- **Notion / Excel CSV:** in Notion, choose **Import → CSV** to get a database. Then add a **Calendar** view on the Date property.
- **Markdown**
- **Print / PDF:** use your browser's "Save as PDF".

AI reports have the same **Download** and **Print / PDF** buttons.

**Optional: send every plan straight to Notion**
1. Create an integration at **notion.so/profile/integrations** (Internal) and copy its secret.
2. Create an empty Notion page for the plans. Use **••• → Connections**, and add the integration.
3. Add two GitHub secrets:
   - `NOTION_TOKEN`: the integration secret;
   - `NOTION_PARENT_PAGE`: the page's link.
4. From then on, each plan is created in that page as a database (with Status, Pillar and Format), plus a to-do page with the action steps. The dashboard shows an **Open in Notion** button.

### Change what the AI writes
- **Brand descriptions:** `config/brands.json`. Add a new brand here, then add its name to the `options:` lists in `.github/workflows/report.yml` and `refresh.yml`.
- **Report instructions:** `prompts/report.md` (shared rules) and `prompts/task_full.md`, `task_ideas.md` and `task_replies.md`.
- **Model and limits:** `config/settings.json`.

---

## 3. What it costs - and the $5 monthly limit

**Built-in budget:**
- Every paid call is recorded in `data/usage.json`.
- When the month's total reaches **$5** (`monthly_budget_usd` in `config/settings.json`), all paid actions stop with a clear message until the 1st of the next month.
- Each single run is also capped so it can't spend more than what's left.
- The dashboard header shows **"Spent this month $x of $5"**.

**Default settings to keep it around $3-4 a month (even with ~40 accounts):**

| Setting | Value | Why |
|---|---|---|
| Refresh | **monthly**, on the 1st | weekly would cost about 4x more |
| `only_new_posts_on_refresh` | `true` | collects only posts published since the last refresh |
| `max_posts_per_account` | 25 | posts and replies per account per run |
| Comments | off by default; when ticked, top **5** posts × **20** comments | comments are the most expensive part |
| AI reports | 1 monthly summary automatically; others only when you click Run | |

**What each action costs, roughly:**

| Action | Cost |
|---|---|
| Report with fresh data | ~$0.10-0.25 |
| Report from saved data / AI linguistic report | ~$0.10 |
| + comments (5 posts × 20) | +~$0.15 |
| Competitor search | ~$0.35 |
| Content plan | ~$0.15-0.20 |
| Monthly refresh | ~$0.05 per account + ~$0.15 summary |
| Viewing anything, the Tone of voice stats, downloads, login | free |

**Recommended backup limits in the services themselves:**
- **Claude Console:** Billing → Limits → $3 a month.
- **Apify:** Billing → Limits → $4 a month.

## 4. What's in the data

**Collected per post or reply:**
- text and date
- likes, replies, reposts, quotes and shares
- **views**, when Threads shows them (most posts)
- link to the post
- for replies: the comment they answered

**Profile:** followers and bio. Follower history builds up with each refresh.

**Engagement** = likes + replies + reposts + quotes.

**Not available for other people's accounts:** reach, saves, profile visits and audience demographics. Only the account owner sees those.

---

## 5. If something goes wrong

Open the failed run in **Actions** and read the last lines.

| Message | Fix |
|---|---|
| `APIFY_TOKEN is missing` / `ANTHROPIC_API_KEY is missing` | Add the secret (step 1.3). The name must match exactly. |
| `Apify rejected the token` | Copy the token again from Apify and update the secret. |
| `no credit left` / `balance is too low` | Top up Apify or the Claude Console. |
| `Apify returned no data` | The profile is private, misspelled or doesn't exist. |
| Push or permission error | Step 1.5 (Read and write permissions). |
| Dashboard says it can't load data | Wait a minute after a run. Check that Pages is on (step 1.4). |

**Test without spending anything:** run the **Test** workflow. It uses sample data and calls nothing.

---

## 6. For whoever maintains the code

**Files:**
- `scripts/tracker.py`: the whole pipeline (`collect`, `refresh`, `report`, `add`, `index`). Python 3.12, only `requests`.
- `index.html` + `dashboard.js`: the static dashboard, vanilla JS, reading `data/index.json`, `data/accounts/<handle>.json` and `reports/*.md`.

**Apify Actors:**
- `deepmine/threads-posts-scraper`: profile, posts and replies.
- `deepmine/threads-scraper`: comments under post URLs, with nested replies.

**Local dry run** (writes to a temp folder, changes nothing):
```
python scripts/tracker.py collect --handle esmipsicologa --comments --dry-run
python scripts/tracker.py report --handle esmipsicologa --brand ines --focus full --dry-run
```

**Data notes:**
- Posts are upserted by `postId`.
- Each post keeps up to 26 weekly metric snapshots in `history` for growth tracking.

> Scraping public Threads data goes against Meta's terms of service. Use it for internal research only, and check with your company before using it at work.
