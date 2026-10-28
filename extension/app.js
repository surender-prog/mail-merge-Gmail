import { getToken, listDrafts, getDraftTemplate, readSheet } from './gmail.js';
import { personalise, parseCsv, toCsv, isEmail } from './merge.js';
import { TRACKING_URL } from './config.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const state = { headers: [], rows: [], source: null, template: { attachments: [] }, draftId: null };

// ---------- Account ----------
const params = new URLSearchParams(location.search);
chrome.storage.local.get('lastAccount').then(({ lastAccount }) => {
  $('#account').value = params.get('account') || lastAccount || '';
  checkAuth();
});
const account = () => $('#account').value.trim().toLowerCase();

async function checkAuth() {
  if (!account()) return;
  try {
    await getToken(account(), false);
    $('#auth-state').textContent = '✓ connected';
    $('#signin').classList.add('hidden');
  } catch {
    $('#auth-state').textContent = '';
    $('#signin').classList.remove('hidden');
  }
}
$('#account').addEventListener('change', () => { chrome.storage.local.set({ lastAccount: account() }); checkAuth(); });
$('#signin').addEventListener('click', async () => {
  try {
    await getToken(account(), true);
    chrome.storage.local.set({ lastAccount: account() });
    checkAuth();
  } catch (e) { alert(e.message); }
});

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  $('#view-new').classList.toggle('hidden', t.dataset.view !== 'new');
  $('#view-dash').classList.toggle('hidden', t.dataset.view !== 'dash');
  if (t.dataset.view === 'dash') renderDashboard();
}));

// ---------- Recipients ----------
function setData(values, source) {
  const [headers, ...rest] = values;
  state.headers = headers.map(h => String(h).trim());
  state.source = source;
  state.rows = rest
    .map((r, i) => ({ sheetRow: i + 1, data: Object.fromEntries(state.headers.map((h, j) => [h, r[j] ?? ''])) }))
    .filter(r => Object.values(r.data).some(v => String(v).trim() !== ''));

  const guess = (re) => state.headers.find(h => re.test(h)) || '';
  const fill = (sel, val, optional) => {
    sel.innerHTML = (optional ? '<option value="">— none —</option>' : '') + state.headers.map(h => `<option>${esc(h)}</option>`).join('');
    sel.value = val;
  };
  fill($('#col-email'), guess(/^e-?mail|email/i) || state.headers[0]);
  fill($('#col-cc'), guess(/^cc$/i), true);
  fill($('#col-bcc'), guess(/^bcc$/i), true);
  fill($('#col-attach'), guess(/attach/i), true);
  $('#columns').classList.remove('hidden');
  $('#preview-row').innerHTML = state.rows.map((r, i) => `<option value="${i}">${i + 1}. ${esc(Object.values(r.data)[0])}</option>`).join('');
  renderTable();
  renderToolbars();
  renderPreview();
}

function renderTable() {
  const emailCol = $('#col-email').value;
  const valid = state.rows.filter(r => isEmail(r.data[emailCol])).length;
  $('#recipients-info').innerHTML = `<b>${state.rows.length}</b> rows loaded · <b>${valid}</b> valid email addresses` +
    (valid < state.rows.length ? ` · <span class="err">${state.rows.length - valid} invalid will be skipped</span>` : '');
  $('#table-wrap').innerHTML = `<table><tr>${state.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>` +
    state.rows.slice(0, 100).map(r => `<tr>${state.headers.map(h => `<td>${esc(r.data[h])}</td>`).join('')}</tr>`).join('') + '</table>';
}
$('#col-email').addEventListener('change', renderTable);

$('#load-sheet').addEventListener('click', async () => {
  try {
    const { id, title, values } = await readSheet(account(), $('#sheet-url').value.trim());
    if (!values.length) throw new Error('The sheet is empty.');
    setData(values, { type: 'sheet', id, title, url: $('#sheet-url').value.trim() });
    if (!$('#name').value) $('#name').value = title;
  } catch (e) { alert('Could not load sheet: ' + e.message); }
});

$('#csv').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  setData(parseCsv(await file.text()), { type: 'csv', name: file.name });
  if (!$('#name').value) $('#name').value = file.name.replace(/\.\w+$/, '');
});

// ---------- Editor ----------
function renderToolbars() {
  document.querySelectorAll('.toolbar').forEach(tb => {
    const target = () => document.getElementById(tb.dataset.for);
    tb.innerHTML = `
      <select data-cmd="fontName"><option value="">Font</option><option>Arial</option><option>Georgia</option><option>Times New Roman</option><option>Verdana</option><option>Courier New</option></select>
      <select data-cmd="fontSize"><option value="">Size</option><option value="2">Small</option><option value="3">Normal</option><option value="5">Large</option><option value="6">Huge</option></select>
      <button data-cmd="bold" title="Bold"><b>B</b></button>
      <button data-cmd="italic" title="Italic"><i>I</i></button>
      <button data-cmd="underline" title="Underline"><u>U</u></button>
      <input type="color" data-cmd="foreColor" title="Text colour" style="width:32px;padding:0;border:0">
      <button data-cmd="insertUnorderedList" title="Bullets">•</button>
      <button data-cmd="insertOrderedList" title="Numbering">1.</button>
      <button data-cmd="createLink" title="Link">🔗</button>
      <button data-cmd="insertImage" title="Image from URL">🖼</button>
      <button data-cmd="removeFormat" title="Clear formatting">⌫</button>
      <select data-field><option value="">Insert field…</option>${state.headers.map(h => `<option>${esc(h)}</option>`).join('')}</select>
      <button data-html title="Edit HTML source">&lt;/&gt;</button>`;
    tb.querySelectorAll('button[data-cmd]').forEach(b => b.addEventListener('mousedown', e => {
      e.preventDefault();
      const cmd = b.dataset.cmd;
      const arg = cmd === 'createLink' ? prompt('Link URL (fields allowed, e.g. {{link}})') : cmd === 'insertImage' ? prompt('Image URL') : null;
      if ((cmd === 'createLink' || cmd === 'insertImage') && !arg) return;
      document.execCommand(cmd, false, arg);
    }));
    tb.querySelectorAll('select[data-cmd], input[data-cmd]').forEach(s => s.addEventListener('change', () => {
      target().focus();
      if (s.value) document.execCommand(s.dataset.cmd, false, s.value);
      if (s.tagName === 'SELECT') s.value = '';
    }));
    tb.querySelector('[data-field]').addEventListener('change', e => {
      target().focus();
      document.execCommand('insertText', false, `{{${e.target.value}}}`);
      e.target.value = '';
    });
    tb.querySelector('[data-html]').addEventListener('click', () => {
      const el = target();
      if (el.dataset.source) {
        el.innerHTML = el.textContent; delete el.dataset.source; el.style.fontFamily = '';
      } else {
        el.textContent = el.innerHTML; el.dataset.source = '1'; el.style.fontFamily = 'monospace';
      }
    });
  });
}
const editorHtml = el => el.dataset.source ? el.textContent : el.innerHTML;

$('#from-draft').addEventListener('click', async () => {
  try {
    const drafts = await listDrafts(account());
    if (!drafts.length) return alert('No Gmail drafts found in ' + account());
    $('#drafts').innerHTML = '<option value="">Choose a draft…</option>' + drafts.map(d => `<option value="${d.id}">${esc(d.subject)}</option>`).join('');
    $('#drafts').classList.remove('hidden');
  } catch (e) { alert(e.message); }
});
$('#drafts').addEventListener('change', async e => {
  if (!e.target.value) return;
  const t = await getDraftTemplate(account(), e.target.value);
  state.template = { attachments: t.attachments };
  $('#subject').value = t.subject;
  $('#body').innerHTML = t.html || esc(t.text).replace(/\n/g, '<br>');
  $('#draft-info').textContent = t.attachments.length ? `${t.attachments.length} attachment(s) from the draft will be included.` : '';
  renderPreview();
});
$('#html-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const html = await f.text();
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  $('#body').innerHTML = body;
  renderPreview();
});

// ---------- Follow-ups ----------
let fuCount = 0;
function addFollowup(f = { days: 3, condition: 'noreply', html: '<p>Hi {{name}}, just following up on my previous email.</p>' }) {
  const id = 'fu' + (++fuCount);
  const div = document.createElement('div');
  div.className = 'followup';
  div.innerHTML = `
    <div class="row">
      <b>Follow-up</b> after <input type="number" min="0.1" step="0.5" value="${f.days}" class="fu-days" style="width:70px"> days if
      <select class="fu-cond">
        <option value="noreply">no reply</option>
        <option value="notopened">no reply and not opened</option>
        <option value="opened">no reply but opened</option>
        <option value="openednoclick">opened but no click</option>
      </select>
      <button class="danger fu-del">Remove</button>
    </div>
    <div class="toolbar" data-for="${id}"></div>
    <div id="${id}" class="editor small fu-body" contenteditable="true">${f.html}</div>`;
  div.querySelector('.fu-cond').value = f.condition;
  div.querySelector('.fu-del').addEventListener('click', () => div.remove());
  $('#followups').appendChild(div);
  renderToolbars();
}
$('#add-followup').addEventListener('click', () => addFollowup());

// ---------- Preview ----------
function renderPreview() {
  const r = state.rows[$('#preview-row').value || 0];
  if (!r) { $('#preview').innerHTML = '<span class="muted">Load recipients to see a preview.</span>'; return; }
  $('#preview').innerHTML = `<div class="meta"><b>To:</b> ${esc(r.data[$('#col-email').value])}<br><b>Subject:</b> ${esc(personalise($('#subject').value, r.data))}</div>` +
    personalise(editorHtml($('#body')), r.data, true);
}
['#preview-row', '#subject', '#body'].forEach(s => $(s).addEventListener('input', renderPreview));
$('#preview-row').addEventListener('change', renderPreview);

if (!TRACKING_URL) {
  ['#track-opens', '#track-clicks'].forEach(s => { $(s).checked = false; $(s).disabled = true; });
  $('#tracking-note').classList.remove('hidden');
}

// ---------- Build & start ----------
function buildCampaign() {
  if (!account()) throw new Error('Enter your Gmail address and sign in.');
  if (!state.rows.length) throw new Error('Load recipients first.');
  if (!$('#subject').value.trim()) throw new Error('Enter a subject.');
  const emailCol = $('#col-email').value;
  const settings = {
    delaySec: Math.max(1, +$('#delay').value || 5),
    dailyLimit: Math.max(1, +$('#daily').value || 500),
    scheduleAt: $('#schedule').value ? new Date($('#schedule').value).getTime() : 0,
    bcc: $('#bcc').value.trim(),
    ccCol: $('#col-cc').value, bccCol: $('#col-bcc').value, attachCol: $('#col-attach').value,
    trackOpens: $('#track-opens').checked, trackClicks: $('#track-clicks').checked,
    unsubscribe: $('#unsub').checked,
    writeStatus: $('#write-status').checked && state.source?.type === 'sheet',
    followups: [...document.querySelectorAll('.followup')].map(d => ({
      days: +d.querySelector('.fu-days').value || 1,
      condition: d.querySelector('.fu-cond').value,
      html: editorHtml(d.querySelector('.fu-body')),
    })),
  };
  const statusIdx = state.headers.indexOf('Merge status');
  const source = state.source?.type === 'sheet'
    ? { ...state.source, statusCol: statusIdx >= 0 ? statusIdx : state.headers.length }
    : state.source;
  return {
    id: crypto.randomUUID(),
    trackId: (settings.trackOpens || settings.trackClicks) ? crypto.randomUUID() : null,
    name: $('#name').value.trim() || $('#subject').value.trim(),
    account: account(),
    createdAt: Date.now(),
    status: 'running',
    emailCol,
    source,
    settings,
    template: { subject: $('#subject').value, html: editorHtml($('#body')), attachments: state.template.attachments || [] },
    rows: state.rows.map((r, i) => ({
      id: String(i + 1), sheetRow: r.sheetRow, data: r.data,
      state: isEmail(r.data[emailCol]) ? 'pending' : 'error',
      error: isEmail(r.data[emailCol]) ? '' : 'Invalid email address',
    })),
  };
}

$('#test').addEventListener('click', async () => {
  try {
    const c = buildCampaign();
    c.rows = [c.rows[$('#preview-row').value || 0]];
    $('#send-state').textContent = 'Sending test…';
    const res = await chrome.runtime.sendMessage({ type: 'test', campaign: c });
    $('#send-state').textContent = res.error ? '✗ ' + res.error : `✓ Test sent to ${c.account}`;
  } catch (e) { $('#send-state').textContent = '✗ ' + e.message; }
});

$('#start').addEventListener('click', async () => {
  try {
    const c = buildCampaign();
    const n = c.rows.filter(r => r.state === 'pending').length;
    const when = c.settings.scheduleAt ? 'at ' + new Date(c.settings.scheduleAt).toLocaleString() : 'now';
    if (!confirm(`Send "${c.name}" to ${n} recipients ${when} from ${c.account}?`)) return;
    const { campaigns = {} } = await chrome.storage.local.get('campaigns');
    campaigns[c.id] = c;
    await chrome.storage.local.set({ campaigns });
    chrome.runtime.sendMessage({ type: 'run' });
    document.querySelector('.tab[data-view="dash"]').click();
  } catch (e) { alert(e.message); }
});

// ---------- Dashboard ----------
function stats(c) {
  const n = k => c.rows.filter(r => r.state === k).length;
  const delivered = c.rows.filter(r => ['sent', 'replied'].includes(r.state)).length;
  const opened = c.rows.filter(r => r.opens > 0).length;
  const clicked = c.rows.filter(r => r.clicks > 0).length;
  const total = c.rows.filter(r => r.error !== 'Invalid email address').length;
  return {
    total, delivered, opened, clicked,
    pending: n('pending'), replied: n('replied'), bounced: n('bounced'), unsub: n('unsubscribed'), errors: n('error'),
    followups: c.rows.reduce((a, r) => a + (r.followups || 0), 0),
  };
}
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';

async function renderDashboard() {
  const { campaigns = {} } = await chrome.storage.local.get('campaigns');
  const list = Object.values(campaigns).sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) { $('#campaigns').innerHTML = '<section class="muted">No campaigns yet.</section>'; return; }
  $('#campaigns').innerHTML = list.map(c => {
    const s = stats(c);
    const sentTotal = s.total - s.pending;
    const label = c.status === 'running' && c.settings.scheduleAt > Date.now() ? 'scheduled ' + new Date(c.settings.scheduleAt).toLocaleString() : c.status;
    return `<section data-id="${c.id}">
      <div class="campaign">
        <h3>${esc(c.name)} <small class="muted">· ${esc(c.account)} · ${new Date(c.createdAt).toLocaleDateString()}</small></h3>
        <span class="badge ${c.status}">${esc(label)}</span>
        ${c.status === 'running' ? '<button data-act="pause">Pause</button>' : ''}
        ${c.status === 'paused' ? '<button data-act="resume">Resume</button>' : ''}
        <button data-act="detail">Details</button>
        <button data-act="export">Export CSV</button>
        <button data-act="delete" class="danger">Delete</button>
      </div>
      <div class="bar"><div style="width:${pct(sentTotal, s.total).replace('–', '0%')}"></div></div>
      <div class="cards">
        <div class="card"><b>${sentTotal}/${s.total}</b><small>Processed</small></div>
        <div class="card"><b>${pct(s.delivered, sentTotal)}</b><small>Delivered (${s.delivered})</small></div>
        <div class="card"><b>${c.trackId && c.settings.trackOpens ? pct(s.opened, s.delivered) : '–'}</b><small>Opened (${s.opened})</small></div>
        <div class="card"><b>${c.trackId && c.settings.trackClicks ? pct(s.clicked, s.delivered) : '–'}</b><small>Clicked (${s.clicked})</small></div>
        <div class="card"><b>${pct(s.replied, s.delivered)}</b><small>Replied (${s.replied})</small></div>
        <div class="card"><b>${s.bounced}</b><small>Bounced</small></div>
        <div class="card"><b>${s.unsub}</b><small>Unsubscribed</small></div>
        <div class="card"><b>${s.followups}</b><small>Follow-ups sent</small></div>
        <div class="card"><b class="${s.errors ? 'err' : ''}">${s.errors}</b><small>Errors</small></div>
      </div>
      ${c.lastError ? `<p class="err">${esc(c.lastError)}</p>` : ''}
    </section>`;
  }).join('');

  document.querySelectorAll('#campaigns [data-act]').forEach(b => b.addEventListener('click', async () => {
    const id = b.closest('section').dataset.id;
    const { campaigns = {} } = await chrome.storage.local.get('campaigns');
    const c = campaigns[id];
    const act = b.dataset.act;
    if (act === 'pause') c.status = 'paused';
    if (act === 'resume') c.status = 'running';
    if (act === 'delete') { if (!confirm(`Delete campaign "${c.name}"?`)) return; delete campaigns[id]; }
    if (act === 'export') return downloadCsv(c);
    if (act === 'detail') return renderDetail(c);
    await chrome.storage.local.set({ campaigns });
    if (act === 'resume') chrome.runtime.sendMessage({ type: 'run' });
    renderDashboard();
  }));
}

function rowsForExport(c) {
  const headers = Object.keys(c.rows[0]?.data || {});
  return [[...headers, 'Status', 'Sent at', 'Opens', 'Clicks', 'Follow-ups', 'Error'],
    ...c.rows.map(r => [...headers.map(h => r.data[h]), r.state, r.sentAt ? new Date(r.sentAt).toISOString() : '',
      r.opens || 0, r.clicks || 0, r.followups || 0, r.error || ''])];
}

function downloadCsv(c) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(rowsForExport(c))], { type: 'text/csv' }));
  a.download = c.name.replace(/[^\w-]+/g, '_') + '-report.csv';
  a.click();
}

function renderDetail(c) {
  const rows = rowsForExport(c);
  $('#detail').classList.remove('hidden');
  $('#detail').innerHTML = `<h2>${esc(c.name)} — recipients</h2><div id="table-wrap" style="max-height:480px">
    <table>${rows.map((r, i) => `<tr>${r.map(v => i ? `<td>${esc(v)}</td>` : `<th>${esc(v)}</th>`).join('')}</tr>`).join('')}</table></div>`;
  $('#detail').scrollIntoView({ behavior: 'smooth' });
}

chrome.storage.onChanged.addListener(ch => {
  if (ch.campaigns && !$('#view-dash').classList.contains('hidden')) renderDashboard();
});

renderToolbars();
renderPreview();
