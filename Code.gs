const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY'; // Get from https://aistudio.google.com/apikey
const GEMINI_MODEL = 'gemini-2.0-flash-lite';
const BATCH_SIZE = 10;

const VALID_LABELS = [
  'Jobs/Recruiter',
  'Finance',
  'Transactions',
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

const CLASSIFICATION_PROMPT = `You are an email classifier. Classify the email into exactly ONE of these categories:

- Jobs/Recruiter — job opportunities, recruiter outreach, hiring, interview scheduling
- Finance — investments, stocks, mutual funds, demat, portfolio, tax filings, insurance, salary credits, SIP, IPO, market reports
- Transactions — UPI payments, credit card spends, bank debits, payment receipts, EMI, recharges, bill payments, NEFT transfers
- Travel — flight bookings, boarding passes, hotel reservations, train tickets, airport lounge, trip itineraries, airline GST invoices. NOT airline loyalty points (those go to Promotions). NOT restaurant reservations (those go to Dining).
- Rides — Uber trips, Ola rides, Rapido, cab bookings, ride receipts, trip summaries from ride apps
- Dining — restaurant reservations, table bookings, dine-in confirmations, Dineout reservations, "Reservation confirmed" from Swiggy/Zomato/EazyDiner. NOT food delivery.
- Food — Swiggy food delivery orders, Zomato food delivery, food delivery receipts and confirmations. NOT grocery (grocery goes to Shopping). NOT dine-in (dine-in goes to Dining).
- Splitwise — Splitwise notifications, expense splits, group expenses, settlement reminders, balance updates
- Shopping — orders, deliveries, returns, receipts, tracking updates
- GitHub — pull requests, issues, CI/CD notifications, code reviews, repository activity
- Newsletters — blog digests, weekly roundups, dev newsletters, content subscriptions, Pinterest recommendations, career advice articles, tech announcements
- Social — LinkedIn, Twitter, Instagram, WhatsApp, social media notifications
- Promotions — marketing emails, discount offers, deals, product launches
- Personal — direct personal emails from people you know
- System — STRICTLY ONLY: OTPs, verification codes, password resets, security alerts, new device sign-ins, two-factor authentication codes, scheduled maintenance/downtime notices. Account summaries go to Finance. Surveys go to Promotions. Appointments go to Personal. App feature announcements go to Newsletters.

Reply with ONLY the category name. Nothing else. No explanation.`;

// Build exclusion query so we skip emails already labeled by us
function excludeLabeled() {
  return VALID_LABELS.map(function(l) { return '-label:' + l.replace('/', '-'); }).join(' ');
}

function classifyAndLabelEmails() {
  const threads = GmailApp.search('is:unread ' + excludeLabeled(), 0, BATCH_SIZE);

  if (threads.length === 0) return;

  for (let i = 0; i < threads.length; i++) {
    const thread = threads[i];
    const message = thread.getMessages()[0];

    const from = message.getFrom();
    const subject = message.getSubject();
    const body = message.getPlainBody().substring(0, 1000);

    const category = classifyWithGemini(from, subject, body);

    if (category === null) {
      Logger.log('API error — stopping to avoid wasting quota.');
      return;
    }

    if (VALID_LABELS.includes(category)) {
      const label = getOrCreateLabel(category);
      thread.addLabel(label);
      Logger.log('Labeled: "' + subject + '" → ' + category);
    } else {
      Logger.log('Skipped (unrecognized category "' + category + '"): "' + subject + '"');
    }

    // Respect Gemini rate limits
    Utilities.sleep(1000);
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

      // Retry once after a pause if rate limited
      if (category === null) {
        Logger.log('Rate limited — waiting 10s and retrying...');
        Utilities.sleep(10000);
        category = classifyWithGemini(from, subject, body);
      }

      if (category && VALID_LABELS.includes(category)) {
        const label = getOrCreateLabel(category);
        thread.addLabel(label);
        Logger.log('Labeled: "' + subject + '" → ' + category);
      } else {
        Logger.log('Skipped (will retry): "' + subject + '" (got: "' + category + '")');
      }

      total++;
      Utilities.sleep(1000);
    }

    start += BATCH_SIZE;
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
  const emailContent = 'From: ' + from + '\nSubject: ' + subject + '\nContent: ' + body;
  const prompt = CLASSIFICATION_PROMPT + '\n\n' + emailContent;

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 20
    }
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const result = JSON.parse(response.getContentText());

    if (result.error) {
      Logger.log('Gemini API error: ' + result.error.message);
      return null;
    }

    return result.candidates[0].content.parts[0].text.trim();
  } catch (error) {
    Logger.log('Classification error: ' + error);
    return null;
  }
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

// List available Gemini models — run this to see what you have access to
function listModels() {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + GEMINI_API_KEY;
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const result = JSON.parse(response.getContentText());

  if (result.error) {
    Logger.log('Error: ' + result.error.message);
    return;
  }

  result.models.forEach(function(model) {
    if (model.supportedGenerationMethods && model.supportedGenerationMethods.includes('generateContent')) {
      Logger.log(model.name);
    }
  });
}

// Color labels — run once after enabling Gmail Advanced Service
// (Apps Script → Services + → Gmail API → Add)
function colorizeLabels() {
  var colors = {
    'Jobs/Recruiter': { bg: '#16a766', text: '#ffffff' },
    'Finance':        { bg: '#4a86e8', text: '#ffffff' },
    'Transactions':   { bg: '#ff7537', text: '#ffffff' },
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
