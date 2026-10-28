import { sendMessage, getThread, getMessageId, searchSenders, extractEmail } from './gmail.js';
import { personalise, htmlToText } from './merge.js';

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('tick', { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'tick') runQueue(); });

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: 'app.html' }));
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'open') chrome.tabs.create({ url: 'app.html?account=' + encodeURIComponent(msg.account || '') });
  if (msg.type === 'run') runQueue().then(() => reply(true));
  return msg.type === 'run';
});

let running = false;

async function runQueue() {
  if (running) return;
  running = true;
  try {
    const { campaigns = {} } = await chrome.storage.local.get('campaigns');
    for (const c of Object.values(campaigns)) {
      if (c.status !== 'running' || (c.settings.scheduleAt && c.settings.scheduleAt > Date.now())) continue;
      try {
        await processCampaign(c);
      } catch (e) {
        c.lastError = e.message;
      }
      await saveCampaign(c);
    }
  } finally {
    running = false;
  }
}

async function saveCampaign(c) {
  const { campaigns = {} } = await chrome.storage.local.get('campaigns');
  // Keep a pause/stop made from the UI while this run was in progress.
  if (campaigns[c.id]?.status === 'paused' && c.status === 'running') c.status = 'paused';
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
    if (await dailyCount(account) >= s.dailyLimit) { c.lastError = 'Daily limit reached; resumes tomorrow.'; break; }
    const to = extractEmail(r.data[c.emailCol] || '');
    if (unsub.has(to)) { r.state = 'unsubscribed'; continue; }
    try {
      const res = await sendMessage(account, buildMessage(c, c.template, r, to));
      Object.assign(r, { state: 'sent', messageId: res.id, threadId: res.threadId, sentAt: Date.now(), lastAt: Date.now(), followups: 0 });
      await dailyCount(account, 1);
      sentThisTick++;
      if (s.delaySec > 1) await new Promise(ok => setTimeout(ok, Math.min(s.delaySec, 20) * 1000));
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
    // Only poll threads when something could change: follow-up due, or periodic reply check (every 30 min).
    if (!due && now - (r.checkedAt || 0) < 30 * 60_000) continue;
    r.checkedAt = now;
    try {
      const thread = await getThread(account, r.threadId);
      const others = thread.messages.map(m => extractEmail(m.payload.headers.find(h => h.name === 'From')?.value || ''))
        .filter(f => f && f !== account.toLowerCase());
      if (others.some(f => /mailer-daemon|postmaster/.test(f))) { r.state = 'bounced'; continue; }
      if (others.length) { r.state = 'replied'; r.repliedAt = now; continue; }
      if (!due || sentThisTick >= perTick) continue;
      if (await dailyCount(account) >= s.dailyLimit) break;
      const to = extractEmail(r.data[c.emailCol] || '');
      if (unsub.has(to)) { r.state = 'unsubscribed'; continue; }
      const last = thread.messages[thread.messages.length - 1];
      const inReplyTo = await getMessageId(account, last.id);
      const tpl = { subject: 'Re: ' + c.template.subject.replace(/^re:\s*/i, ''), html: next.html, attachments: [] };
      await sendMessage(account, { ...buildMessage(c, tpl, r, to), threadId: r.threadId, inReplyTo });
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
    chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'Mail Merge finished', message: `Campaign "${c.name}" is complete.` });
  }
}

function buildMessage(c, tpl, r, to) {
  const s = c.settings;
  let html = personalise(tpl.html, r.data, true);
  if (s.unsubscribe) {
    html += `<p style="font-size:11px;color:#888">If you'd prefer not to hear from me, <a href="mailto:${c.account}?subject=unsubscribe">click here to unsubscribe</a>.</p>`;
  }
  return {
    to,
    cc: s.ccCol ? r.data[s.ccCol] : '',
    bcc: s.bcc || '',
    subject: personalise(tpl.subject, r.data),
    html,
    text: htmlToText(html),
    attachments: tpl.attachments,
    unsubscribe: s.unsubscribe,
  };
}
