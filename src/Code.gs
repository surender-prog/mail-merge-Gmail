/**
 * Gmail Mail Merge for Google Sheets.
 *
 * Sheet layout: row 1 holds headers. Required columns:
 *   "Recipient"   – email address
 *   "Email Sent"  – filled in by the script (timestamp or error)
 * Any other column can be used in the template as {{Column Name}}.
 *
 * Template: a Gmail draft whose subject line you enter when prompted.
 */

const RECIPIENT_COL = 'Recipient';
const EMAIL_SENT_COL = 'Email Sent';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Mail Merge')
    .addItem('Send Emails', 'sendEmails')
    .addItem('Send Test to Me', 'sendTestEmail')
    .addToUi();
}

function sendTestEmail() {
  const subject = promptForSubject_();
  if (!subject) return;
  const sheet = SpreadsheetApp.getActiveSheet();
  const { rows } = readSheet_(sheet);
  if (rows.length === 0) {
    SpreadsheetApp.getUi().alert('No data rows found.');
    return;
  }
  const template = getDraftTemplate_(subject);
  const msg = fillTemplate_(template, rows[0]);
  GmailApp.sendEmail(Session.getActiveUser().getEmail(), msg.subject, msg.text, {
    htmlBody: msg.html,
    attachments: template.attachments,
    inlineImages: template.inlineImages,
  });
  SpreadsheetApp.getUi().alert('Test email sent to ' + Session.getActiveUser().getEmail());
}

function sendEmails(subjectLine, sheet) {
  sheet = sheet || SpreadsheetApp.getActiveSheet();
  if (!subjectLine) {
    subjectLine = promptForSubject_();
    if (!subjectLine) return;
  }

  const template = getDraftTemplate_(subjectLine);
  const { headers, rows } = readSheet_(sheet);
  const sentColIdx = headers.indexOf(EMAIL_SENT_COL);
  if (headers.indexOf(RECIPIENT_COL) === -1 || sentColIdx === -1) {
    throw new Error(`Sheet needs "${RECIPIENT_COL}" and "${EMAIL_SENT_COL}" columns.`);
  }

  const results = rows.map(row => {
    if (row[EMAIL_SENT_COL] !== '') return [row[EMAIL_SENT_COL]];
    try {
      const msg = fillTemplate_(template, row);
      GmailApp.sendEmail(row[RECIPIENT_COL], msg.subject, msg.text, {
        htmlBody: msg.html,
        attachments: template.attachments,
        inlineImages: template.inlineImages,
        // cc: row['CC'], bcc: row['BCC'], from: 'alias@example.com', name: 'Sender Name',
      });
      return [new Date()];
    } catch (e) {
      return ['Error: ' + e.message];
    }
  });

  if (results.length) {
    sheet.getRange(2, sentColIdx + 1, results.length, 1).setValues(results);
  }
}

function promptForSubject_() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Mail Merge',
    'Enter the subject line of the Gmail draft to use as the template:',
    ui.ButtonSet.OK_CANCEL);
  return res.getSelectedButton() === ui.Button.OK ? res.getResponseText().trim() : '';
}

function readSheet_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  const headers = values.shift() || [];
  const rows = values
    .filter(r => r.some(c => c !== ''))
    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
  return { headers, rows };
}

function getDraftTemplate_(subject) {
  const draft = GmailApp.getDrafts().find(d => d.getMessage().getSubject() === subject);
  if (!draft) throw new Error(`No Gmail draft found with subject "${subject}".`);
  const msg = draft.getMessage();

  // Map inline images by their cid so they render in the sent mail.
  const all = msg.getAttachments({ includeInlineImages: true, includeAttachments: false });
  const imgTags = msg.getBody().match(/<img[^>]+>/g) || [];
  const inlineImages = {};
  imgTags.forEach(tag => {
    const cid = (tag.match(/cid:([^"'\s>]+)/) || [])[1];
    const alt = (tag.match(/alt="([^"]*)"/) || [])[1];
    const img = all.find(a => a.getName() === alt);
    if (cid && img) inlineImages[cid] = img;
  });

  return {
    subject: msg.getSubject(),
    text: msg.getPlainBody(),
    html: msg.getBody(),
    attachments: msg.getAttachments({ includeInlineImages: false }),
    inlineImages,
  };
}

function fillTemplate_(template, row) {
  const replace = (str, escapeHtml) => str.replace(/{{\s*([^}]+?)\s*}}/g, (m, key) => {
    if (!(key in row)) return m;
    const v = String(row[key]);
    return escapeHtml ? v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : v;
  });
  // Gmail HTML may encode braces; normalise before substituting.
  const html = template.html.replace(/&#123;/g, '{').replace(/&#125;/g, '}');
  return {
    subject: replace(template.subject, false),
    text: replace(template.text, false),
    html: replace(html, true),
  };
}
