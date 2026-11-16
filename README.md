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

### Weekly refresh (automatic)
Every Monday morning, **Weekly refresh** updates every tracked account and writes one summary report. You can also run it by hand from the Actions tab.

### Add or remove tracked accounts
- **Add:** running **Get report** with a new link adds the account automatically.
- **Remove:** edit `config/accounts.json` on GitHub (pencil icon) and delete the account's line. Its saved data stays in `data/accounts/` until you delete that file too.
- To always collect comments for an account, set `"comments": true` in its line.

### Change what the AI writes
- **Brand descriptions:** `config/brands.json`. Add a new brand here, then add its name to the `options:` lists in `.github/workflows/report.yml` and `refresh.yml`.
- **Report instructions:** `prompts/report.md` (shared rules) and `prompts/task_full.md`, `task_ideas.md` and `task_replies.md`.
- **Model and limits:** `config/settings.json`.

---

## 3. What it costs

| Item | Price | Typical use |
|---|---|---|
| **Apify**, posts and replies | about $0.0016 per post or reply (free tier) | 60 posts + replies ≈ $0.15 per account |
| **Apify**, comments (optional) | same per comment | 10 posts × 30 comments ≈ $0.50 |
| **Claude API** | pay per use | a report sends about 5,000 words of data, a few cents each (check current prices on the Claude pricing page) |
| **GitHub Actions** | free at this volume | |
| **GitHub Pages** | free on public repos | private needs a paid plan |

**Example:** 5 competitors refreshed weekly + 5 reports ≈ **$5-10 a month**.

**Safety caps:**
- Every Apify run stops at **$0.50** (`max_cost_usd_per_run` in `config/settings.json`).
- Set a monthly limit in Apify (Billing → Limits) and in the Claude Console (Billing → Limits) too.

---

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
