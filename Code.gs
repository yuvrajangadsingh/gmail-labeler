const GCP_PROJECT = 'YOUR_GCP_PROJECT_ID'; // Google Cloud project with the Vertex AI API enabled
const GCP_REGION = 'us-central1';
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const BATCH_SIZE = 10;
const DAILY_REQUEST_CAP = 200;
const LOOKBACK_DAYS = 7;          // was an implicit 1: anything unlabelled after 24h was lost forever
const CAP_REACHED = '__CAP_REACHED__';  // distinct from null, which means a real API failure

const VALID_LABELS = [
  'Jobs/Recruiter',
  'Finance',
  'Transactions',
  'Notices',
  'Travel',
  'Rides',
  'Dining',
  'Food',
  'Splitwise',
  'Shopping',
  'GitHub',
  'Newsletters',
  'Social',
  'Promotions',
  'Personal',
  'System'
];

const CLASSIFICATION_PROMPT = `You are an email classifier. Classify the email by its MAIN PURPOSE into exactly ONE of these categories. Ignore incidental offers, footers and signatures.

- Jobs/Recruiter — job opportunities, recruiter outreach, hiring, interview scheduling
- Finance — the reader's own money and holdings: bank and credit card statements, bills and dues (including an upcoming subscription renewal), SIP or auto-pay FAILURES and mandate notices, IPO allotment or refund, demat/CAS/holding statements, dividends, REIT distributions and TDS notices, tax filings and intimations, insurance policies and renewals, salary credits, loan or overdraft documents, KYC or compliance requests from the reader's own bank, broker or fund house, credit report access notices. NOT market digests or research (Newsletters). NOT "IPO/NFO now open", "apply now", webinars, courses (Promotions). NOT completed payments (Transactions). NOT statutory bulk mail (Notices).
- Transactions — completed or in-progress money movements and account alerts: UPI payments, card spends, bank debits and credits, payment received, NEFT/IMPS transfers, daily balance alerts, EMI debits, recharges, bill payments made, SIP installments that SUCCEEDED, deposits being processed, payment receipts
- Notices — statutory bulk mail sent to all unitholders or shareholders: scheme or company financial results, e-voting and postal ballots, proxy notices, exchange funds/securities balance confirmations, SEBI or regulatory disclosures
- Travel — flight bookings, boarding passes, hotel reservations, train tickets, airport lounge, trip itineraries, airline GST invoices. NOT airline loyalty points (those go to Promotions). NOT restaurant reservations (those go to Dining).
- Rides — Uber trips, Ola rides, Rapido, cab bookings, ride receipts, trip summaries from ride apps
- Dining — restaurant reservations, table bookings, dine-in confirmations, Dineout reservations, "Reservation confirmed" from Swiggy/Zomato/EazyDiner. NOT food delivery.
- Food — Swiggy food delivery orders, Zomato food delivery, food delivery receipts and confirmations. NOT grocery (grocery goes to Shopping). NOT dine-in (dine-in goes to Dining).
- Splitwise — Splitwise notifications, expense splits, group expenses, settlement reminders, balance updates
- Shopping — orders, deliveries, returns, receipts, tracking updates
- GitHub — pull requests, issues, CI/CD notifications, code reviews, repository activity
- Newsletters — blog digests, weekly roundups, dev newsletters, content subscriptions, Pinterest recommendations, career advice articles, tech announcements, market digests, daily market wraps, stock ideas and research notes from brokers or fund houses (even about stocks the reader holds)
- Social — LinkedIn, Twitter, Instagram, WhatsApp, social media notifications
- Promotions — marketing emails, discount offers, deals, product launches, IPO/NFO launch or "apply now" mails, investing webinars and workshops, app feature announcements, credit-score and "upgrade your plan" nudges
- Personal — direct personal emails from people you know
- System — STRICTLY ONLY: OTPs, verification codes, password resets, security alerts, new device sign-ins, two-factor authentication codes, payee added or limit changed notices, scheduled maintenance/downtime notices. Surveys go to Promotions. Appointments go to Personal.

Reply with ONLY the category name. Nothing else. No explanation.`;

// Build exclusion query so we skip emails already labeled by us
function excludeLabeled() {
  return VALID_LABELS.concat(['Unsorted']).map(function(l) { return '-label:' + l.replace('/', '-'); }).join(' ');
}

function classifyAndLabelEmails() {
  resortIfPromptChanged();
  const threads = GmailApp.search('newer_than:' + LOOKBACK_DAYS + 'd ' + excludeLabeled(), 0, BATCH_SIZE);

  if (threads.length === 0) return;

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const msgs = thread.getMessages();
    const message = msgs[msgs.length - 1];   // newest: the search matched a recent reply, not the opener

    const from = message.getFrom();
    const subject = message.getSubject();
    const body = message.getPlainBody().substring(0, 1000);

    const category = classifyWithGemini(from, subject, body);

    if (category === CAP_REACHED) {
      Logger.log('Daily cap reached. Remaining threads stay queued for tomorrow.');
      return;
    }

    if (category === null) {
      Logger.log('Classification failed for this thread; continuing with the batch.');
      continue;
    }

    if (VALID_LABELS.includes(category)) {
      const label = getOrCreateLabel(category);
      thread.addLabel(label);
      Logger.log('Labeled: "' + subject + '" → ' + category);
    } else {
      thread.addLabel(getOrCreateLabel('Unsorted'));
      Logger.log('Unsorted (model said "' + category + '"): "' + subject + '"');
    }

    // Respect Gemini rate limits
    Utilities.sleep(500);
  }
}

// Bulk cleanup: process ALL emails from the last N days (not just unread)
function bulkLabelLastNDays(days) {
  const query = 'newer_than:' + days + 'd ' + excludeLabeled();
  let start = 0;
  let total = 0;

  while (true) {
    if (isTimeLimitClose()) {
      Logger.log('Approaching time limit. Processed ' + total + ' threads. Run again to continue.');
      return;
    }

    const threads = GmailApp.search(query, start, BATCH_SIZE);
    if (threads.length === 0) break;
    var labelledThisPage = 0;

    for (let i = 0; i < threads.length; i++) {
      if (isTimeLimitClose()) {
        Logger.log('Approaching time limit. Processed ' + total + ' threads. Run again to continue.');
        return;
      }

      const thread = threads[i];
      const message = thread.getMessages()[0];

      const from = message.getFrom();
      const subject = message.getSubject();
      const body = message.getPlainBody().substring(0, 1000);

      var category = classifyWithGemini(from, subject, body);

      if (category === CAP_REACHED) {
        Logger.log('Daily cap reached. Stopping bulk run; rerun tomorrow.');
        return;
      }

      // Retry once after a pause if rate limited
      if (category === null) {
        Logger.log('Rate limited — waiting 10s and retrying...');
        Utilities.sleep(10000);
        category = classifyWithGemini(from, subject, body);
        if (category === CAP_REACHED) {
          Logger.log('Daily cap reached on retry. Stopping bulk run.');
          return;
        }
      }

      if (category && VALID_LABELS.includes(category)) {
        const label = getOrCreateLabel(category);
        thread.addLabel(label);
        labelledThisPage++;
        Logger.log('Labeled: "' + subject + '" → ' + category);
      } else {
        Logger.log('Skipped (will retry): "' + subject + '" (got: "' + category + '")');
      }

      total++;
      Utilities.sleep(500);
    }

    // Labelled threads drop out of the query, so the next page shifts down to where
    // this one was. Advancing unconditionally skipped every other page. Only step over
    // a page when nothing on it got labelled, otherwise this would spin on it forever.
    if (labelledThisPage === 0) start += BATCH_SIZE;
  }

  Logger.log('Bulk labeling complete. Total processed: ' + total);
}

// Run this to clean up the last 30 days
function bulkLabel30Days() {
  bulkLabelLastNDays(30);
}

// Run this to clean up the last 7 days
function bulkLabel7Days() {
  bulkLabelLastNDays(7);
}

function classifyWithGemini(from, subject, body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
    const counterKey = 'reqs_' + today;
    const reqsToday = parseInt(props.getProperty(counterKey) || '0', 10);
    if (reqsToday >= DAILY_REQUEST_CAP) {
      Logger.log('Daily request cap (' + DAILY_REQUEST_CAP + ') hit. Will resume tomorrow.');
      return CAP_REACHED;
    }
    props.setProperty(counterKey, String(reqsToday + 1));
  } finally {
    lock.releaseLock();
  }

  const emailContent = 'From: ' + from + '\nSubject: ' + subject + '\nContent: ' + body;
  const prompt = CLASSIFICATION_PROMPT + '\n\n' + emailContent;

  const url = 'https://' + GCP_REGION + '-aiplatform.googleapis.com/v1/projects/' +
              GCP_PROJECT + '/locations/' + GCP_REGION +
              '/publishers/google/models/' + GEMINI_MODEL + ':generateContent';

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 20
    }
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code !== 200) {
      Logger.log('Vertex HTTP ' + code + ': ' + response.getContentText().substring(0, 500));
      return null;
    }

    const result = JSON.parse(response.getContentText());

    if (result.error) {
      Logger.log('Vertex API error: ' + result.error.message);
      return null;
    }

    if (!result.candidates || !result.candidates[0]) {
      Logger.log('No candidates in response.');
      return null;
    }

    const raw = result.candidates[0].content.parts[0].text.trim().replace(/^[^A-Za-z]+|[^A-Za-z\/]+$/g, '');
    const hit = VALID_LABELS.find(function(l) { return l.toLowerCase() === raw.toLowerCase(); });
    return hit || raw;
  } catch (error) {
    Logger.log('Classification error: ' + error);
    return null;
  }
}

// Bump PROMPT_VERSION when the prompt changes: the next run strips Finance from the last 7 days so the normal loop re-sorts them (10 per run).
const PROMPT_VERSION = 2;
function resortIfPromptChanged() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('labels_version') !== String(PROMPT_VERSION)) { colorizeLabels(); props.setProperty('labels_version', String(PROMPT_VERSION)); }  // new labels arrive with prompt changes, colour them once
  if (props.getProperty('prompt_version') === String(PROMPT_VERSION)) return;
  const label = GmailApp.getUserLabelByName('Finance');
  const threads = label ? GmailApp.search('label:Finance newer_than:7d', 0, 500) : [];
  threads.forEach(function(t) { t.removeLabel(label); });
  props.setProperty('prompt_version', String(PROMPT_VERSION));
  Logger.log('Prompt v' + PROMPT_VERSION + ': stripped Finance from ' + threads.length + ' threads for re-sorting.');
}

function getOrCreateLabel(name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) {
    label = GmailApp.createLabel(name);
  }
  return label;
}

// Track script start time for execution limit
var scriptStartTime = new Date();

function isTimeLimitClose() {
  var now = new Date();
  var elapsed = (now - scriptStartTime) / 1000;
  return elapsed > 300; // 5 minutes (1 min buffer before 6 min limit)
}

// Set up automatic trigger — run every 10 minutes
function setupTrigger() {
  // Remove existing triggers for this function
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'classifyAndLabelEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('classifyAndLabelEmails')
    .timeBased()
    .everyMinutes(10)
    .create();

  Logger.log('Trigger set: classifyAndLabelEmails will run every 10 minutes.');
}

// Re-classify emails with a specific label (removes old label, re-processes)
function reclassifyLabel(labelName) {
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    Logger.log('Label "' + labelName + '" not found.');
    return;
  }

  var threads = label.getThreads(0, BATCH_SIZE);
  var total = 0;

  if (threads.length === 0) {
    Logger.log('No threads found with label "' + labelName + '".');
    return;
  }

  for (var i = 0; i < threads.length; i++) {
    if (isTimeLimitClose()) {
      Logger.log('Time limit. Re-classified ' + total + '. Run again to continue.');
      return;
    }

    var thread = threads[i];
    thread.removeLabel(label);
    total++;
  }

  Logger.log('Stripped "' + labelName + '" from ' + total + ' threads. Now run bulkLabel7Days to re-classify them.');
}

// Run these to re-classify mislabeled emails
function reclassifyFinance() { reclassifyLabel('Finance'); }
function reclassifyTransactions() { reclassifyLabel('Transactions'); }
function reclassifySystem() { reclassifyLabel('System'); }
function reclassifyDining() { reclassifyLabel('Dining'); }
function reclassifyShopping() { reclassifyLabel('Shopping'); }
function reclassifyPromotions() { reclassifyLabel('Promotions'); }
function reclassifyJobs() { reclassifyLabel('Jobs/Recruiter'); }
function reclassifyAll() {
  VALID_LABELS.forEach(function(name) {
    reclassifyLabel(name);
  });
  Logger.log('All labels stripped. Run bulkLabel7Days to re-classify everything.');
}

// Fix duplicate labels — strips all our labels + tracking so they get re-classified fresh
function removeDuplicateLabels() {
  var total = 0;

  for (var i = 0; i < VALID_LABELS.length; i++) {
    for (var j = i + 1; j < VALID_LABELS.length; j++) {
      if (isTimeLimitClose()) {
        Logger.log('Time limit. Fixed ' + total + '. Run again to continue.');
        return;
      }

      var query = 'label:' + VALID_LABELS[i].replace('/', '-') + ' label:' + VALID_LABELS[j].replace('/', '-');
      var threads = GmailApp.search(query);

      if (threads.length > 0) {
        var label1 = GmailApp.getUserLabelByName(VALID_LABELS[i]);
        var label2 = GmailApp.getUserLabelByName(VALID_LABELS[j]);

        for (var k = 0; k < threads.length; k++) {
          if (label1) threads[k].removeLabel(label1);
          if (label2) threads[k].removeLabel(label2);
          Logger.log('Stripped "' + VALID_LABELS[i] + '" + "' + VALID_LABELS[j] + '" from "' + threads[k].getFirstMessageSubject() + '" — will re-classify');
          total++;
        }
      }
    }
  }

  Logger.log('Stripped ' + total + ' duplicate threads. Now run bulkLabel7Days to re-classify them.');
}

// List all labels — shows old/unused ones that can be deleted
function listAllLabels() {
  var ourLabels = VALID_LABELS;
  var allLabels = Gmail.Users.Labels.list('me').labels;

  // Skip Gmail's built-in labels (INBOX, SENT, SPAM, etc.)
  var builtIn = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT',
                 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
                 'CHAT', 'OPENED', 'SNOOZED'];

  Logger.log('=== OLD / NON-AUTO LABELS (candidates for deletion) ===');
  var deleteCount = 0;

  allLabels.forEach(function(label) {
    if (builtIn.includes(label.id) || label.type === 'system') return;
    if (ourLabels.includes(label.name)) return;

    // Get thread count
    var details = Gmail.Users.Labels.get('me', label.id);
    var threads = details.threadsTotal || 0;
    Logger.log(label.name + ' — ' + threads + ' threads');
    deleteCount++;
  });

  Logger.log('');
  Logger.log('=== OUR LABELS (keeping) ===');
  allLabels.forEach(function(label) {
    if (ourLabels.includes(label.name)) {
      var details = Gmail.Users.Labels.get('me', label.id);
      var threads = details.threadsTotal || 0;
      Logger.log(label.name + ' — ' + threads + ' threads');
    }
  });

  Logger.log('');
  Logger.log('Found ' + deleteCount + ' old labels. Review above and run deleteOldLabels() to remove them.');
}

// Delete all labels that are NOT in our VALID_LABELS list
// WARNING: This removes the labels, NOT the emails. Emails stay in your inbox.
function deleteOldLabels() {
  var ourLabels = VALID_LABELS;
  var allLabels = Gmail.Users.Labels.list('me').labels;
  var builtIn = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT',
                 'CATEGORY_PERSONAL', 'CATEGORY_SOCIAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
                 'CHAT', 'OPENED', 'SNOOZED'];
  var deleted = 0;

  allLabels.forEach(function(label) {
    if (builtIn.includes(label.id) || label.type === 'system') return;
    if (ourLabels.includes(label.name)) return;

    try {
      UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels/' + label.id, {
        method: 'delete',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      Logger.log('Deleted: ' + label.name);
      deleted++;
    } catch (e) {
      Logger.log('Failed to delete "' + label.name + '": ' + e);
    }
  });

  Logger.log('Deleted ' + deleted + ' old labels.');
}

// Count emails from last N days
function countEmails() {
  var days = [7, 30];
  days.forEach(function(d) {
    var threads = GmailApp.search('newer_than:' + d + 'd');
    Logger.log('Last ' + d + ' days: ' + threads.length + ' threads');
  });
}

// Color labels — run once after enabling Gmail Advanced Service
// (Apps Script → Services + → Gmail API → Add)
function colorizeLabels() {
  var colors = {
    'Jobs/Recruiter': { bg: '#16a766', text: '#ffffff' },
    'Finance':        { bg: '#4a86e8', text: '#ffffff' },
    'Transactions':   { bg: '#ff7537', text: '#ffffff' },
    'Notices':        { bg: '#666666', text: '#ffffff' },
    'Unsorted':       { bg: '#cccccc', text: '#000000' },
    'Travel':         { bg: '#0b804b', text: '#ffffff' },
    'Rides':          { bg: '#44b984', text: '#ffffff' },
    'Dining':         { bg: '#822111', text: '#ffffff' },
    'Food':           { bg: '#ac2b16', text: '#ffffff' },
    'Splitwise':      { bg: '#e66550', text: '#ffffff' },
    'Shopping':       { bg: '#ffad46', text: '#ffffff' },
    'GitHub':         { bg: '#a479e2', text: '#ffffff' },
    'Newsletters':    { bg: '#2da2bb', text: '#ffffff' },
    'Social':         { bg: '#f691b2', text: '#ffffff' },
    'Promotions':     { bg: '#fad165', text: '#000000' },
    'Personal':       { bg: '#1c4587', text: '#ffffff' },
    'System':         { bg: '#999999', text: '#ffffff' }
  };

  VALID_LABELS.forEach(function(name) {
    var label = GmailApp.getUserLabelByName(name);
    if (label) {
      Gmail.Users.Labels.update({
        color: {
          backgroundColor: colors[name].bg,
          textColor: colors[name].text
        }
      }, 'me', label.getId());
      Logger.log('Colored: ' + name);
    } else {
      Logger.log('Label not found: ' + name);
    }
  });
}


// Remove automatic trigger
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'classifyAndLabelEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  Logger.log('Trigger removed.');
}


// Cleanup old daily request counter keys (run occasionally, manually or via trigger)
function cleanupOldRequestCounters() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd');
  let deleted = 0;
  for (const key in all) {
    if (key.indexOf('reqs_') === 0 && key !== 'reqs_' + today) {
      props.deleteProperty(key);
      deleted++;
    }
  }
  Logger.log('Deleted ' + deleted + ' old request counter keys.');
}
