# Gmail Auto-Labeler

Automatically classifies and labels Gmail emails using Google Apps Script + Gemini AI. Zero infrastructure — runs entirely inside Google.

## How it works

A time-based trigger runs every 10 minutes, picks up unlabeled emails, sends them to Gemini 2.5 Flash Lite on Vertex AI for classification, and applies the appropriate Gmail label. That's it.

## Labels

| Label | What goes here |
|-------|---------------|
| Jobs/Recruiter | Job opportunities, recruiter outreach, interviews |
| Finance | Your own money: statements, bills due, SIP failures, dividends, tax, insurance, salary |
| Transactions | Completed payments: UPI, card spends, bank debits, successful SIPs, bill payments |
| Notices | Statutory bulk mail: scheme results, e-voting, exchange balance confirmations |
| Travel | Flight bookings, hotel reservations, boarding passes |
| Rides | Uber, Ola, Rapido trips and receipts |
| Dining | Restaurant reservations, dine-in confirmations |
| Food | Swiggy/Zomato food delivery orders |
| Splitwise | Expense splits, settlements, balance updates |
| Shopping | Orders, deliveries, returns, tracking |
| GitHub | PRs, issues, CI/CD, code reviews |
| Newsletters | Blog digests, weekly roundups, content subscriptions |
| Social | LinkedIn, Twitter, Instagram notifications |
| Promotions | Marketing emails, deals, discount offers |
| Personal | Direct personal emails |
| System | OTPs, verification codes, password resets, security alerts |
| Unsorted | Quarantine for a model answer that matched no label, so it is not retried every run |

## Setup

1. Go to [Google Apps Script](https://script.google.com/) and create a new project
2. Paste the contents of `Code.gs`
3. Set `GCP_PROJECT` to a Google Cloud project with the Vertex AI API enabled. The script calls Vertex AI with its own OAuth token, so there is no API key to paste; approve the `cloud-platform` scope when Apps Script asks
4. Enable the Gmail Advanced Service: **Services** (+) → **Gmail API** → **Add**
5. Run `setupTrigger()` to start automatic labeling every 10 minutes
6. Labels get colours on the first run (`colorizeLabels()` runs once per `PROMPT_VERSION`)

After editing the prompt, bump `PROMPT_VERSION`: the next run strips `Finance` from the last 7 days and re-sorts them 10 per run. Set `LOOKBACK_DAYS` and `DAILY_REQUEST_CAP` to taste; the cap is per calendar day and the run stops cleanly when it is hit.

## Useful functions

| Function | What it does |
|----------|-------------|
| `classifyAndLabelEmails()` | Process next batch of unlabeled emails |
| `bulkLabel7Days()` | Backfill labels for the last 7 days |
| `bulkLabel30Days()` | Backfill labels for the last 30 days |
| `reclassifyDining()` | Strip Dining labels and re-classify on next run |
| `reclassifyAll()` | Strip all labels and re-classify everything |
| `removeDuplicateLabels()` | Fix emails that ended up with multiple labels |
| `deleteOldLabels()` | Delete labels not in the active list |
| `cleanupOldRequestCounters()` | Drop old per-day request counters from script properties |
| `setupTrigger()` | Set up the 10-minute auto-trigger |
| `removeTrigger()` | Stop automatic labeling |

## Cost

Gemini 2.5 Flash Lite on Vertex AI, capped at `DAILY_REQUEST_CAP` (200) calls a day. At that volume the bill is a few rupees a month.
