/**
 * HTML for the overview page. Pure: it takes the view that
 * `overview/build.ts` made and returns a string. Nothing here decides who may
 * see what; that was settled before the view existed.
 *
 * Everything that came from an app (names) goes through `esc`.
 */
import { SCHEDULE_TZ } from "../deploy/rebuild-scheduler.js";
import {
  PERIODS,
  sparkline,
  type Figure,
  type InboxItem,
  type NextRebuild,
  type OverviewView,
  type Stat,
} from "../overview/build.js";

function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const fmtNumber = (n: number) => n.toLocaleString("en-US");

/** The sentence about the weekly run. Same wording in the calm and the busy state. */
export function nextRebuildLine(next: NextRebuild): string {
  switch (next.kind) {
    case "off":
      return "The weekly rebuild of apps with issues is switched off.";
    case "due":
      return "Next rebuild of apps with issues: starts within a minute.";
    case "at":
      return `Next rebuild of apps with issues: ${next.text} (${SCHEDULE_TZ}).`;
  }
}

function renderFigure(f: Figure): string {
  const sub = f.sub ? `<span class="ov-s">${esc(f.sub)}</span>` : "";
  const grey = f.grey ? " ov-grey" : "";
  const title = f.title ? ` title="${esc(f.title)}"` : "";
  return `<a class="ov-fig t-${f.tone}${grey}" href="${esc(f.href)}"${title}><span class="ov-l">${esc(f.label)}</span><span class="ov-v">${esc(f.value)}</span>${sub}</a>`;
}

function renderItem(i: InboxItem): string {
  const detail = i.detail ? `<p class="meta">${esc(i.detail)}</p>` : "";
  return `<li class="ov-item t-${i.tone}" data-key="${esc(i.key)}">
    <div class="ov-main"><strong>${esc(i.title)}</strong>${detail}</div>
    <a class="btn-link ghost" href="${esc(i.href)}">${esc(i.action)}</a>
  </li>`;
}

function renderGroup(title: string, items: InboxItem[], more: number): string {
  if (items.length === 0) return "";
  const rows = items.map(renderItem).join("");
  const rest = more > 0 ? `<p class="meta ov-more">And ${more} more.</p>` : "";
  return `<h2 class="ov-h">${esc(title)} <span class="ov-n">${items.length + more}</span></h2><ul class="ov-list">${rows}</ul>${rest}`;
}

function renderStat(s: Stat, top: OverviewView["topApps"], periodLabel: string, firstServer: boolean): string {
  const d = s.delta;
  const deltaText = s.deltaLine
    ? esc(s.deltaLine)
    : d.fromZero
      ? `${esc(d.text)}, none in the previous ${esc(periodLabel)}`
      : `${esc(d.text)} vs the previous ${esc(periodLabel)}`;
  const delta = s.grey && s.series.length === 0 ? "" : `<span class="ov-d${d.bad ? " bad" : ""}">${deltaText}</span>`;
  const sub = s.sub ? `<span class="ov-sub${s.subBad ? " bad" : ""}">${esc(s.sub)}</span>` : "";
  const note = s.note ? `<span class="ov-note">${esc(s.note)}</span>` : "";
  const topList =
    s.key === "hits" && top.length > 0
      ? `<ul class="ov-top3">${top
          .map((t) => `<li><a href="/apps/${encodeURIComponent(t.id)}">${esc(t.name)}</a><span>${esc(fmtNumber(t.hits))}</span></li>`)
          .join("")}</ul>`
      : "";
  const spark = s.series.length > 0 ? sparkline(s.series, `${s.label}, last ${periodLabel}`) : "";
  const attrs = `class="ov-stat${s.grey ? " ov-grey" : ""}" data-stat="${esc(s.key)}"${firstServer ? ' id="server"' : ""}${
    s.title ? ` title="${esc(s.title)}"` : ""
  }`;
  return `<div ${attrs}>
    <span class="ov-l">${esc(s.label)}</span>
    <span class="ov-v">${esc(s.display ?? fmtNumber(s.value))}</span>
    ${sub}${note}${delta}
    ${spark}
    ${topList}
  </div>`;
}

function periodSwitch(current: string): string {
  const links = PERIODS.map((p) => {
    const label = p === "24h" ? "24 h" : p === "7d" ? "7 d" : "30 d";
    return `<a href="/overview?period=${p}" aria-current="${p === current ? "true" : "false"}">${label}</a>`;
  }).join("");
  return `<nav class="ov-per" aria-label="Period">${links}</nav>`;
}

export function renderOverview(view: OverviewView, opts: { admin: boolean }): string {
  const h = view.headline;
  const tone = h.calm ? "calm" : view.inbox.now.length > 0 ? "attn-now" : "attn-week";
  const activity = opts.admin
    ? ` <a href="/audit">Recent activity</a>`
    : "";
  const healthLink =
    h.healthIssues.length > 0 ? ` <a href="/health">See server health</a>` : "";
  const head = `<section class="ov-head ${tone}" role="status" aria-live="polite">
    <h2>${esc(h.text)}</h2>
    <p class="meta">${esc(h.sub)}${healthLink}</p>
    <p class="meta">${esc(nextRebuildLine(view.nextRebuild))}${activity}</p>
  </section>`;

  const figs = `<nav class="ov-figs" aria-label="Key figures">${view.figures.map(renderFigure).join("")}</nav>`;

  const inbox =
    renderGroup("Needs you now", view.inbox.now, view.more.now) +
    renderGroup("This week", view.inbox.week, view.more.week) +
    renderGroup("For your information", view.inbox.info, view.more.info);

  const label = view.period.label;
  const stats = `<h2 class="ov-h">Last ${esc(label)}</h2>
    <div class="ov-top" style="margin:0 0 0.5rem">${periodSwitch(view.period.key)}</div>
    <div class="ov-stats">${view.stats
      .map((s, i) => renderStat(s, view.topApps, label, !!s.server && !view.stats.slice(0, i).some((x) => x.server)))
      .join("")}</div>`;

  return `<div class="ov-top"><h1>Overview</h1></div>
    ${head}
    ${figs}
    ${inbox}
    ${stats}`;
}

