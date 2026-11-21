import { describe, it, expect } from "vitest";
import { parseKevFeed, kevFindings } from "./kev.js";
import type { Finding } from "./scan.js";

const f = (id: string, source: Finding["source"] = "image"): Finding => ({ id, severity: "HIGH", source });

describe("parseKevFeed", () => {
  it("extracts upper-cased CVE ids", () => {
    const ids = parseKevFeed({ vulnerabilities: [{ cveID: "cve-2024-1" }, { cveID: "CVE-2024-2" }, {}] });
    expect([...ids].sort()).toEqual(["CVE-2024-1", "CVE-2024-2"]);
  });
  it("tolerates garbage", () => {
    expect(parseKevFeed(null).size).toBe(0);
    expect(parseKevFeed({ vulnerabilities: "x" }).size).toBe(0);
  });
});

describe("kevFindings", () => {
  const kev = new Set(["CVE-2024-1"]);
  it("keeps only listed CVEs, deduped, image findings only", () => {
    const out = kevFindings([f("CVE-2024-1"), f("CVE-2024-1"), f("CVE-2024-9"), f("CVE-2024-1", "secret")], kev);
    expect(out.map((x) => x.id)).toEqual(["CVE-2024-1"]);
  });
});
