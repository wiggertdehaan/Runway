/**
 * Command palette (Ctrl/Cmd+K, or the Search button).
 *
 * What it may list is decided on the server, per viewer, and shipped as
 * JSON inside the page: an owner never receives another person's app
 * names or an admin-only page, so there is nothing to filter out in the
 * browser. Every entry is plain navigation (a GET link) or the local
 * theme toggle; nothing in here changes server state, so it needs no
 * CSRF token and no confirmation.
 *
 * The client side is vanilla JS (no framework), built with DOM nodes and
 * textContent so an app name can never inject markup.
 */

export interface PaletteItem {
  /** Group heading: "Go to", "Apps" or "Actions". */
  g: "Go to" | "Apps" | "Actions";
  /** Visible label. */
  t: string;
  /** Link target; absent for client-side actions. */
  h?: string;
  /** Extra search words that are not in the label. */
  k?: string;
  /** Client-side action id (only "theme" exists). */
  a?: "theme";
}

export interface PaletteApp {
  id: string;
  name: string | null;
}

/** The entries one viewer may see. Pure: easy to test per role. */
export function buildPaletteItems(opts: { admin: boolean; apps: PaletteApp[] }): PaletteItem[] {
  const items: PaletteItem[] = [
    { g: "Go to", t: "Overview", h: "/overview", k: "inbox attention needs action statistics summary" },
    { g: "Go to", t: "Apps", h: "/", k: "home list" },
    { g: "Go to", t: "Security", h: "/security", k: "kev quarantine vulnerabilities risk" },
  ];
  if (opts.admin) {
    items.push(
      { g: "Go to", t: "Rebuild", h: "/rebuild", k: "run schedule update dependencies" },
      { g: "Go to", t: "Audit", h: "/audit", k: "activity log history" },
      { g: "Go to", t: "Health", h: "/health", k: "status server disk" },
      { g: "Go to", t: "Users", h: "/users", k: "members people 2fa access" },
      { g: "Go to", t: "Skills", h: "/skills", k: "agent instructions" },
      { g: "Go to", t: "Settings", h: "/settings", k: "domain webhook sso email" }
    );
  }
  items.push({ g: "Go to", t: "Account", h: "/account", k: "password token profile" });
  for (const app of opts.apps) {
    // An app that was never deployed has no name yet and is not worth a search hit.
    if (!app.name) continue;
    items.push({ g: "Apps", t: app.name, h: `/apps/${encodeURIComponent(app.id)}`, k: "open app" });
  }
  items.push({ g: "Actions", t: "Toggle light or dark theme", a: "theme", k: "theme dark light mode appearance" });
  return items;
}

/** JSON that is safe inside a <script type="application/json"> element. */
export function paletteJson(items: PaletteItem[]): string {
  return JSON.stringify(items)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const SEARCH_ICON =
  '<svg class="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

/** The two buttons that open the palette: sidebar (laptop) and top bar (phone). */
export function paletteButtons(): { side: string; top: string } {
  return {
    side: `<button type="button" class="side-btn pal-open" data-act="palette" aria-haspopup="dialog" title="Search pages and apps">${SEARCH_ICON}<span class="lb">Search</span><kbd class="lb" data-kbd>Ctrl K</kbd></button>`,
    top: `<button type="button" class="menu-btn pal-top" data-act="palette" aria-haspopup="dialog" aria-label="Search pages and apps">${SEARCH_ICON}</button>`,
  };
}

/** The dialog shell (closed) plus its data. Rendered once per page, at the end of <body>. */
export function renderPalette(items: PaletteItem[]): string {
  return `<div class="pal-scrim" id="palette" aria-hidden="true">
  <div class="pal" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="pal-i">${SEARCH_ICON}<input id="pal-q" type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-label="Search pages and apps" placeholder="Search pages and apps" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <ul id="pal-list" role="listbox" aria-label="Results"></ul>
    <div class="pal-foot" aria-hidden="true"><span>Up/Down to move</span><span>Enter to open</span><span>Esc to close</span></div>
  </div>
</div>
<script type="application/json" id="palette-data">${paletteJson(items)}</script>`;
}

export const PALETTE_CSS = `
.pal-scrim{position:fixed;inset:0;background:rgba(10,10,10,.45);display:none;z-index:80;align-items:flex-start;justify-content:center;padding:12vh 16px 16px}
.pal-scrim.open{display:flex}
.pal{width:100%;max-width:560px;background:var(--bg);color:var(--tx);border:1px solid var(--line2);border-radius:12px;box-shadow:var(--sh);overflow:hidden}
.pal-i{display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--line);height:48px;color:var(--mu)}
.pal-i input{flex:1;min-width:0;border:0;background:none;outline:0;height:46px;color:var(--tx);font-size:16px;padding:0;box-shadow:none}
.pal ul{list-style:none;margin:0;max-height:min(340px,55vh);overflow:auto;padding:6px}
.pal li[role=option]{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:var(--r2);cursor:pointer;min-height:40px}
.pal li[aria-selected=true]{background:var(--bg2);box-shadow:inset 0 0 0 1px var(--line2)}
.pal li small{margin-left:auto;color:var(--mu);font-size:var(--fs-xs)}
.pal .pal-gh{padding:8px 10px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mu)}
.pal .pal-none{padding:14px 10px;color:var(--mu);font-size:var(--fs-s)}
.pal-foot{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--line);color:var(--mu);font-size:var(--fs-xs)}
.pal-open kbd{margin-left:auto;font:11px ui-monospace,monospace;border:1px solid var(--line2);border-radius:4px;padding:0 5px;color:var(--mu)}
.pal-top{display:none;margin-left:auto}
@media (max-width:899px){.pal-open{display:none}.pal-top{display:grid}.pal-scrim{padding-top:8vh}.pal-foot{display:none}}
html[data-side=collapsed] .pal-open kbd{display:none}
`;

/**
 * Browser half. `paletteRank` is a plain global so the unit tests can run
 * it in a vm; the wiring below only starts when the dialog exists.
 */
export const PALETTE_JS = `
var PAL_ORDER = ['Go to', 'Apps', 'Actions'];
var PAL_EMPTY_APP_CAP = 6;
var PAL_MAX = 30;
// Filter and order the entries for a query. Every word of the query must
// hit the label, the extra search words or the group; a hit at the start
// of the label ranks first. With no query, only a few apps are listed.
function paletteRank(items, query) {
  var tokens = String(query || '').toLowerCase().split(/\\s+/).filter(Boolean);
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var title = String(it.t || '').toLowerCase();
    var words = title.split(/[^a-z0-9]+/).filter(Boolean);
    var hay = title + ' ' + String(it.k || '').toLowerCase() + ' ' + String(it.g || '').toLowerCase();
    var score = 0, ok = true;
    for (var j = 0; j < tokens.length && ok; j++) {
      var tk = tokens[j];
      if (title.indexOf(tk) === 0) score += 0;
      else if (words.some(function(w) { return w.indexOf(tk) === 0; })) score += 1;
      else if (title.indexOf(tk) !== -1) score += 2;
      else if (hay.indexOf(tk) !== -1) score += 3;
      else ok = false;
    }
    if (ok) out.push({ item: it, score: score, idx: i });
  }
  out.sort(function(a, b) {
    var ga = PAL_ORDER.indexOf(a.item.g), gb = PAL_ORDER.indexOf(b.item.g);
    return ga - gb || a.score - b.score || a.idx - b.idx;
  });
  var res = out.map(function(o) { return o.item; });
  if (!tokens.length) {
    var apps = 0;
    res = res.filter(function(it) { return it.g !== 'Apps' || ++apps <= PAL_EMPTY_APP_CAP; });
  }
  return res.slice(0, PAL_MAX);
}
(function() {
  var scrim = document.getElementById('palette');
  if (!scrim) return;
  var input = document.getElementById('pal-q');
  var list = document.getElementById('pal-list');
  var data = [];
  try { data = JSON.parse(document.getElementById('palette-data').textContent) || []; } catch (e) {}
  var shown = [], sel = 0, opener = null;
  var isMac = /Mac|iPhone|iPad/.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));
  if (isMac) document.querySelectorAll('[data-kbd]').forEach(function(k) { k.textContent = '\\u2318K'; });

  function isOpen() { return scrim.classList.contains('open'); }
  function render() {
    shown = paletteRank(data, input.value);
    if (sel >= shown.length) sel = Math.max(0, shown.length - 1);
    list.textContent = '';
    if (!shown.length) {
      var none = document.createElement('li');
      none.className = 'pal-none';
      none.setAttribute('role', 'presentation');
      none.textContent = 'No results';
      list.appendChild(none);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    var group = '';
    shown.forEach(function(it, n) {
      if (it.g !== group) {
        group = it.g;
        var gh = document.createElement('li');
        gh.className = 'pal-gh';
        gh.setAttribute('role', 'presentation');
        gh.textContent = group;
        list.appendChild(gh);
      }
      var li = document.createElement('li');
      li.id = 'pal-o-' + n;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', n === sel ? 'true' : 'false');
      li.setAttribute('data-n', String(n));
      var label = document.createElement('span');
      label.textContent = it.t;
      li.appendChild(label);
      list.appendChild(li);
    });
    input.setAttribute('aria-activedescendant', 'pal-o-' + sel);
    var cur = document.getElementById('pal-o-' + sel);
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function setBackground(inert) {
    var shell = document.querySelector('.shell');
    if (!shell) return;
    if (inert) shell.setAttribute('inert', ''); else shell.removeAttribute('inert');
  }
  function open() {
    // After a close the hidden input can still be document.activeElement for a frame:
    // never remember the palette itself as the thing to return to.
    var active = document.activeElement;
    opener = active && !scrim.contains(active) ? active : null;
    scrim.classList.add('open');
    scrim.setAttribute('aria-hidden', 'false');
    setBackground(true);
    document.documentElement.removeAttribute('data-menu');
    input.value = '';
    sel = 0;
    render();
    input.focus();
  }
  function close() {
    scrim.classList.remove('open');
    scrim.setAttribute('aria-hidden', 'true');
    setBackground(false);
    input.blur();
    if (opener && opener.focus && document.contains(opener)) opener.focus();
    opener = null;
  }
  function choose(it) {
    if (!it) return;
    if (it.a === 'theme') {
      close();
      var b = document.querySelector('[data-act=theme]');
      if (b) b.click();
      return;
    }
    if (it.h) { close(); location.href = it.h; }
  }
  function move(delta) {
    if (!shown.length) return;
    sel = (sel + delta + shown.length) % shown.length;
    render();
  }

  document.querySelectorAll('[data-act=palette]').forEach(function(b) { b.addEventListener('click', open); });
  input.addEventListener('input', function() { sel = 0; render(); });
  list.addEventListener('click', function(e) {
    var li = e.target && e.target.closest ? e.target.closest('[data-n]') : null;
    if (li) choose(shown[Number(li.getAttribute('data-n'))]);
  });
  list.addEventListener('mousemove', function(e) {
    var li = e.target && e.target.closest ? e.target.closest('[data-n]') : null;
    if (!li) return;
    var n = Number(li.getAttribute('data-n'));
    if (n !== sel) {
      sel = n;
      list.querySelectorAll('[role=option]').forEach(function(o) {
        o.setAttribute('aria-selected', o.getAttribute('data-n') === String(n) ? 'true' : 'false');
      });
      input.setAttribute('aria-activedescendant', 'pal-o-' + n);
    }
  });
  scrim.addEventListener('click', function(e) { if (e.target === scrim) close(); });
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (isOpen()) close(); else open();
      return;
    }
    if (!isOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home' && shown.length) { e.preventDefault(); sel = 0; render(); }
    else if (e.key === 'End' && shown.length) { e.preventDefault(); sel = shown.length - 1; render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(shown[sel]); }
    // The input is the only control in the dialog: keep Tab inside it.
    else if (e.key === 'Tab') { e.preventDefault(); input.focus(); }
  }, true);
})();
`;
