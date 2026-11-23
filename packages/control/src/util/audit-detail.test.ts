import { describe, expect, it } from "vitest";
import {
  MAX_DETAIL,
  actionFor,
  clientHint,
  describeBody,
  describeParams,
  finalizeDetail,
  resultForStatus,
  safeName,
  scrubSecrets,
} from "./audit-detail.js";

describe("describeBody", () => {
  it("names fields and nested keys, never the values", () => {
    const out = describeBody({
      env: { DB_URL: "postgres://user:hunter2@db/app", TOKEN: "sk-live-abc" },
      password: "correct horse",
      sso_enabled: true,
    });
    expect(out).toBe("env{DB_URL,TOKEN} password sso_enabled=true");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("sk-live");
    expect(out).not.toContain("correct horse");
  });

  it("shows only the allow-listed scalar values", () => {
    const out = describeBody({
      name: "Shop",
      runtime: "node",
      custom_domain: "shop.example.org",
      password: "secret",
      username: "bob",
    });
    expect(out).toContain("name=Shop");
    expect(out).toContain("runtime=node");
    expect(out).toContain("custom_domain=shop.example.org");
    expect(out).not.toContain("secret");
    expect(out).not.toContain("bob");
  });

  it("counts arrays instead of listing them", () => {
    expect(describeBody({ volumes: [{ path: "/data" }, { path: "/x" }] })).toBe("volumes[2]");
  });

  it("copes with things that are not an object", () => {
    expect(describeBody(null)).toBe("");
    expect(describeBody("text")).toBe("");
    expect(describeBody([1, 2])).toBe("");
  });

  it("caps the number of fields and nested keys", () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 40; i++) big[`K${i}`] = "v";
    const out = describeBody({ env: big, ...big });
    expect(out).toContain("+21 more");
    expect(out).toContain(",+20}");
  });

  it("strips characters that could break a line or smuggle markup", () => {
    const out = describeBody({ env: { "A\nB<script>": "x" } });
    expect(out).toBe("env{ABscript}");
  });
});

describe("scrubSecrets / finalizeDetail", () => {
  it("masks Runway token formats and Bearer values", () => {
    const text = "key rwy_abcdefghijklmnop and rwd_1234567890abcd and rwu_zzzzzzzzzz plus Bearer abc.def";
    const out = scrubSecrets(text);
    expect(out).not.toMatch(/rw[ydu]_[A-Za-z0-9]{6}/);
    expect(out).not.toContain("abc.def");
    expect(out).toContain("[redacted]");
  });

  it("removes control characters and caps the length", () => {
    const out = finalizeDetail(`a\nb\u0000c${"x".repeat(1000)}`);
    expect(out).not.toMatch(/[\u0000-\u001f]/);
    expect(out.length).toBeLessThanOrEqual(MAX_DETAIL);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("actionFor", () => {
  it("builds a stable name without path parameters", () => {
    expect(actionFor("PUT", "/api/v1/app/env")).toBe("api_put_env");
    expect(actionFor("DELETE", "/api/v1/app/env/:key")).toBe("api_delete_env");
    expect(actionFor("POST", "/api/v1/app/deploy")).toBe("api_post_deploy");
    expect(actionFor("DELETE", "/api/v1/app/volumes/:path{.+}")).toBe("api_delete_volumes");
    expect(actionFor("PUT", "/api/v1/app/basic-auth")).toBe("api_put_basicauth");
    expect(actionFor("GET", "/api/v1/app")).toBe("api_get_app");
  });
});

describe("resultForStatus", () => {
  it("classifies the status", () => {
    expect(resultForStatus(200)).toBe("ok");
    expect(resultForStatus(302)).toBe("ok");
    expect(resultForStatus(400)).toBe("rejected");
    expect(resultForStatus(404)).toBe("rejected");
    expect(resultForStatus(401)).toBe("denied");
    expect(resultForStatus(403)).toBe("denied");
    expect(resultForStatus(500)).toBe("error");
  });
});

describe("clientHint / safeName / describeParams", () => {
  it("keeps a short inert client label", () => {
    expect(clientHint("runway-mcp")).toBe("runway-mcp");
    expect(clientHint("evil client\r\nX: y")).toBe("evilclientXy");
    expect(clientHint("")).toBeNull();
    expect(clientHint(undefined)).toBeNull();
    expect(clientHint("a".repeat(200))!.length).toBe(40);
  });

  it("limits names", () => {
    expect(safeName("a b/c", 10)).toBe("ab/c");
    expect(safeName("x".repeat(100)).length).toBe(48);
  });

  it("describes path parameters", () => {
    expect(describeParams({ key: "DB_URL", path: "/data" })).toBe("key=DB_URL path=/data");
    expect(describeParams({})).toBe("");
  });
});
