import { describe, it, expect } from "vitest";
import { db, migrate } from "./index.js";
import { createApp, getApp } from "./apps.js";

describe("apps.auto_update_deps_major", () => {
  it("is off for a new app, with compatible updates still on", () => {
    migrate();
    const app = getApp(createApp("t").id)!;
    expect(app.auto_update_deps_major).toBe(0);
    expect(app.auto_update_deps).toBe(1);
  });
  it("migration puts an app that existed before the column on 0", () => {
    migrate();
    const old = createApp("t");
    db.exec("ALTER TABLE apps DROP COLUMN auto_update_deps_major");
    migrate();
    expect(getApp(old.id)!.auto_update_deps_major).toBe(0);
  });
});
