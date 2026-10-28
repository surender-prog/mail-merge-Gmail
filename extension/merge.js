// Placeholders: {{Column}} or {{Column|fallback}}. Spintax: {Hi|Hello|Hey}.
export function personalise(str, row, escapeHtml = false) {
  const esc = v => escapeHtml ? v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : v;
  str = str.replace(/&#123;/g, '{').replace(/&#125;/g, '}');
  str = str.replace(/{{\s*([^}|]+?)\s*(?:\|\s*([^}]*?))?\s*}}/g, (m, key, fallback) => {
    const col = Object.keys(row).find(k => k.toLowerCase() === key.toLowerCase());
    const v = col !== undefined && row[col] !== '' ? row[col] : fallback;
    return v === undefined ? m : esc(String(v));
  });
  return str.replace(/{([^{}]*\|[^{}]*)}/g, (m, opts) => {
    const o = opts.split('|');
    return o[Math.floor(Math.random() * o.length)];
  });
}

export function htmlToText(html) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

export function toCsv(rows) {
  return rows.map(r => r.map(c => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
}

export const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
