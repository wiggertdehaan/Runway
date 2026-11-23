import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/egress-rules.sh", import.meta.url));

/**
 * A stand-in for iptables that keeps its chains as files, so the real script
 * can be run end to end (apply twice, status, remove) without touching a
 * firewall. It understands exactly the calls the script makes.
 */
const FAKE_IPTABLES = `#!/usr/bin/env bash
set -u
D="$FAKE_IPT_STATE"
args=()
for a in "$@"; do [ "$a" = "-w" ] || args+=("$a"); done
echo "iptables \${args[*]}" >> "$D/log"
has() { for a in "\${args[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }
if has -L; then
  chain="\${args[\${#args[@]}-1]}"
  [ -f "$D/chain.$chain" ] || exit 1
  cat "$D/chain.$chain"; exit 0
fi
op="\${args[0]}"; chain="\${args[1]}"
f="$D/chain.$chain"
rule="\${args[*]:2}"
case "$op" in
  -N) [ -f "$f" ] && exit 1; : > "$f" ;;
  -F) [ -f "$f" ] || exit 1; : > "$f" ;;
  -X) [ -f "$f" ] || exit 1; rm -f "$f" ;;
  -A) [ -f "$f" ] || exit 1; echo "$rule" >> "$f" ;;
  -I) [ -f "$f" ] || exit 1; pos="\${args[2]}"; rule="\${args[*]:3}"; { echo "$rule"; cat "$f"; } > "$f.new"; mv "$f.new" "$f" ;;
  -C) [ -f "$f" ] || exit 1; grep -Fxq -- "$rule" "$f" ;;
  -D) [ -f "$f" ] || exit 1; grep -Fxq -- "$rule" "$f" || exit 1
      awk -v r="$rule" 'BEGIN{d=0} { if(!d && $0==r){d=1; next} print }' "$f" > "$f.new"; mv "$f.new" "$f" ;;
  *) echo "fake iptables: unsupported $op" >&2; exit 2 ;;
esac
`;

let dir: string;
let state: string;
let bin: string;

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_IPT_STATE: state,
      RUNWAY_EGRESS_BRIDGES: "br-legacy1,br-build2",
      RUNWAY_EGRESS_DNS: "192.168.1.1,127.0.0.53,1.1.1.1",
      RUNWAY_EGRESS_SKIP_ROOT_CHECK: "1",
      ...env,
    },
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const chain = (n: string) => (existsSync(join(state, `chain.${n}`)) ? readFileSync(join(state, `chain.${n}`), "utf8").trim().split("\n").filter(Boolean) : null);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "egress-test-"));
  state = join(dir, "state");
  bin = join(dir, "bin");
  mkdirSync(state);
  mkdirSync(bin);
  writeFileSync(join(bin, "iptables"), FAKE_IPTABLES);
  chmodSync(join(bin, "iptables"), 0o755);
  // Chains Docker has, plus an unrelated rule that must survive everything.
  writeFileSync(join(state, "chain.DOCKER-USER"), "-j RETURN\n");
  writeFileSync(join(state, "chain.INPUT"), "-p tcp -m tcp --dport 22 -j ACCEPT\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("scripts/egress-rules.sh", () => {
  it("is valid bash", () => {
    const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  it("plan prints the commands, runs none of them and needs no root", () => {
    const r = run(["plan"], { RUNWAY_EGRESS_SKIP_ROOT_CHECK: "" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("iptables -w -I DOCKER-USER 1 -j RUNWAY-EGRESS");
    expect(r.out).toContain("iptables -w -I INPUT 1 -j RUNWAY-HOSTGUARD");
    expect(existsSync(join(state, "log"))).toBe(false); // the fake iptables was never called
    expect(chain("RUNWAY-EGRESS")).toBeNull();
  });

  it("--dry-run on apply and remove is the same: nothing is executed", () => {
    expect(run(["apply", "--dry-run"]).code).toBe(0);
    expect(run(["remove", "--dry-run"]).code).toBe(0);
    expect(existsSync(join(state, "log"))).toBe(false);
  });

  it("blocks metadata, RFC1918 and the 100.64/10 range, from the app interfaces", () => {
    const { out } = run(["plan"]);
    for (const net of ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]) {
      expect(out).toContain(`-A RUNWAY-EGRESS -i rwa+ -d ${net} -j REJECT --reject-with icmp-admin-prohibited`);
    }
  });

  it("covers the legacy shared and build bridges too", () => {
    const { out } = run(["plan"]);
    expect(out).toContain("-A RUNWAY-EGRESS -i br-legacy1 -d 169.254.0.0/16");
    expect(out).toContain("-A RUNWAY-EGRESS -i br-build2 -d 10.0.0.0/8");
    expect(out).toContain("-A RUNWAY-HOSTGUARD -i br-legacy1 -j REJECT");
  });

  it("lets answers and bridge-internal traffic through before anything is refused", () => {
    const rules = run(["plan"]).out.split("\n").filter((l) => l.startsWith("iptables -w -A RUNWAY-EGRESS"));
    expect(rules[0]).toContain("--ctstate RELATED,ESTABLISHED -j RETURN");
    expect(rules[1]).toContain("--physdev-is-bridged -j RETURN");
  });

  it("allows only the private resolvers it detected, on port 53, ahead of the refusals", () => {
    const { out } = run(["plan"]);
    expect(out).toContain("-A RUNWAY-EGRESS -i rwa+ -d 192.168.1.1 -p udp --dport 53 -j RETURN");
    expect(out).toContain("-A RUNWAY-EGRESS -i rwa+ -d 192.168.1.1 -p tcp --dport 53 -j RETURN");
    // loopback (127.0.0.53) is not reachable from a container and a public resolver needs no exception
    expect(out).not.toContain("127.0.0.53");
    expect(out).not.toContain("-d 1.1.1.1");
    const lines = out.split("\n");
    const dnsAt = lines.findIndex((l) => l.includes("-i rwa+ -d 192.168.1.1 -p udp"));
    const rejectAt = lines.findIndex((l) => l.includes("-i rwa+ -d 192.168.0.0/16 -j REJECT"));
    expect(dnsAt).toBeGreaterThan(-1);
    expect(dnsAt).toBeLessThan(rejectAt);
  });

  it("--allow-dns adds a resolver", () => {
    const { out } = run(["plan", "--allow-dns", "10.1.2.3"]);
    expect(out).toContain("-A RUNWAY-EGRESS -i rwa+ -d 10.1.2.3 -p udp --dport 53 -j RETURN");
  });

  it("--allow-net lets a private destination through, ahead of the refusals and not to the host itself", () => {
    const { out } = run(["plan", "--allow-net", "10.20.0.0/24,192.168.7.5", "--allow-net", "172.20.1.0/24"]);
    const lines = out.split("\n");
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    for (const net of ["10.20.0.0/24", "192.168.7.5", "172.20.1.0/24"]) {
      expect(out).toContain(`-A RUNWAY-EGRESS -i rwa+ -d ${net} -j RETURN`);
      expect(at(`-i rwa+ -d ${net} -j RETURN`)).toBeLessThan(at("-i rwa+ -d 10.0.0.0/8 -j REJECT"));
    }
    // the host guard (INPUT) is not affected: those are destinations elsewhere, not the host
    expect(out).not.toMatch(/RUNWAY-HOSTGUARD.*10\.20\.0\.0/);
  });

  it("--allow-net refuses something that is not an IPv4 address or CIDR, and applies nothing", () => {
    const r = run(["apply", "--allow-net", "10.0.0.0/8; rm -rf /"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--allow-net");
    expect(chain("RUNWAY-EGRESS")).toBeNull();
  });

  it("help prints the whole option list", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    for (const opt of ["--dry-run", "--allow-dns", "--allow-net", "--no-host-guard", "RUNWAY_EGRESS_BRIDGES"]) {
      expect(r.out).toContain(opt);
    }
  });

  it("warns when it found no private resolver", () => {
    const { out } = run(["plan"], { RUNWAY_EGRESS_DNS: "8.8.8.8" });
    expect(out).toContain("none found");
  });

  it("--no-host-guard leaves the INPUT rules out", () => {
    const { out } = run(["plan", "--no-host-guard"]);
    expect(out).not.toContain("RUNWAY-HOSTGUARD");
  });

  it("apply creates both chains and one jump each", () => {
    const r = run(["apply"]);
    expect(r.code).toBe(0);
    expect(chain("RUNWAY-EGRESS")!.length).toBeGreaterThan(10);
    expect(chain("RUNWAY-HOSTGUARD")!.length).toBeGreaterThan(3);
    expect(chain("DOCKER-USER")![0]).toBe("-j RUNWAY-EGRESS");
    expect(chain("INPUT")![0]).toBe("-j RUNWAY-HOSTGUARD");
  });

  it("apply is idempotent: a second run changes nothing", () => {
    run(["apply"]);
    const first = { egress: chain("RUNWAY-EGRESS"), guard: chain("RUNWAY-HOSTGUARD"), du: chain("DOCKER-USER"), inp: chain("INPUT") };
    expect(run(["apply"]).code).toBe(0);
    expect(chain("RUNWAY-EGRESS")).toEqual(first.egress);
    expect(chain("RUNWAY-HOSTGUARD")).toEqual(first.guard);
    expect(chain("DOCKER-USER")).toEqual(first.du);
    expect(chain("INPUT")).toEqual(first.inp);
    expect(chain("DOCKER-USER")!.filter((l) => l === "-j RUNWAY-EGRESS")).toHaveLength(1);
    expect(chain("INPUT")!.filter((l) => l === "-j RUNWAY-HOSTGUARD")).toHaveLength(1);
  });

  it("only ever matches traffic from the app interfaces (SSH and the rest of the host are untouched)", () => {
    run(["apply"]);
    const all = [...chain("RUNWAY-EGRESS")!, ...chain("RUNWAY-HOSTGUARD")!];
    const unscoped = all.filter((r) => !/(^| )-i /.test(r));
    // The only rules without an interface are the two "let it through" rules.
    expect(unscoped.every((r) => /--ctstate RELATED,ESTABLISHED/.test(r) || /--physdev-is-bridged/.test(r))).toBe(true);
    expect(unscoped.every((r) => /-j (RETURN|ACCEPT)$/.test(r))).toBe(true);
    expect(all.some((r) => /dport 22\b/.test(r))).toBe(false);
    expect(chain("INPUT")).toContain("-p tcp -m tcp --dport 22 -j ACCEPT");
  });

  it("status exits 0 when installed and 1 when not", () => {
    expect(run(["status"]).code).toBe(1);
    run(["apply"]);
    const s = run(["status"]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("forward rules: installed");
  });

  it("remove is the rollback: everything it made is gone, nothing else is touched, and it can run twice", () => {
    run(["apply"]);
    expect(run(["remove"]).code).toBe(0);
    expect(chain("RUNWAY-EGRESS")).toBeNull();
    expect(chain("RUNWAY-HOSTGUARD")).toBeNull();
    expect(chain("DOCKER-USER")).toEqual(["-j RETURN"]);
    expect(chain("INPUT")).toEqual(["-p tcp -m tcp --dport 22 -j ACCEPT"]);
    expect(run(["status"]).code).toBe(1);
    expect(run(["remove"]).code).toBe(0);
  });

  it("refuses to apply when Docker's DOCKER-USER chain is missing", () => {
    rmSync(join(state, "chain.DOCKER-USER"));
    const r = run(["apply"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("DOCKER-USER");
    expect(chain("RUNWAY-EGRESS")).toBeNull();
  });

  it("refuses to apply without root", () => {
    const r = run(["apply"], { RUNWAY_EGRESS_SKIP_ROOT_CHECK: "" });
    if (process.getuid && process.getuid() !== 0) {
      expect(r.code).toBe(1);
      expect(r.err).toContain("root");
    }
  });

  it("persist prints a systemd unit and installs nothing", () => {
    const r = run(["persist"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("[Service]");
    expect(r.out).toMatch(/ExecStart=.*egress-rules\.sh apply/);
    expect(r.out).toMatch(/ExecStop=.*egress-rules\.sh remove/);
    expect(existsSync(join(state, "log"))).toBe(false);
  });

  it("rejects an unknown argument", () => {
    const r = run(["bogus"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown argument");
  });
});
