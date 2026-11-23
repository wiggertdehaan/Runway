import { describe, expect, it } from "vitest";
import {
  LIST_PREVIEW,
  issuesButtonLabel,
  renderAllAction,
  renderIssuesAction,
  renderRebuildActions,
  type ActionsInput,
  type IssueRow,
} from "./rebuild-actions.js";

const issue = (id: string, over: Partial<IssueRow> = {}): IssueRow => ({
  id,
  name: `app ${id}`,
  reason: "1 actively exploited (KEV)",
  optedOut: false,
  quarantined: false,
  ...over,
});

const base = (over: Partial<ActionsInput> = {}): ActionsInput => ({
  issues: [],
  all: [],
  running: false,
  confirmAll: false,
  kevStale: false,
  ...over,
});

const apps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id${i}`, name: `shop ${i}` }));

describe("issuesButtonLabel", () => {
  it("says how many apps it touches", () => {
    expect(issuesButtonLabel(1, false)).toBe("Rebuild 1 app with issues");
    expect(issuesButtonLabel(3, false)).toBe("Rebuild 3 apps with issues");
  });
  it("says why it is off", () => {
    expect(issuesButtonLabel(0, false)).toBe("Nothing needs a rebuild");
    expect(issuesButtonLabel(4, true)).toContain("Run in progress");
  });
});

describe("the issues button", () => {
  it("lists each app with its reason before you press", () => {
    const html = renderIssuesAction(base({ issues: [issue("a1", { name: "Klantportaal", reason: "2 critical with fix" })], all: apps(3) }));
    expect(html).toContain('data-count="1"');
    expect(html).toContain("Klantportaal");
    expect(html).toContain("2 critical with fix");
    expect(html).toContain('name="mode" value="issues"');
    expect(html).toContain('action="/rebuild/run"');
    expect(html).not.toMatch(/<button type="submit" disabled/);
  });

  it("marks apps that are normally not rebuilt automatically, and quarantined ones", () => {
    const html = renderIssuesAction(base({ issues: [issue("a", { optedOut: true }), issue("b", { quarantined: true })] }));
    expect(html).toContain("Not rebuilt automatically");
    expect(html).toContain("Offline");
  });

  it("is switched off with a plain sentence when nothing has an issue", () => {
    const html = renderIssuesAction(base({ all: apps(5) }));
    expect(html).toMatch(/<button type="submit" disabled>Nothing needs a rebuild<\/button>/);
    expect(html).toContain('data-count="0"');
    expect(html).not.toContain("rr-sel-item");
  });

  it("is switched off while a run is busy", () => {
    const html = renderIssuesAction(base({ issues: [issue("a")], running: true }));
    expect(html).toMatch(/<button type="submit" disabled>Run in progress/);
  });

  it("folds a long list into 'and N more'", () => {
    const issues = Array.from({ length: LIST_PREVIEW + 3 }, (_, i) => issue(`x${i}`));
    const html = renderIssuesAction(base({ issues }));
    expect(html).toContain("and 3 more apps");
    expect(html).toContain(`Rebuild ${LIST_PREVIEW + 3} apps with issues`);
  });

  it("warns when the KEV list could not be refreshed", () => {
    expect(renderIssuesAction(base({ kevStale: true }))).toContain("could not be refreshed");
    expect(renderIssuesAction(base())).not.toContain("could not be refreshed");
  });

  it("escapes names and reasons", () => {
    const html = renderIssuesAction(base({ issues: [issue("a", { name: "<img src=x onerror=alert(1)>", reason: "<b>x</b>" })] }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img");
  });
});

describe("the rebuild-all button", () => {
  it("sits behind a confirmation panel that works without JavaScript", () => {
    const html = renderAllAction(base({ all: apps(4), issues: [issue("a")] }));
    expect(html).toContain("<details");
    expect(html).not.toContain("confirm(");
    expect(html).not.toContain("onsubmit");
    expect(html).toContain("Yes, rebuild all 4 apps");
    expect(html).toContain('name="mode" value="all"');
    expect(html).toContain('name="confirm" value="all"');
    expect(html).toContain('href="/rebuild"'); // Cancel
    expect(html).toContain("That includes 3 that have no issues");
  });

  it("is closed by default and open when the server sends you to the panel", () => {
    expect(renderAllAction(base({ all: apps(2) }))).not.toMatch(/<details[^>]* open/);
    expect(renderAllAction(base({ all: apps(2), confirmAll: true }))).toMatch(/<details[^>]* open/);
  });

  it("is the quieter of the two", () => {
    const html = renderRebuildActions(base({ all: apps(2), issues: [issue("a")] }));
    expect(html.indexOf('data-act="issues"')).toBeLessThan(html.indexOf('data-act="all"'));
    expect(html).toContain("rr-all-sum"); // ghost-styled summary, not a filled button
  });

  it("is a disabled button while a run is busy, and when no app is deployed", () => {
    expect(renderAllAction(base({ all: apps(2), running: true }))).toMatch(/<button type="button" class="ghost" disabled>Run in progress/);
    const none = renderAllAction(base());
    expect(none).toMatch(/class="ghost" disabled>Rebuild all apps/);
    expect(none).toContain("nothing to rebuild");
    expect(none).not.toContain("<details");
  });

  it("uses singular and plural", () => {
    expect(renderAllAction(base({ all: apps(1) }))).toContain("Yes, rebuild all 1 app<");
  });
});
