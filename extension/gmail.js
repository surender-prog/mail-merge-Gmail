import { CLIENT_ID } from './config.js';

const SCOPES = [
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

// Tokens are kept per Gmail account, so any number of accounts can be used.
export async function getToken(account, interactive = false) {
  const key = 'token:' + account;
  const { [key]: saved } = await chrome.storage.local.get(key);
  if (saved && saved.expires > Date.now() + 60_000) return saved.token;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPES.join(' '),
    login_hint: account,
    ...(interactive ? { prompt: 'consent' } : { prompt: 'none' }),
  });
  const redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  const p = new URLSearchParams(new URL(redirect).hash.slice(1));
  if (p.get('error')) throw new Error('Google sign-in failed: ' + p.get('error'));
  const token = p.get('access_token');

  const info = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  if (info.email.toLowerCase() !== account.toLowerCase()) {
    throw new Error(`Signed in as ${info.email}, expected ${account}.`);
  }
  await chrome.storage.local.set({ [key]: { token, expires: Date.now() + p.get('expires_in') * 1000 } });
  return token;
}

async function api(account, url, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(account);
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...opts.headers },
    });
    if (res.status === 401 && attempt === 0) {
      await chrome.storage.local.remove('token:' + account);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || res.statusText);
    return body;
  }
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export async function listDrafts(account) {
  const { drafts = [] } = await api(account, `${GMAIL}/drafts?maxResults=50`);
  return Promise.all(drafts.map(async d => {
    const full = await api(account, `${GMAIL}/drafts/${d.id}?format=metadata&metadataHeaders=Subject`);
    const subject = full.message.payload.headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    return { id: d.id, subject };
  }));
}

// Returns { subject, html, text, attachments: [{filename, mimeType, data(base64url), contentId}] }
export async function getDraftTemplate(account, draftId) {
  const { message } = await api(account, `${GMAIL}/drafts/${draftId}?format=full`);
  const out = { subject: '', html: '', text: '', attachments: [] };
  out.subject = message.payload.headers.find(h => h.name === 'Subject')?.value || '';

  async function walk(part) {
    const header = n => part.headers?.find(h => h.name.toLowerCase() === n)?.value;
    if (part.parts) { for (const p of part.parts) await walk(p); return; }
    if (part.filename) {
      let data = part.body.data;
      if (!data && part.body.attachmentId) {
        data = (await api(account, `${GMAIL}/messages/${message.id}/attachments/${part.body.attachmentId}`)).data;
      }
      const cid = header('content-id')?.replace(/[<>]/g, '');
      out.attachments.push({ filename: part.filename, mimeType: part.mimeType, data, contentId: cid });
    } else if (part.mimeType === 'text/html') {
      out.html = decodeB64(part.body.data);
    } else if (part.mimeType === 'text/plain') {
      out.text = decodeB64(part.body.data);
    }
  }
  await walk(message.payload);
  return out;
}

export async function sendMessage(account, { to, cc, bcc, subject, html, text, attachments = [], threadId, inReplyTo, unsubscribe }) {
  const raw = buildMime({ from: account, to, cc, bcc, subject, html, text, attachments, inReplyTo, unsubscribe });
  return api(account, `${GMAIL}/messages/send`, {
    method: 'POST',
    body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
  });
}

export async function getThread(account, threadId) {
  return api(account, `${GMAIL}/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID&metadataHeaders=Subject`);
}

export async function getMessageId(account, id) {
  const m = await api(account, `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=Message-ID`);
  return m.payload.headers.find(h => h.name.toLowerCase() === 'message-id')?.value;
}

export async function searchSenders(account, q) {
  const { messages = [] } = await api(account, `${GMAIL}/messages?maxResults=200&q=${encodeURIComponent(q)}`);
  const froms = await Promise.all(messages.map(async m => {
    const full = await api(account, `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From`);
    return extractEmail(full.payload.headers.find(h => h.name === 'From')?.value || '');
  }));
  return froms.filter(Boolean);
}

export async function readSheet(account, sheetUrl) {
  const id = sheetUrl.match(/\/d\/([\w-]+)/)?.[1] || sheetUrl;
  const gid = sheetUrl.match(/gid=(\d+)/)?.[1];
  const meta = await api(account, `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties`);
  const sheet = meta.sheets.find(s => gid && String(s.properties.sheetId) === gid) || meta.sheets[0];
  const range = encodeURIComponent(`'${sheet.properties.title}'`);
  const { values = [] } = await api(account, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}`);
  return values;
}

export function extractEmail(s) {
  return (s.match(/[^\s<>"',;]+@[^\s<>"',;]+/) || [''])[0].toLowerCase();
}

// ---- MIME helpers ----

function decodeB64(data = '') {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const wrap = s => s.replace(/.{1,76}/g, '$&\r\n');
const encodeHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const stdB64 = s => s.replace(/-/g, '+').replace(/_/g, '/');

function buildMime({ from, to, cc, bcc, subject, html, text, attachments, inReplyTo, unsubscribe }) {
  const id = () => 'b_' + crypto.randomUUID();
  const headers = [
    `From: ${from}`, `To: ${to}`,
    cc && `Cc: ${cc}`, bcc && `Bcc: ${bcc}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    inReplyTo && `In-Reply-To: ${inReplyTo}`, inReplyTo && `References: ${inReplyTo}`,
    unsubscribe && `List-Unsubscribe: <mailto:${from}?subject=unsubscribe>`,
  ].filter(Boolean);

  const alt = id();
  const altPart = [
    `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(text || '')),
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(html || '')),
    `--${alt}--`,
  ].join('\r\n');

  const filePart = a => [
    `Content-Type: ${a.mimeType}; name="${encodeHeader(a.filename)}"`,
    'Content-Transfer-Encoding: base64',
    a.contentId ? `Content-ID: <${a.contentId}>` : '',
    `Content-Disposition: ${a.contentId ? 'inline' : 'attachment'}; filename="${encodeHeader(a.filename)}"`,
    '', wrap(stdB64(a.data)),
  ].filter((l, i) => l !== '' || i > 2).join('\r\n');

  const inline = attachments.filter(a => a.contentId);
  const files = attachments.filter(a => !a.contentId);

  let body = altPart;
  if (inline.length) {
    const rel = id();
    body = [`Content-Type: multipart/related; boundary="${rel}"`, '', `--${rel}`, altPart,
      ...inline.flatMap(a => [`--${rel}`, filePart(a)]), `--${rel}--`].join('\r\n');
  }
  if (files.length) {
    const mix = id();
    body = [`Content-Type: multipart/mixed; boundary="${mix}"`, '', `--${mix}`, body,
      ...files.flatMap(a => [`--${mix}`, filePart(a)]), `--${mix}--`].join('\r\n');
  }
  const mime = headers.join('\r\n') + '\r\n' + body;
  return b64(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
