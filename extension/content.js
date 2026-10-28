// Adds a "Mail Merge" button to Gmail for whichever account is open in this tab.
function currentAccount() {
  const m = document.title.match(/[^\s<>()"]+@[^\s<>()"]+/);
  if (m) return m[0];
  const el = document.querySelector('a[aria-label*="@"]');
  return el?.getAttribute('aria-label')?.match(/[^\s<>()"]+@[^\s<>()"]+/)?.[0] || '';
}

function inject() {
  if (document.getElementById('mm-launch')) return;
  const btn = document.createElement('button');
  btn.id = 'mm-launch';
  btn.textContent = '✉ Mail Merge';
  btn.title = 'Start a mail merge from this Gmail account';
  btn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open', account: currentAccount() }));
  document.body.appendChild(btn);
}

new MutationObserver(inject).observe(document.documentElement, { childList: true, subtree: false });
inject();
