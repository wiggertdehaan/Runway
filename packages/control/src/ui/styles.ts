import { themeCss } from "./tokens.js";

/**
 * Dashboard stylesheet. Inlined by layout() so the login page needs no
 * extra round trip and the CSP can stay `style-src 'self' 'unsafe-inline'`.
 *
 * Order: tokens, legacy aliases, base, shell, components. Component rules
 * only reference variables, never hex values, so both themes work.
 *
 * The aliases keep the names that existing markup and inline styles use
 * (--bg-card, --border, --text-muted, --status-*, --brand), so every
 * page picks up the new palette without being rewritten. Later PRs
 * replace the aliases screen by screen.
 */
const ALIASES = `
:root{
  --bg-card:var(--bg);--bg-inset:var(--bg2);--border:var(--line);
  --text:var(--tx);--text-muted:var(--mu);--text-dim:var(--mu);
  --brand:var(--tx);--brand-hover:var(--mu);
  --status-success:var(--ok);--status-success-bg:var(--okbg);
  --status-warn:var(--warn);--status-warn-bg:var(--warnbg);
  --status-error:var(--err);--status-error-bg:var(--errbg);
  --status-info:var(--tx);--status-info-bg:var(--line);
  --status-neutral:var(--mu);--status-neutral-bg:var(--line);
  --fs-xs:12px;--fs-s:13px;--fs-m:14px;--fs-l:16px;
  --r1:6px;--r2:8px;--r3:10px;
}`;

const BASE = `
*{margin:0;padding:0;box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{font:var(--fs-m)/1.5 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--tx);-webkit-font-smoothing:antialiased}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:var(--r1)}
h1{font-size:1.75rem;font-weight:650;margin-bottom:1.5rem;letter-spacing:-0.03em;line-height:1.15}
h2{font-size:1.1rem}
img,pre,table{max-width:100%}
pre{overflow-x:auto}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.skip{position:absolute;left:-999px;top:8px;background:var(--inv);color:var(--invtx);padding:8px 12px;border-radius:var(--r1);z-index:100}
.skip:focus{left:8px}
`;

const SHELL = `
.shell{--sw:232px;display:grid;grid-template-columns:var(--sw) minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:12px 8px;overflow:hidden}
.side-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em;padding:4px 8px 12px;min-height:44px;color:var(--tx);text-decoration:none}
.mark{width:24px;height:24px;border-radius:var(--r1);background:var(--inv);color:var(--invtx);display:grid;place-items:center;flex:none}
.side-body{display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto}
.side-nav{display:flex;flex-direction:column;gap:2px}
.side a.nav-link,.side-btn{display:flex;align-items:center;gap:10px;height:36px;padding:0 10px;border-radius:var(--r2);color:var(--mu);font-weight:500;white-space:nowrap;text-decoration:none;background:none;border:0;width:100%;text-align:left;font-size:var(--fs-m);cursor:pointer}
.side a.nav-link:hover,.side-btn:hover{background:var(--bg);color:var(--tx)}
.side a.nav-link[aria-current=page]{background:var(--bg);color:var(--tx);box-shadow:inset 0 0 0 1px var(--line)}
.side .ic{flex:none}
.side-foot{margin-top:auto;display:flex;flex-direction:column;gap:2px;padding-top:12px;border-top:1px solid var(--line)}
.side-foot form{margin:0}
.side-meta{font-size:var(--fs-xs);color:var(--mu);padding:4px 10px}
.side-meta a{color:var(--mu)}
.side-user{display:flex;align-items:center;gap:10px;padding:6px 10px;color:var(--tx);text-decoration:none;font-weight:500;overflow:hidden}
.side-user:hover{text-decoration:underline}
.av{width:26px;height:26px;border-radius:50%;background:var(--bg);border:1px solid var(--line2);display:grid;place-items:center;font-size:11px;font-weight:600;flex:none}
.menu-btn{display:none;width:40px;height:40px;border:1px solid var(--ctl);border-radius:var(--r2);background:var(--bg);color:var(--tx);place-items:center;padding:0}
.menu-btn:hover{background:var(--bg2)}
.main{min-width:0}
.page{width:100%;max-width:1120px;margin:0 auto;padding:32px 32px 64px}
.bare-top{display:flex;justify-content:flex-end;padding:12px 16px 0}
.bare-top .side-btn{width:auto}
.theme-ic-dark{display:none}
:root[data-theme=dark] .theme-ic-light{display:none}
:root[data-theme=dark] .theme-ic-dark{display:inline}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]) .theme-ic-light{display:none}:root:not([data-theme=light]) .theme-ic-dark{display:inline}}
.collapse-ic{transition:transform .15s}

@media (min-width:900px){
  html[data-side=collapsed] .shell{--sw:56px}
  html[data-side=collapsed] .lb,html[data-side=collapsed] .side-meta,html[data-side=collapsed] .side-user .lb{display:none}
  html[data-side=collapsed] .side a.nav-link,html[data-side=collapsed] .side-btn,html[data-side=collapsed] .side-user{justify-content:center;padding:0}
  html[data-side=collapsed] .brand{padding-left:8px}
  html[data-side=collapsed] .collapse-ic{transform:rotate(180deg)}
}
@media (max-width:899px){
  .shell{display:block}
  .side{height:auto;max-height:100vh;border-right:0;border-bottom:1px solid var(--line);z-index:20;padding:6px 12px}
  .side-head .brand{padding:4px 0}
  .menu-btn{display:grid}
  .side-body{display:none;padding:8px 0 12px}
  html[data-menu=open] .side-body{display:flex;max-height:calc(100vh - 64px)}
  .collapse-btn{display:none}
  .page{padding:20px 16px 48px}
  h1{font-size:1.4rem}
  .card{padding:1rem}
  .card table{display:block;overflow-x:auto}
  .flex{flex-wrap:wrap}
  input,select,textarea{max-width:100%}
  .dashboard-filter input[type="search"]{min-width:0}
}
`;

const COMPONENTS = `
.container{max-width:960px;margin:0 auto}
.app-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1rem}
@media (max-width:500px){.app-grid{grid-template-columns:1fr}}
.app-card{display:flex;flex-direction:column;border-left:3px solid var(--line)}
.app-card.status-live{border-left-color:var(--ok)}
.app-card.status-building{border-left-color:var(--warn)}
.app-card.status-failed,.app-card.status-offline{border-left-color:var(--err)}
.app-card.status-stopped,.app-card.status-new{border-left-color:var(--ctl)}
.app-status{display:flex;flex-wrap:wrap;align-items:center;gap:0.4rem 0.75rem;margin-bottom:0.5rem;min-width:0}
.st{display:inline-flex;align-items:center;gap:0.4rem;font-size:0.85rem;font-weight:600;color:var(--tx);white-space:nowrap}
.st .dot{width:8px;height:8px;border-radius:50%;background:var(--mu);flex-shrink:0}
.st-live .dot{background:var(--ok)}
.st-building .dot{background:var(--warn)}
.st-failed .dot,.st-offline .dot{background:var(--err)}
.tag{display:inline-block;max-width:100%;padding:1px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--line);color:var(--mu)}
.tag-ok{background:var(--okbg);color:var(--ok)}
.tag-warn{background:var(--warnbg);color:var(--warn)}
.tag-err{background:var(--errbg);color:var(--err)}
a.tag:hover{filter:brightness(0.95)}
.overflow-menu{position:relative}
.overflow-menu summary{list-style:none;cursor:pointer;color:var(--mu);font-size:1.1rem;padding:0.1rem 0.4rem;border-radius:4px;line-height:1}
.overflow-menu summary:hover{color:var(--tx);background:var(--line)}
.overflow-menu summary::-webkit-details-marker{display:none}
.overflow-menu[open] .overflow-dropdown{display:block}
.overflow-dropdown{display:none;position:absolute;right:0;top:100%;z-index:10;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:0.25rem;min-width:180px;box-shadow:var(--sh)}
.overflow-dropdown button,.overflow-dropdown .overflow-item{display:block;width:100%;text-align:left;background:none;border:none;color:var(--mu);font-size:0.8rem;padding:0.4rem 0.75rem;cursor:pointer;border-radius:4px;font-family:inherit;font-weight:500}
.overflow-dropdown button:hover,.overflow-dropdown .overflow-item:hover{background:var(--line);color:var(--tx)}
.overflow-dropdown .overflow-danger:hover{color:var(--err)}
.dashboard-filter{display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap}
.dashboard-filter input[type="search"]{flex:1;min-width:180px}
.card{background:var(--bg);border:1px solid var(--line);border-radius:var(--r3);padding:1.5rem;margin-bottom:1rem;min-width:0}
.tabs{display:flex;flex-wrap:wrap;gap:0;border-bottom:1px solid var(--line);margin-bottom:1rem}
.tabs input[type="radio"]{position:absolute;opacity:0;pointer-events:none}
.tabs label{padding:0.6rem 1.2rem;cursor:pointer;color:var(--mu);border-bottom:3px solid transparent;font-size:0.95rem;font-weight:500;transition:color 0.15s}
.tabs label:hover{color:var(--tx)}
.tabs input:checked + label{color:var(--tx);border-bottom-color:var(--inv)}
.tabs input:focus-visible + label{outline:2px solid var(--ring);outline-offset:-2px}
.tab-panel{display:none}
#tab-deploys:checked ~ .tab-panels .panel-deploys,
#tab-access:checked ~ .tab-panels .panel-access,
#tab-config:checked ~ .tab-panels .panel-config,
#tab-general:checked ~ .tab-panels .panel-general,
#tab-security:checked ~ .tab-panels .panel-security,
#tab-sso:checked ~ .tab-panels .panel-sso{display:block}
.card h2{margin-bottom:0.5rem}
.meta{color:var(--mu);font-size:0.85rem}
.key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line);padding:2px 6px;border-radius:4px;font-size:0.85rem;word-break:break-all}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;text-transform:lowercase}
.badge-created{background:var(--status-info-bg);color:var(--status-info)}
.badge-running{background:var(--okbg);color:var(--ok)}
.badge-starting,.badge-building{background:var(--warnbg);color:var(--warn)}
.badge-quarantined{background:var(--errbg);color:var(--err);outline:1px solid var(--err)}
.badge-exited,.badge-stopped,.badge-failed{background:var(--errbg);color:var(--err)}
.badge-restarting,.badge-paused{background:var(--warnbg);color:var(--warn)}
.badge-healthy{background:var(--okbg);color:var(--ok)}
.badge-unhealthy{background:var(--errbg);color:var(--err)}
.badge-starting-health{background:var(--warnbg);color:var(--warn)}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0.75rem;margin-top:1rem;padding:0.75rem;background:var(--bg2);border:1px solid var(--line);border-radius:6px}
.stat-label{color:var(--mu);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:0.25rem}
.stat-value{font-size:0.9rem;font-weight:600;color:var(--tx);font-variant-numeric:tabular-nums}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--line);padding:1px 4px;border-radius:4px;font-size:0.85rem}
@media (max-width:640px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
form{margin-bottom:1.5rem}
input,select,textarea,button{padding:0.5rem 1rem;border-radius:6px;border:1px solid var(--ctl);background:var(--bg);color:var(--tx);font-size:0.9rem;font-family:inherit}
input:focus,select:focus{border-color:var(--ring)}
button{background:var(--inv);border-color:var(--inv);color:var(--invtx);cursor:pointer;font-weight:600}
button:hover{opacity:0.88}
button.danger{background:var(--err);border-color:var(--err);color:var(--bg)}
button.ghost{background:transparent;border-color:var(--ctl);color:var(--tx)}
button.ghost:hover{background:var(--bg2);opacity:1}
.flex{display:flex;gap:0.5rem;align-items:center}
.between{justify-content:space-between}
.auth-card{max-width:400px;margin:0 auto;min-height:calc(100vh - 12rem);display:flex;flex-direction:column;justify-content:center}
.auth-card input{width:100%;margin-bottom:0.75rem}
.auth-card button[type="submit"]{width:100%}
.auth-brand{text-align:center;margin-bottom:2rem}
.auth-brand h1{font-size:2rem;margin-bottom:0.25rem}
.auth-brand p{color:var(--mu);font-size:0.9rem}
.error{background:var(--errbg);border:1px solid var(--err);color:var(--err);padding:0.75rem;border-radius:6px;margin-bottom:1rem;font-size:0.9rem}
.hint{color:var(--mu);font-size:0.85rem;margin-bottom:1rem}
.feature-body{transition:opacity 0.15s}
.feature-body.disabled{opacity:0.35;pointer-events:none}
.settings-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:2rem}
.settings-nav{position:sticky;top:2rem;align-self:start;display:flex;flex-direction:column;gap:0.25rem}
.settings-nav a{color:var(--mu);text-decoration:none;font-size:0.85rem;padding:0.4rem 0.75rem;border-radius:4px;transition:color 0.15s,background 0.15s}
.settings-nav a:hover{color:var(--tx);background:var(--bg2)}
.settings-nav a.active{color:var(--tx);background:var(--bg2)}
@media (max-width:700px){.settings-layout{grid-template-columns:minmax(0,1fr)}.settings-nav{position:static;flex-direction:row;flex-wrap:wrap}}
.health-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(280px,100%),1fr));gap:0.75rem}
.health-tile{background:var(--bg);border:1px solid var(--line);border-radius:var(--r3);padding:1rem 1.25rem;display:flex;align-items:flex-start;gap:0.75rem}
.health-dot{width:10px;height:10px;border-radius:50%;margin-top:0.3rem;flex-shrink:0}
.health-dot.ok{background:var(--ok)}
.health-dot.warn{background:var(--warn)}
.health-dot.fail{background:var(--err)}
.copy-group{position:relative;display:flex;align-items:stretch;background:var(--bg2);border:1px solid var(--line);border-radius:6px;margin-top:0.5rem}
.copy-group code{flex:1;padding:0.6rem 0.75rem;background:transparent;border:none;font-size:0.8rem;white-space:nowrap;overflow-x:auto;display:block}
.copy-btn{padding:0.4rem 0.75rem;background:var(--line);border:none;border-left:1px solid var(--line);color:var(--tx);cursor:pointer;font-size:0.75rem;font-family:inherit;border-radius:0 5px 5px 0;white-space:nowrap;font-weight:500}
.copy-btn:hover{background:var(--line2);opacity:1}
.app-header{display:flex;align-items:center;gap:0.75rem;margin-bottom:0.25rem;flex-wrap:wrap}
.app-header h2{margin:0}
.app-domain{color:var(--tx);text-decoration:underline;text-underline-offset:2px;font-size:0.8rem;display:block;margin-bottom:0.25rem;word-break:break-all}
.section-title{font-size:0.95rem;font-weight:600;margin-bottom:0.75rem;margin-top:1.25rem;color:var(--mu)}
`;

export const APP_CSS = [themeCss(), ALIASES, BASE, SHELL, COMPONENTS].join("\n");
