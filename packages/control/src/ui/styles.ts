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
.side a.nav-link{position:relative}
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
  html[data-side=collapsed] .nav-count{position:absolute;top:1px;right:3px;min-width:16px;height:16px;padding:0 4px;font-size:0.65rem}
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
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.apps-bar{margin-bottom:0.5rem}
.chips{display:flex;flex-wrap:wrap;gap:0.4rem;margin:0.75rem 0}
.chip{width:auto;display:inline-flex;align-items:center;gap:0.4rem;padding:0.3rem 0.75rem;min-height:32px;border-radius:999px;border:1px solid var(--ctl);background:transparent;color:var(--tx);font-size:0.85rem;font-weight:500}
.chip:hover{background:var(--bg2);opacity:1}
.chip[aria-pressed=true]{background:var(--inv);border-color:var(--inv);color:var(--invtx)}
.chip-n{font-variant-numeric:tabular-nums;opacity:0.75;font-weight:600}
.attn{border:1px solid var(--err);border-radius:var(--r3);background:var(--bg);padding:1rem 1.25rem;margin-bottom:1rem}
.attn-head{margin-bottom:0.5rem}
.attn-list{list-style:none;margin:0;padding:0}
.attn-row{display:flex;align-items:center;justify-content:space-between;gap:0.75rem 1rem;flex-wrap:wrap;padding:0.6rem 0;border-top:1px solid var(--line)}
.attn-row:first-child{border-top:0}
.attn-main{min-width:0;flex:1 1 16rem}
.attn-top{display:flex;flex-wrap:wrap;align-items:baseline;gap:0.25rem 0.75rem}
.attn-err{color:var(--err)}
.attn-warn{color:var(--warn)}
.attn-acts{display:flex;gap:0.5rem;align-items:center}
.attn-form{margin:0}
.attn-acts button,.btn-link{width:auto;min-height:36px;padding:0.35rem 0.9rem;font-size:0.85rem;display:inline-flex;align-items:center;border-radius:var(--r1)}
.btn-link{border:1px solid var(--ctl);color:var(--tx);text-decoration:none;font-weight:600;background:transparent}
.btn-link:hover{background:var(--bg2)}
.attn-how{margin-top:0.25rem}
.attn-how summary{cursor:pointer;color:var(--mu);font-size:0.85rem}
.attn-how p{margin:0.4rem 0 0}
.app-name{font-weight:600;color:var(--tx);text-decoration:none;overflow-wrap:anywhere}
.app-name:hover{text-decoration:underline}
.apps-tbl{width:100%;border-collapse:separate;border-spacing:0;background:var(--bg);border:1px solid var(--line);border-radius:var(--r3);margin-bottom:1rem}
.apps-tbl th{text-align:left;font-size:0.75rem;font-weight:600;color:var(--mu);padding:0.6rem 0.9rem;border-bottom:1px solid var(--line)}
.apps-tbl td{padding:0.7rem 0.9rem;border-top:1px solid var(--line);vertical-align:middle}
.apps-tbl tbody tr:first-child td{border-top:0}
.apps-tbl .app-row td:first-child{border-left:3px solid transparent}
.app-row.status-live td:first-child{border-left-color:var(--ok)}
.app-row.status-building td:first-child{border-left-color:var(--warn)}
.app-row.status-failed td:first-child,.app-row.status-offline td:first-child{border-left-color:var(--err)}
.app-row.status-stopped td:first-child,.app-row.status-new td:first-child{border-left-color:var(--ctl)}
.c-name{min-width:9rem}
.c-status .app-status{margin:0;flex-direction:column;align-items:flex-start;gap:0.3rem}
.c-url a{color:var(--tx);overflow-wrap:anywhere}
.c-act{min-width:7rem}
.c-act .act-label{font-size:0.75rem;color:var(--mu);display:block;margin-bottom:0.2rem}
.c-menu{width:2.5rem;text-align:right}
.app-row .setup{margin-top:0.5rem}
.app-row.status-new td{position:relative}
.app-row.status-new .c-menu{position:absolute;top:0.6rem;right:0.6rem;width:auto;padding:0}
@media (max-width:699px){
  .apps-tbl,.apps-tbl tbody{display:block;border:0;background:none;border-radius:0}
  .apps-tbl thead{display:none}
  .app-row{display:block;position:relative;background:var(--bg);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:var(--r3);padding:0.85rem 1rem;margin-bottom:0.75rem}
  .app-row.status-live{border-left-color:var(--ok)}
  .app-row.status-building{border-left-color:var(--warn)}
  .app-row.status-failed,.app-row.status-offline{border-left-color:var(--err)}
  .app-row td,.apps-tbl .app-row td:first-child{display:block;border:0;padding:0.2rem 0}
  .c-name{padding-right:2.5rem !important}
  .c-status .app-status{flex-direction:row;flex-wrap:wrap;align-items:center;gap:0.4rem 0.75rem}
  .c-menu{position:absolute;top:0.6rem;right:0.6rem;width:auto;padding:0 !important}
  .c-act{min-width:0}
}
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
.nav-count{margin-left:auto;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--err);color:var(--bg);font-size:0.72rem;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.sec-lead{margin:-1rem 0 1rem}
.sec-h{margin:1.5rem 0 0.5rem}
.sec-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:0.75rem;margin:0 0 0.5rem}
.sec-tile{border:1px solid var(--line);border-radius:var(--r3);background:var(--bg);padding:0.75rem 1rem}
.sec-tile b{display:block;font-size:1.6rem;line-height:1.2;font-variant-numeric:tabular-nums}
.sec-tile span{color:var(--mu);font-size:0.8rem}
.sec-err{border-left:3px solid var(--err)}
.sec-err b{color:var(--err)}
.sec-warn{border-left:3px solid var(--warn)}
.sec-warn b{color:var(--warn)}
.sec-ok{border-left:3px solid var(--ok)}
div.sec-ok b{color:var(--ok)}
p.sec-ok{border:1px solid var(--line);border-left:3px solid var(--ok);border-radius:var(--r3);background:var(--bg);padding:0.75rem 1rem;color:var(--tx)}
.sec-tbl .sec-row td:first-child{border-left:3px solid transparent}
.sec-tbl .sec-row-err td:first-child{border-left-color:var(--err)}
.sec-tbl .sec-row-warn td:first-child{border-left-color:var(--warn)}
.sec-sub{display:block}
.sec-tbl code{font-size:0.8rem;overflow-wrap:anywhere}
.sec-pills{display:flex;flex-wrap:wrap;gap:0.4rem}
.sec-pill{display:inline-flex;align-items:center;min-height:32px;padding:0 0.8rem;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--tx);text-decoration:none;font-size:0.85rem}
.sec-pill:hover{background:var(--bg2)}
.sec-how{margin-top:1.5rem}
@media (max-width:699px){
  .sec-tbl,.sec-tbl tbody{display:block;border:0;background:none;border-radius:0}
  .sec-tbl thead{display:none}
  .sec-row{display:block;background:var(--bg);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:var(--r3);padding:0.85rem 1rem;margin-bottom:0.75rem}
  .sec-row-err{border-left-color:var(--err)}
  .sec-row-warn{border-left-color:var(--warn)}
  .sec-tbl .sec-row td,.sec-tbl .sec-row td:first-child{display:block;border:0;padding:0.2rem 0}
  .sec-tbl .sec-row td[data-label]:not(.sc-app)::before{content:attr(data-label);display:block;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--mu)}
  .sec-tbl .sc-act{padding-top:0.5rem}
}
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
@media(max-width:560px){
  .tabs label{flex:1 1 0;text-align:center;padding:0.6rem 0.25rem;font-size:0.9rem}
  .deploys-table th:nth-child(3),.deploys-table td:nth-child(3),.deploys-table th:nth-child(4),.deploys-table td:nth-child(4),.deploys-table th:nth-child(6),.deploys-table td:nth-child(6){display:none}
  .deploys-table th,.deploys-table td{padding-left:0.4rem!important;padding-right:0.4rem!important}
  .kev-prompt textarea{min-height:13rem}
}
.crumb{margin:0 0 0.75rem;font-size:0.85rem}
.crumb a{color:var(--mu);text-decoration:none}
.crumb a:hover{color:var(--tx)}
.app-head{margin-bottom:1rem}
.app-head-top{display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem 0.9rem}
.app-head-top h1{margin:0;overflow-wrap:anywhere}
.app-head-meta{display:flex;flex-wrap:wrap;gap:0.25rem 1rem;margin:0.4rem 0 0;font-size:0.85rem}
.app-head-meta a{color:var(--tx)}
.tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--err);margin-left:0.35rem;vertical-align:middle}
.kev{border:1px solid var(--warn);border-left-width:4px;border-radius:var(--r3);background:var(--bg);padding:1rem 1.25rem;margin-bottom:1rem}
.kev-err{border-color:var(--err)}
.kev-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:0.25rem 0.9rem}
.kev-count{margin:0;font-size:1.25rem;color:var(--warn)}
.kev-err .kev-count{color:var(--err)}
.kev-why{margin:0.5rem 0 0.75rem;max-width:46rem}
.kev-steps{margin:0;padding-left:1.25rem;display:grid;gap:0.9rem;max-width:46rem}
.kev-steps form{margin:0.5rem 0 0}
.kev-steps button{width:auto}
.kev-prompt{display:grid;gap:0.5rem;margin-top:0.5rem}
.kev-prompt textarea{width:100%;font:inherit;font-size:0.85rem;resize:vertical}
.rb-line{display:flex;flex-wrap:wrap;align-items:center;gap:0.25rem 0.75rem;border:1px solid var(--line);border-radius:var(--r3);padding:0.6rem 0.9rem;margin-bottom:1rem;font-size:0.9rem}
.rb-ok{border-color:var(--ok)}
.rb-err{border-color:var(--err)}
.rb-running .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--warn)}
.deploy-reason{font-size:0.75rem;margin-top:0.15rem;max-width:22rem}
.deploy-reason a{color:var(--tx)}
.exempt{margin:0.5rem 0}
.exempt summary{cursor:pointer;color:var(--tx);font-size:0.9rem}
.kev-steps li::marker{font-weight:600}
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
.maint{margin:1rem 0;border:1px solid var(--line);border-radius:var(--r3)}
.maint-h{display:flex;justify-content:space-between;align-items:flex-start;gap:0.75rem;padding:0.9rem 1rem;border-bottom:1px solid var(--line)}
.maint-h h3{font-size:0.95rem;margin:0 0 0.15rem}
.maint-h .meta{margin:0;font-size:var(--fs-s)}
.swr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:0.85rem 1rem;border-bottom:1px solid var(--line)}
.swr:last-of-type{border-bottom:0}
.swr b{display:block;font-weight:600;cursor:pointer}
.swr small{display:block;color:var(--mu);font-size:var(--fs-s);max-width:62ch;margin-top:2px}
.swr .swn{color:var(--warn);font-weight:600}
.swr.locked b{cursor:default}
.swc{display:flex;align-items:center;justify-content:flex-end;min-width:64px}
.swf{display:flex;align-items:center;gap:10px;margin:0}
.sws{font-size:var(--fs-s);font-weight:600;min-width:24px;text-align:right;color:var(--mu)}
.sw{position:relative;display:inline-block;width:40px;height:24px;flex:none}
.sw input{position:absolute;inset:0;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;z-index:1}
.sw input:disabled{cursor:not-allowed}
.trk{position:absolute;inset:0;border-radius:999px;border:1.5px solid var(--ctl);background:var(--bg);transition:background .12s,border-color .12s}
.trk::after{content:"";position:absolute;top:3px;left:3px;width:15px;height:15px;border-radius:50%;background:var(--ctl);transition:left .12s,background .12s}
.sw input:checked+.trk{background:var(--inv);border-color:var(--inv)}
.sw input:checked+.trk::after{left:18px;background:var(--invtx)}
.sw input:focus-visible+.trk{outline:2px solid var(--ring);outline-offset:2px}
.sw input:disabled+.trk{opacity:.55}
/* The card lives inside .tabs, whose label rules (tab buttons) must not reach it. */
.tabs .swr label,.tabs label.sw{padding:0;border:0;color:var(--tx);font-size:inherit;font-weight:inherit;text-align:left;flex:none;transition:none}
.tabs .swr label:hover{color:var(--tx)}
.kev-rescan{display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;margin:0.75rem 0 0}
.swb{font-size:0.8rem;padding:0.3rem 0.7rem}
.swfoot{padding:0.7rem 1rem;border-top:1px solid var(--line);margin:0;font-size:var(--fs-s)}
@media(max-width:600px){.maint-h{flex-direction:column}.swr{padding:0.85rem}}
@media(prefers-reduced-motion:reduce){.trk,.trk::after{transition:none}}
.section-title{font-size:0.95rem;font-weight:600;margin-bottom:0.75rem;margin-top:1.25rem;color:var(--mu)}
`;

export const APP_CSS = [themeCss(), ALIASES, BASE, SHELL, COMPONENTS].join("\n");
