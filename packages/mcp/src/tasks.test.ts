/**
 * MCP Tasks, through the real protocol (an in-memory client/server pair): the slow tools can run as tasks, and
 * a call without `task` is exactly what it always was.
 */
import { outcomeMessage } from "./tasks.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunwayRegistry } from "./registry.js";
import { createRunwayServer } from "./server.js";
import { TASK_TOOLS } from "./tasks.js";
import { registerTools } from "./tools.js";
import { SERVER_A, SERVER_B, json, legacyRegistry, registryOf, stubServers, type Handler } from "./testkit.js";

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean; _meta?: Record<string, unknown> };
const any = z.any();

async function connectWith(server: McpServer) {
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
/** The server as it is shipped (with tasks). */
const withTasks = (r: RunwayRegistry) => connectWith(createRunwayServer(r, "test"));
/** The server as it was before tasks existed: registerTools and nothing else. */
const withoutTasks = (r: RunwayRegistry) => {
  const s = new McpServer({ name: "runway", version: "test" });
  registerTools(s, r);
  return connectWith(s);
};

const startTask = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.request({ method: "tools/call", params: { name, arguments: args, task: { ttl: 60_000 } } }, any)) as {
    task: { taskId: string; status: string; ttl: number; runway?: string; statusMessage?: string };
    _meta?: Record<string, unknown>;
  };
const getTask = async (client: Client, taskId: string) =>
  (await client.request({ method: "tasks/get", params: { taskId } }, any)) as { taskId: string; status: string; statusMessage?: string; runway?: string };
const taskResult = async (client: Client, taskId: string) => (await client.request({ method: "tasks/result", params: { taskId } }, any)) as Result;
const settled = async (client: Client, taskId: string) => {
  for (let i = 0; i < 200; i++) {
    const t = await getTask(client, taskId);
    if (["completed", "failed", "cancelled"].includes(t.status)) return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("task never ended");
};

afterEach(() => vi.unstubAllGlobals());

let dir: string;
let project: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runway-mcp-tasks-"));
  project = join(dir, "project");
  mkdirSync(project);
  writeFileSync(join(project, "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(project, "index.js"), "console.log(1)\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const api: Handler = (c) => {
  if (c.path === "/api/v1/app") return json({ configured: true, runtime: "node" });
  if (c.path === "/api/v1/app/deploy") return json({ status: "success", image_tag: "x:1", deploy_id: 7, scan: { status: "passed", counts: {} } });
  if (c.path === "/api/v1/app/rescan") return json({ scan: "ok", findings: 0 });
  if (c.path === "/api/v1/app/rollback") return json({ status: "rolled_back" });
  return json({ app_id: "appxone", status: "running" });
};

describe("what the server offers", () => {
  it("declares the tasks capability for tools/call", async () => {
    const client = await withTasks(legacyRegistry());
    const tasks = client.getServerCapabilities()?.tasks as { requests?: { tools?: { call?: unknown } }; list?: unknown; cancel?: unknown };
    expect(tasks.requests?.tools?.call).toBeDefined();
    expect(tasks.list).toBeDefined();
    expect(tasks.cancel).toBeDefined();
  });

  it("marks only the slow tools 'optional' and never 'required'", async () => {
    const client = await withTasks(legacyRegistry());
    const tools = (await client.listTools()).tools;
    for (const t of tools) {
      const support = (t as { execution?: { taskSupport?: string } }).execution?.taskSupport;
      expect(support).not.toBe("required");
      expect(support).toBe(TASK_TOOLS.includes(t.name) ? "optional" : "forbidden");
    }
    expect(tools.filter((t) => TASK_TOOLS.includes(t.name))).toHaveLength(TASK_TOOLS.length);
  });

  it("lists the same tools, schemas and descriptions as before, apart from that one hint", async () => {
    const before = (await (await withoutTasks(registryOf(SERVER_A, SERVER_B))).listTools()).tools;
    const after = (await (await withTasks(registryOf(SERVER_A, SERVER_B))).listTools()).tools;
    const strip = (ts: typeof before) => ts.map(({ execution: _e, ...rest }) => rest);
    expect(strip(after)).toEqual(strip(before));
  });
});

describe("a call without a task is exactly what it was", () => {
  const cases: Array<[string, () => Record<string, unknown>]> = [
    ["runway_deploy", () => ({ project_root: project })],
    ["runway_rescan", () => ({})],
    ["runway_rollback", () => ({})],
    ["runway_rollback", () => ({ deploy_id: 3 })],
    ["runway_status", () => ({})],
  ];
  for (const [name, args] of cases) {
    it(`${name} ${JSON.stringify(args() )} gives the same result, byte for byte`, async () => {
      const run = async (connect: typeof withTasks) => {
        const calls = stubServers({ "legacy.example.com": api });
        const client = await connect(legacyRegistry());
        const result = await client.callTool({ name, arguments: args() });
        return { json: JSON.stringify(result), requests: calls.map((c) => `${c.method} ${c.path}`) };
      };
      const old = await run(withoutTasks);
      const now = await run(withTasks);
      expect(now.json).toBe(old.json);
      expect(now.requests).toEqual(old.requests);
    });
  }

  it("an error path is also unchanged", async () => {
    const run = async (connect: typeof withTasks) => {
      stubServers({ "legacy.example.com": () => new Response("nope", { status: 500 }) });
      return JSON.stringify(await (await connect(legacyRegistry())).callTool({ name: "runway_rescan", arguments: {} }));
    };
    expect(await run(withTasks)).toBe(await run(withoutTasks));
  });

  it("creates no task", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    await client.callTool({ name: "runway_rescan", arguments: {} });
    const list = (await client.request({ method: "tasks/list", params: {} }, any)) as { tasks: unknown[] };
    expect(list.tasks).toEqual([]);
  });
});

describe("a call as a task", () => {
  it("returns a task at once, then the same result the plain call gives", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    const plain = (await client.callTool({ name: "runway_deploy", arguments: { project_root: project } })) as Result;

    const created = await startTask(client, "runway_deploy", { project_root: project });
    expect(created.task.status).toBe("working");
    expect(created.task.ttl).toBe(60_000);
    expect(String(created._meta?.["io.modelcontextprotocol/model-immediate-response"])).toContain(created.task.taskId);

    const end = await settled(client, created.task.taskId);
    expect(end.status).toBe("completed");
    const result = await taskResult(client, created.task.taskId);
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual(plain.content);
  });

  it("works for rescan and rollback too", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    for (const name of ["runway_rescan", "runway_rollback"]) {
      const t = await startTask(client, name);
      expect((await settled(client, t.task.taskId)).status).toBe("completed");
    }
  });

  it("shows the phase while it runs", async () => {
    let release: (r: Response) => void = () => {};
    stubServers({ "legacy.example.com": (c) => (c.path.endsWith("/rescan") ? new Promise<Response>((res) => (release = res)) : api(c)) });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_rescan");
    await vi.waitFor(async () => expect((await getTask(client, t.task.taskId)).statusMessage).toMatch(/^Scanning the running image on the server .*\(\d+s\)$/));
    release(json({ ok: true }));
    expect((await settled(client, t.task.taskId)).status).toBe("completed");
  });

  it("a finished task's statusMessage is the outcome, not the last phase", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_rescan");
    expect((await settled(client, t.task.taskId)).status).toBe("completed");
    expect((await getTask(client, t.task.taskId)).statusMessage).toMatch(/^Completed in \d+ s$/);
  });

  it("a failed task's statusMessage is the error, not 'Scanning… (0s)'", async () => {
    stubServers({ "legacy.example.com": () => new Response("nope", { status: 500 }) });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_rescan");
    expect((await settled(client, t.task.taskId)).status).toBe("failed");
    expect((await getTask(client, t.task.taskId)).statusMessage).toBe("Runway API error 500: nope");
  });

  it("a failing tool ends as 'failed' with the tool's own error text", async () => {
    stubServers({ "legacy.example.com": () => new Response("nope", { status: 500 }) });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_rescan");
    expect((await settled(client, t.task.taskId)).status).toBe("failed");
    const r = await taskResult(client, t.task.taskId);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("Runway API error 500: nope");
  });

  it("a blocked deploy ends as 'failed' with the scan text", async () => {
    stubServers({ "legacy.example.com": (c) => (c.path.endsWith("/deploy") ? json({ status: "blocked", image_tag: "x:2" }) : api(c)) });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_deploy", { project_root: project });
    expect((await settled(client, t.task.taskId)).status).toBe("failed");
    expect((await taskResult(client, t.task.taskId)).content[0]!.text).toContain("DEPLOY BLOCKED");
  });

  it("bad arguments end as a failed task, not a crashed server", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_rollback", { deploy_id: "three" });
    expect((await settled(client, t.task.taskId)).status).toBe("failed");
    expect((await taskResult(client, t.task.taskId)).isError).toBe(true);
  });

  it("never answers 'required'-style errors, and refuses a task on a quick tool", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    await expect(startTask(client, "runway_status")).rejects.toThrow(/does not support task augmentation/);
    // a plain call to every task tool is accepted (never "requires task augmentation")
    for (const name of TASK_TOOLS) {
      const r = (await client.callTool({ name, arguments: name === "runway_deploy" ? { project_root: project } : {} })) as Result;
      expect(r.content[0]!.text).not.toMatch(/requires task augmentation/);
    }
  });

  it("caps the ttl", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    const t = (await client.request({ method: "tools/call", params: { name: "runway_rescan", arguments: {}, task: { ttl: 10 ** 12 } } }, any)) as { task: { ttl: number } };
    expect(t.task.ttl).toBe(24 * 60 * 60 * 1000);
  });
});

describe("cancel", () => {
  it("aborts the open request and ends as cancelled", async () => {
    let aborted = false;
    stubServers({
      "legacy.example.com": (c) =>
        c.path.endsWith("/rescan")
          ? new Promise<Response>((_res, rej) => c.init.signal?.addEventListener("abort", () => ((aborted = true), rej(new DOMException("aborted", "AbortError")))))
          : api(c),
    });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_rescan");
    const cancelled = (await client.request({ method: "tasks/cancel", params: { taskId: t.task.taskId } }, any)) as { status: string };
    expect(cancelled.status).toBe("cancelled");
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect((await getTask(client, t.task.taskId)).status).toBe("cancelled");
  });

  it("a finished task cannot be cancelled", async () => {
    stubServers({ "legacy.example.com": api });
    const client = await withTasks(legacyRegistry());
    const t = await startTask(client, "runway_rescan");
    await settled(client, t.task.taskId);
    await expect(client.request({ method: "tasks/cancel", params: { taskId: t.task.taskId } }, any)).rejects.toThrow(/terminal/);
  });
});

describe("several Runways", () => {
  it("a task remembers its Runway, in get, list and the status text", async () => {
    let release: (r: Response) => void = () => {};
    stubServers({
      "alpha.example.com": () => new Promise<Response>((res) => (release = res)),
      "beta.example.org": () => json({ ok: true }),
    });
    const client = await withTasks(registryOf(SERVER_A, SERVER_B));
    const a = await startTask(client, "runway_rescan", { runway: "alpha", app: "a1" });
    const b = await startTask(client, "runway_rescan", { runway: "beta", app: "b1" });
    expect((await getTask(client, a.task.taskId)).runway).toBe("alpha");
    expect((await getTask(client, b.task.taskId)).runway).toBe("beta");
    await settled(client, b.task.taskId);
    await vi.waitFor(async () => expect((await getTask(client, a.task.taskId)).statusMessage).toMatch(/^\[alpha\] /));
    const list = (await client.request({ method: "tasks/list", params: {} }, any)) as { tasks: Array<{ taskId: string; runway?: string }> };
    expect(Object.fromEntries(list.tasks.map((t) => [t.taskId, t.runway]))).toEqual({ [a.task.taskId]: "alpha", [b.task.taskId]: "beta" });
    release(json({ ok: true }));
    await settled(client, a.task.taskId);
  });

  it("a failing Runway names itself in the result, and the other task is unaffected", async () => {
    stubServers({ "alpha.example.com": () => new Response("denied", { status: 403 }), "beta.example.org": () => json({ ok: true }) });
    const client = await withTasks(registryOf(SERVER_A, SERVER_B));
    const a = await startTask(client, "runway_rescan", { runway: "alpha", app: "a1" });
    const b = await startTask(client, "runway_rescan", { runway: "beta", app: "b1" });
    expect((await settled(client, a.task.taskId)).status).toBe("failed");
    expect((await settled(client, b.task.taskId)).status).toBe("completed");
    expect((await taskResult(client, a.task.taskId)).content[0]!.text).toBe("[alpha] Runway API error 403: denied");
  });

  it("an unknown Runway is a failed task with the usual explanation, not a thrown request", async () => {
    stubServers({});
    const client = await withTasks(registryOf(SERVER_A, SERVER_B));
    const t = await startTask(client, "runway_rescan", { runway: "nope", app: "x" });
    expect((await settled(client, t.task.taskId)).status).toBe("failed");
    expect((await taskResult(client, t.task.taskId)).isError).toBe(true);
  });
});

describe("outcomeMessage", () => {
  it("completed: how long it took, with the Runway tag", () => {
    expect(outcomeMessage("", false, "", 1000, 42_400)).toBe("Completed in 41 s");
    expect(outcomeMessage("[alpha] ", false, "", 0, 0)).toBe("[alpha] Completed in 0 s");
  });
  it("failed: the first non-empty line of the error, one line, bounded", () => {
    expect(outcomeMessage("", true, "\n\nDEPLOY BLOCKED\nmore detail", 0, 5000)).toBe("DEPLOY BLOCKED");
    const long = outcomeMessage("", true, "x".repeat(500), 0, 0);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
    expect(outcomeMessage("", true, "", 0, 0)).toBe("Failed");
  });
});
