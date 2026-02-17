# Gmail Auto-Labeler

Automatically classifies and labels Gmail emails using Google Apps Script + Gemini AI. Zero infrastructure — runs entirely inside Google.

## How it works

A time-based trigger runs every 10 minutes, picks up unlabeled emails, sends them to Gemini 2.0 Flash Lite for classification, and applies the appropriate Gmail label. That's it.

## Labels

| Label | What goes here |
|-------|---------------|
| Jobs/Recruiter | Job opportunities, recruiter outreach, interviews |
| Finance | Investments, stocks, mutual funds, tax, insurance, salary |
| Transactions | UPI, credit card spends, bank debits, bill payments |
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

## Setup

1. Go to [Google Apps Script](https://script.google.com/) and create a new project
2. Paste the contents of `Code.gs`
3. Replace `YOUR_GEMINI_API_KEY` with your key from [Google AI Studio](https://aistudio.google.com/apikey)
4. Enable the Gmail Advanced Service: **Services** (+) → **Gmail API** → **Add**
5. Run `setupTrigger()` to start automatic labeling every 10 minutes
6. Run `colorizeLabels()` to add colors to the labels

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
| `setupTrigger()` | Set up the 10-minute auto-trigger |
| `removeTrigger()` | Stop automatic labeling |

## Cost

Uses Gemini 2.0 Flash Lite which has a free tier. At 10 emails per 10 minutes, you stay well within limits.
