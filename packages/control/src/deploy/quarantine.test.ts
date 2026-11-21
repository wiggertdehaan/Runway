import { describe, it, expect } from "vitest";
import { decideQuarantine, deadlineOf, type DecisionInput } from "./quarantine.js";
import type { QuarantineRow } from "../db/quarantine.js";
import { buildMaintenanceRouteDoc } from "./gateway.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-21T10:00:00Z");
const base = (o: Partial<DecisionInput> = {}): DecisionInput => ({
  now: T0, termMs: 7 * DAY, row: undefined, kevIds: [], exempt: false, rebuildActive: false, ...o,
});
const row = (o: Partial<QuarantineRow> = {}): QuarantineRow => ({
  app_id: "a", state: "grace", kev_first_seen: { "CVE-1": new Date(T0).toISOString() },
  attempt_at: null, quarantined_at: null, updated_at: "", ...o,
});
const types = (d: ReturnType<typeof decideQuarantine>) => d.actions.map((a) => a.type);

describe("decideQuarantine", () => {
  it("nothing to do for a clean app without a row", () => {
    expect(decideQuarantine("a", base())).toEqual({ row: null, actions: [] });
  });

  it("day 0: first KEV starts the grace term and notifies", () => {
    const d = decideQuarantine("a", base({ kevIds: ["CVE-1"] }));
    expect(types(d)).toEqual(["start_grace"]);
    expect(d.row?.state).toBe("grace");
    expect(d.row?.kev_first_seen["CVE-1"]).toBe(new Date(T0).toISOString());
  });

  it("inside the term: nothing happens, first-seen is kept", () => {
    const r = row();
    const d = decideQuarantine("a", base({ now: T0 + 3 * DAY, row: r, kevIds: ["CVE-1"] }));
    expect(d.actions).toEqual([]);
    expect(d.row?.kev_first_seen).toEqual(r.kev_first_seen);
  });

  it("a second KEV gets its own term and a notice, the first keeps its clock", () => {
    const d = decideQuarantine("a", base({ now: T0 + 3 * DAY, row: row(), kevIds: ["CVE-1", "CVE-2"] }));
    expect(d.actions).toEqual([{ type: "new_kev", ids: ["CVE-2"] }]);
    expect(d.row?.kev_first_seen["CVE-1"]).toBe(new Date(T0).toISOString());
    expect(d.row?.kev_first_seen["CVE-2"]).toBe(new Date(T0 + 3 * DAY).toISOString());
  });

  it("term over: first make one last rebuild attempt, do not quarantine yet", () => {
    const d = decideQuarantine("a", base({ now: T0 + 7 * DAY, row: row(), kevIds: ["CVE-1"] }));
    expect(types(d)).toEqual(["attempt_rebuild"]);
    expect(d.row?.state).toBe("grace");
  });

  it("after the attempt: wait while a rebuild runs, quarantine once it is done", () => {
    const r = row({ attempt_at: new Date(T0 + 7 * DAY).toISOString() });
    const waiting = decideQuarantine("a", base({ now: T0 + 7 * DAY + 60_000, row: r, kevIds: ["CVE-1"], rebuildActive: true }));
    expect(waiting.actions).toEqual([]);
    const done = decideQuarantine("a", base({ now: T0 + 7 * DAY + 120_000, row: r, kevIds: ["CVE-1"] }));
    expect(done.actions).toEqual([{ type: "quarantine", ids: ["CVE-1"] }]);
    expect(done.row?.state).toBe("quarantined");
    expect(done.row?.quarantined_at).toBe(new Date(T0 + 7 * DAY + 120_000).toISOString());
  });

  it("only the overdue KEV counts: a fresh one does not drag the app into quarantine", () => {
    const r = row({
      kev_first_seen: { "CVE-1": new Date(T0).toISOString(), "CVE-2": new Date(T0 + 6 * DAY).toISOString() },
      attempt_at: new Date(T0 + 7 * DAY).toISOString(),
    });
    const d = decideQuarantine("a", base({ now: T0 + 7 * DAY + 1000, row: r, kevIds: ["CVE-1", "CVE-2"] }));
    expect(d.actions).toEqual([{ type: "quarantine", ids: ["CVE-1"] }]);
  });

  it("an active exemption prevents quarantine", () => {
    const r = row({ attempt_at: new Date(T0 + 7 * DAY).toISOString() });
    const d = decideQuarantine("a", base({ now: T0 + 8 * DAY, row: r, kevIds: ["CVE-1"], exempt: true }));
    expect(d.actions).toEqual([]);
    expect(d.row?.state).toBe("grace");
  });

  it("granting an exemption lifts an existing quarantine", () => {
    const r = row({ state: "quarantined", quarantined_at: new Date(T0).toISOString(), attempt_at: new Date(T0).toISOString() });
    const d = decideQuarantine("a", base({ now: T0 + 8 * DAY, row: r, kevIds: ["CVE-1"], exempt: true }));
    expect(types(d)).toEqual(["lift_exempt"]);
    expect(d.row?.state).toBe("grace");
    expect(d.row?.quarantined_at).toBeNull();
  });

  it("a quarantined app stays quarantined while the KEV remains", () => {
    const r = row({ state: "quarantined", quarantined_at: new Date(T0).toISOString(), attempt_at: new Date(T0).toISOString() });
    const d = decideQuarantine("a", base({ now: T0 + 20 * DAY, row: r, kevIds: ["CVE-1"] }));
    expect(d.actions).toEqual([]);
    expect(d.row?.state).toBe("quarantined");
  });

  it("an owner deploy over a quarantine that still has the KEV is put straight back", () => {
    const r = row({ state: "quarantined", quarantined_at: new Date(T0).toISOString(), attempt_at: new Date(T0).toISOString() });
    const d = decideQuarantine("a", base({ now: T0 + 9 * DAY, row: r, kevIds: ["CVE-1"], online: true }));
    expect(d.actions).toEqual([{ type: "quarantine", ids: ["CVE-1"] }]);
    expect(d.row?.state).toBe("quarantined");
    // ...but not while an exemption is active
    const ex = decideQuarantine("a", base({ now: T0 + 9 * DAY, row: r, kevIds: ["CVE-1"], online: true, exempt: true }));
    expect(ex.actions.map((a) => a.type)).toEqual(["lift_exempt"]);
  });

  it("resolution clears the row and reports it (quarantined or not)", () => {
    for (const state of ["grace", "quarantined"] as const) {
      const d = decideQuarantine("a", base({ row: row({ state }), kevIds: [] }));
      expect(d).toEqual({ row: null, actions: [{ type: "resolve" }] });
    }
  });

  it("a KEV that goes away and comes back starts a new term", () => {
    const gone = decideQuarantine("a", base({ row: row(), kevIds: [] }));
    expect(gone.row).toBeNull();
    const back = decideQuarantine("a", base({ now: T0 + 30 * DAY, row: undefined, kevIds: ["CVE-1"] }));
    expect(types(back)).toEqual(["start_grace"]);
  });

  it("a short test term works the same way (minutes)", () => {
    const termMs = 2 * 60_000;
    const r = row({ attempt_at: new Date(T0 + 2 * 60_000).toISOString() });
    const d = decideQuarantine("a", base({ termMs, now: T0 + 3 * 60_000, row: r, kevIds: ["CVE-1"] }));
    expect(types(d)).toEqual(["quarantine"]);
  });
});

describe("deadlineOf", () => {
  it("earliest first-seen plus term", () => {
    const iso = deadlineOf(
      { kev_first_seen: { a: "2026-11-22T00:00:00.000Z", b: "2026-11-21T10:00:00.000Z" } },
      7 * DAY
    );
    expect(iso).toBe("2026-11-28T10:00:00.000Z");
  });
});

describe("buildMaintenanceRouteDoc", () => {
  it("routes all hosts to control's /maintenance and never to the app", () => {
    const doc = buildMaintenanceRouteDoc({ appId: "x1", domain: "x.example.com", customDomain: "x.org" }) as any;
    const router = doc.http.routers["app-x1"];
    expect(router.rule).toBe("Host(`x.example.com`) || Host(`x.org`)");
    expect(router.middlewares).toEqual(["app-x1-maintenance-path"]);
    expect(doc.http.middlewares["app-x1-maintenance-path"]).toEqual({ replacePath: { path: "/maintenance" } });
    const svc = doc.http.services["app-x1-maintenance"].loadBalancer.servers;
    expect(svc).toEqual([{ url: "http://control:3000" }]);
    expect(JSON.stringify(doc)).not.toContain("runway-app-");
    expect(Object.keys(doc.http.routers)).toEqual(["app-x1"]);
  });
  it("no custom domain: single host rule", () => {
    const doc = buildMaintenanceRouteDoc({ appId: "x1", domain: "x.example.com" }) as any;
    expect(doc.http.routers["app-x1"].rule).toBe("Host(`x.example.com`)");
  });
});
