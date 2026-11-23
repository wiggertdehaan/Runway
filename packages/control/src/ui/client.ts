/**
 * Small vanilla JS shipped with every dashboard page. It is inlined at
 * the END of <body> (see layout()), so `document.body` exists and every
 * element it touches is already parsed. Only the pre-paint snippet below
 * lives in <head>, and it touches <html> only.
 */

/** Runs in <head> before first paint: apply the saved theme and sidebar state, no flash. */
export const PREPAINT_JS = `(function(){try{var d=document.documentElement,s=localStorage;var t=s.getItem('runway-theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t);if(s.getItem('runway-side')==='collapsed')d.setAttribute('data-side','collapsed');}catch(e){}})();`;

export const CLIENT_JS = `
function filterApps() {
  var q = (document.getElementById('app-search') || {}).value || '';
  q = q.toLowerCase();
  var cards = document.querySelectorAll('.app-card[data-name]');
  var shown = 0;
  cards.forEach(function(c) {
    var match = !q || c.getAttribute('data-name').toLowerCase().indexOf(q) !== -1
      || (c.getAttribute('data-domain') || '').toLowerCase().indexOf(q) !== -1;
    c.style.display = match ? '' : 'none';
    if (match) shown++;
  });
  var empty = document.getElementById('no-match');
  if (empty) empty.style.display = shown === 0 && q ? '' : 'none';
}
// htmx events bubble, so one listener on document survives every swap.
// After the live-apps poll reinserts fresh cards, re-apply the search
// box so the user's query keeps hiding non-matching cards.
document.addEventListener('htmx:afterSwap', function(e) {
  var target = e && e.detail && e.detail.target;
  if (target && target.id === 'apps-live') filterApps();
});
document.addEventListener('click', function(e) {
  document.querySelectorAll('.overflow-menu[open]').forEach(function(m) {
    if (!m.contains(e.target)) m.removeAttribute('open');
  });
});
function featureToggle(checkbox) {
  var body = checkbox.closest('.card').querySelector('.feature-body');
  if (body) { body.classList.toggle('disabled', !checkbox.checked); }
}
function confirmDelete(form) {
  var expected = form.getAttribute('data-app-name');
  var input = prompt('Type "' + expected + '" to confirm deletion:');
  if (input !== expected) return false;
  return true;
}
function toggleSecret(btn) {
  var code = btn.previousElementSibling;
  if (code.textContent === '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022') {
    code.textContent = code.getAttribute('data-value');
    btn.textContent = 'Hide';
  } else {
    code.textContent = '\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022\\u2022';
    btn.textContent = 'Show';
  }
}
function copyText(btn) {
  var text = btn.getAttribute('data-copy');
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(function() { btn.textContent = orig; }, 1500);
  });
}
(function() {
  var root = document.documentElement;
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function isDark() {
    var t = root.getAttribute('data-theme');
    if (t) return t === 'dark';
    return !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function syncTheme() {
    document.querySelectorAll('[data-act=theme]').forEach(function(b) { b.setAttribute('aria-pressed', isDark() ? 'true' : 'false'); });
  }
  document.querySelectorAll('[data-act=theme]').forEach(function(b) {
    b.addEventListener('click', function() {
      var t = isDark() ? 'light' : 'dark';
      root.setAttribute('data-theme', t);
      store('runway-theme', t);
      syncTheme();
    });
  });
  syncTheme();

  document.querySelectorAll('[data-act=collapse]').forEach(function(b) {
    function sync() { b.setAttribute('aria-expanded', root.getAttribute('data-side') === 'collapsed' ? 'false' : 'true'); }
    b.addEventListener('click', function() {
      var next = root.getAttribute('data-side') === 'collapsed' ? 'open' : 'collapsed';
      if (next === 'open') root.removeAttribute('data-side'); else root.setAttribute('data-side', next);
      store('runway-side', next);
      sync();
    });
    sync();
  });

  var mb = document.getElementById('menubtn');
  if (mb) {
    function setMenu(open) {
      if (open) root.setAttribute('data-menu', 'open'); else root.removeAttribute('data-menu');
      mb.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    mb.addEventListener('click', function() { setMenu(root.getAttribute('data-menu') !== 'open'); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') setMenu(false); });
  }

  // Mark the current page in the sidebar: the longest href that prefixes the path.
  var path = location.pathname, best = null, len = 0;
  document.querySelectorAll('.side-nav a.nav-link').forEach(function(a) {
    var h = a.getAttribute('href');
    var hit = h === '/' ? (path === '/' || path.indexOf('/apps') === 0) : (path === h || path.indexOf(h + '/') === 0);
    if (hit && h.length >= len) { best = a; len = h.length; }
  });
  if (best) best.setAttribute('aria-current', 'page');
})();
`;
