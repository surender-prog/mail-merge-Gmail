import { sendMessage, getThread, getMessageId, searchSenders, extractEmail, getDriveFile, writeColumn } from './gmail.js';
import { personalise, htmlToText } from './merge.js';
import { TRACKING_URL } from './config.js';

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'tick') runQueue(); });

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'app.html' }));
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'open') chrome.tabs.create({ url: 'app.html?account=' + encodeURIComponent(msg.account || '') });
  if (msg.type === 'run') { runQueue().then(() => reply(true)); return true; }
  if (msg.type === 'test') { sendTest(msg.campaign).then(() => reply({ ok: true }), e => reply({ error: e.message })); return true; }
});

let running = false;

async function runQueue() {
  if (running) return;
  running = true;
  try {
    const { campaigns = {} } = await chrome.storage.local.get('campaigns');
    for (const c of Object.values(campaigns)) {
      if (c.trackId && c.status !== 'draft') await refreshTracking(c).catch(() => {});
      if (c.status === 'running' && !(c.settings.scheduleAt > Date.now())) {
        try {
          c.lastError = '';
          await processCampaign(c);
        } catch (e) {
          c.lastError = e.message;
        }
      }
      if (c.source?.type === 'sheet' && c.settings.writeStatus) await writeStatus(c).catch(e => { c.lastError = e.message; });
      await saveCampaign(c);
    }
  } finally {
    running = false;
  }
}

async function saveCampaign(c) {
  const { campaigns = {} } = await chrome.storage.local.get('campaigns');
  const current = campaigns[c.id];
  if (!current) return; // deleted from the UI meanwhile
  // Keep a pause made from the UI while this run was in progress.
  if (current.status === 'paused' && c.status === 'running') c.status = 'paused';
  campaigns[c.id] = c;
  await chrome.storage.local.set({ campaigns });
}

async function dailyCount(account, add = 0) {
  const key = `sent:${account}:${new Date().toDateString()}`;
  const { [key]: n = 0 } = await chrome.storage.local.get(key);
  if (add) await chrome.storage.local.set({ [key]: n + add });
  return n + add;
}

async function suppressed(account) {
  const key = 'unsub:' + account;
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  try {
    const found = await searchSenders(account, 'subject:unsubscribe newer_than:30d');
    const merged = [...new Set([...list, ...found])];
    await chrome.storage.local.set({ [key]: merged });
    return new Set(merged);
  } catch {
    return new Set(list);
  }
}

const FOLLOWUP_CONDITIONS = {
  noreply: () => true,
  notopened: r => !r.opens,
  openednoclick: r => r.opens > 0 && !r.clicks,
  opened: r => r.opens > 0,
};

async function processCampaign(c) {
  const s = c.settings;
  const account = c.account;
  const perTick = Math.max(1, Math.floor(60 / Math.max(1, s.delaySec)));
  const unsub = s.unsubscribe ? await suppressed(account) : new Set();
  let sentThisTick = 0;

  // 1. Initial sends
  for (const r of c.rows) {
    if (sentThisTick >= perTick) break;
    if (r.state !== 'pending') continue;
    if (await dailyCount(account) >= s.dailyLimit) { c.lastError = 'Daily limit reached; sending resumes tomorrow.'; break; }
    const to = extractEmail(r.data[c.emailCol] || '');
    if (!to) { Object.assign(r, { state: 'error', error: 'No valid email address' }); continue; }
    if (unsub.has(to)) { r.state = 'unsubscribed'; continue; }
    try {
      const msg = await buildMessage(c, c.template, r, to, true);
      const res = await sendMessage(account, msg);
      Object.assign(r, { state: 'sent', messageId: res.id, threadId: res.threadId, sentAt: Date.now(), lastAt: Date.now(), followups: 0 });
      await dailyCount(account, 1);
      sentThisTick++;
      if (s.delaySec > 1 && sentThisTick < perTick) await new Promise(ok => setTimeout(ok, Math.min(s.delaySec, 20) * 1000));
    } catch (e) {
      Object.assign(r, { state: 'error', error: e.message });
    }
  }

  // 2. Replies, bounces and follow-ups
  const now = Date.now();
  for (const r of c.rows) {
    if (r.state !== 'sent' || !r.threadId) continue;
    const next = s.followups[r.followups];
    const due = next && now - r.lastAt >= next.days * 86_400_000;
    // Poll threads only when a follow-up is due, or every 30 minutes to pick up replies.
    if (!due && now - (r.checkedAt || 0) < 30 * 60_000) continue;
    r.checkedAt = now;
    try {
      const thread = await getThread(account, r.threadId);
      const others = thread.messages.map(m => extractEmail(m.payload.headers.find(h => h.name === 'From')?.value || ''))
        .filter(f => f && f !== account.toLowerCase());
      if (others.some(f => /mailer-daemon|postmaster/.test(f))) { r.state = 'bounced'; continue; }
      if (others.length) { r.state = 'replied'; r.repliedAt = now; continue; }
      if (!due || sentThisTick >= perTick) continue;
      if (!(FOLLOWUP_CONDITIONS[next.condition] || FOLLOWUP_CONDITIONS.noreply)(r)) {
        // Condition not met: skip this step and move on to the next one.
        r.followups++;
        r.lastAt = now;
        continue;
      }
      if (await dailyCount(account) >= s.dailyLimit) break;
      const to = extractEmail(r.data[c.emailCol] || '');
      if (unsub.has(to)) { r.state = 'unsubscribed'; continue; }
      const last = thread.messages[thread.messages.length - 1];
      const inReplyTo = await getMessageId(account, last.id);
      const tpl = { subject: 'Re: ' + c.template.subject.replace(/^re:\s*/i, ''), html: next.html, attachments: [] };
      const msg = await buildMessage(c, tpl, r, to, false);
      await sendMessage(account, { ...msg, threadId: r.threadId, inReplyTo });
      r.followups++;
      r.lastAt = Date.now();
      await dailyCount(account, 1);
      sentThisTick++;
    } catch (e) {
      r.error = e.message;
    }
  }

  const open = c.rows.some(r => r.state === 'pending' || (r.state === 'sent' && s.followups[r.followups]));
  if (!open) {
    c.status = 'done';
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title: 'Mail Merge finished', message: `Campaign "${c.name}" is complete.` });
  }
}

async function buildMessage(c, tpl, r, to, withRowFiles) {
  const s = c.settings;
  let html = personalise(tpl.html, r.data, true);
  if (s.unsubscribe) {
    html += `<p style="font-size:11px;color:#888">If you'd prefer not to hear from me, <a href="mailto:${c.account}?subject=unsubscribe">click here to unsubscribe</a>.</p>`;
  }
  const text = htmlToText(html);
  if (c.trackId && TRACKING_URL) html = addTracking(html, c.trackId, r.id, s);

  const attachments = [...(tpl.attachments || [])];
  if (withRowFiles && s.attachCol && r.data[s.attachCol]) {
    for (const ref of r.data[s.attachCol].split(/[\s,;]+/).filter(Boolean)) {
      attachments.push(await getDriveFile(c.account, ref));
    }
  }
  return {
    to,
    cc: s.ccCol ? r.data[s.ccCol] : '',
    bcc: [s.bccCol ? r.data[s.bccCol] : '', s.bcc].filter(Boolean).join(', '),
    subject: personalise(tpl.subject, r.data),
    html,
    text,
    attachments,
    unsubscribe: s.unsubscribe,
  };
}

function addTracking(html, trackId, rowId, s) {
  const q = `c=${trackId}&r=${rowId}`;
  if (s.trackClicks) {
    html = html.replace(/(<a\b[^>]*\bhref=")(https?:\/\/[^"]+)(")/gi,
      (m, a, url, b) => `${a}${TRACKING_URL}/c?${q}&u=${encodeURIComponent(url.replace(/&amp;/g, '&'))}${b}`);
  }
  if (s.trackOpens) html += `<img src="${TRACKING_URL}/o?${q}" width="1" height="1" alt="" style="display:none">`;
  return html;
}

async function refreshTracking(c) {
  if (!TRACKING_URL || c.status === 'draft') return;
  // Stop polling a finished campaign after 30 days.
  if (c.status === 'done' && Date.now() - (c.createdAt || 0) > 30 * 86_400_000) return;
  const res = await fetch(`${TRACKING_URL}/stats?c=${c.trackId}`);
  if (!res.ok) return;
  const stats = await res.json();
  for (const r of c.rows) {
    const st = stats[r.id];
    if (st) Object.assign(r, { opens: st.opens, clicks: st.clicks, openedAt: st.firstOpen, clickedUrls: st.urls });
  }
}

const STATUS_LABEL = {
  pending: 'Scheduled', sent: 'Sent', replied: 'Replied', bounced: 'Bounced',
  unsubscribed: 'Unsubscribed', error: 'Error',
};

async function writeStatus(c) {
  const values = ['Merge status'];
  for (const r of c.rows) values[r.sheetRow] = (() => {
    let v = STATUS_LABEL[r.state] || r.state;
    if (r.state === 'error') v += ': ' + r.error;
    if (r.sentAt) v += ' ' + new Date(r.sentAt).toLocaleString();
    if (r.opens) v += ` · opened ${r.opens}x`;
    if (r.clicks) v += ` · clicked ${r.clicks}x`;
    if (r.followups) v += ` · ${r.followups} follow-up(s)`;
    return v;
  })();
  for (let i = 0; i < values.length; i++) values[i] ??= '';
  const key = JSON.stringify(values);
  if (key === c.lastWritten) return;
  await writeColumn(c.account, c.source, c.source.statusCol, values);
  c.lastWritten = key;
}

async function sendTest(c) {
  const r = c.rows[0];
  const msg = await buildMessage({ ...c, trackId: null }, c.template, r, c.account, true);
  await sendMessage(c.account, { ...msg, to: c.account, cc: '', bcc: '', subject: '[TEST] ' + msg.subject });
}
