/**
 * MCP Tasks (spec 2025-11-25) for the slow Runway tools.
 *
 * A client that knows tasks may call `runway_deploy`, `runway_rescan` or `runway_rollback` as a task: it gets a
 * task id at once, can watch the phase in `statusMessage`, and fetches the result later with `tasks/result`.
 * Every other client calls the tool as before. The tools are advertised with `taskSupport: "optional"`, never
 * "required", and a call without a `task` parameter goes to exactly the handler it always went to: this module
 * only intercepts requests that carry `task`.
 *
 * The task store lives in this process (a stdio process per client). Tasks are gone when the process stops.
 * The Runway control API has no deploy-status endpoint (a deploy is one blocking HTTP request), so the phases
 * are the ones this process knows: packaging, then "the server is working" with the elapsed time.
 *
 * Cancel: `tasks/cancel` aborts the HTTP request this process has open. That really stops packaging and the
 * upload. Once the server has the upload, the build, scan, rescan or rollback is not stoppable through the
 * API: it finishes on the server (see runway_status / runway_events), only the wait is cancelled.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { RunwayRegistry } from "./registry.js";
import { redactSecrets } from "./errors.js";

/** The tools that can run as a task. Quick tools stay plain calls; `runway_rebuild` already returns at once. */
export const TASK_TOOLS: readonly string[] = ["runway_deploy", "runway_rescan", "runway_rollback"];

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const TICK_MS = 10_000;
const MODEL_IMMEDIATE = "io.modelcontextprotocol/model-immediate-response";

interface TaskContext {
  phase: (message: string) => void;
  signal: AbortSignal;
}
const als = new AsyncLocalStorage<TaskContext>();

/** Tell the task where it is. Does nothing outside a task, so a plain call is untouched. */
export function reportPhase(message: string): void {
  als.getStore()?.phase(message);
}

/** The abort signal of the running task, or undefined for a plain call. */
export function taskSignal(): AbortSignal | undefined {
  return als.getStore()?.signal;
}

/** In-memory store that also tells us when a task is cancelled, and remembers which Runway it runs on. */
export class RunwayTaskStore extends InMemoryTaskStore {
  private readonly aborters = new Map<string, AbortController>();

  register(taskId: string, runway: string | undefined): AbortController {
    const ctrl = new AbortController();
    this.aborters.set(taskId, ctrl);
    const stored = (this as unknown as { tasks: Map<string, { task: Record<string, unknown> }> }).tasks.get(taskId);
    if (stored && runway) stored.task.runway = runway;
    return ctrl;
  }

  release(taskId: string): void {
    this.aborters.delete(taskId);
  }

  override async updateTaskStatus(taskId: string, status: Parameters<InMemoryTaskStore["updateTaskStatus"]>[1], statusMessage?: string, sessionId?: string): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);
    if (status === "cancelled") this.aborters.get(taskId)?.abort(new Error("task cancelled"));
  }
}

type Handler = (request: any, extra: any) => Promise<any>;

/**
 * Wrap tools/list (add `execution.taskSupport: "optional"`) and tools/call (run task-augmented requests as
 * tasks) on an McpServer built with `taskStore` and the tasks capability. Call after registerTools().
 */
export function installTasks(server: McpServer, registry: RunwayRegistry, store: RunwayTaskStore): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, Handler> })._requestHandlers;
  const list = handlers.get("tools/list");
  const call = handlers.get("tools/call");
  if (!list || !call) throw new Error("runway-mcp: the MCP SDK no longer exposes its tool handlers; tasks cannot be installed.");
  const multi = registry.mode === "config";

  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const out = await list(request, extra);
    return {
      ...out,
      tools: out.tools.map((t: { name: string }) => (TASK_TOOLS.includes(t.name) ? { ...t, execution: { taskSupport: "optional" } } : t)),
    };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const taskParams = request.params.task;
    if (!taskParams) return call(request, extra); // the plain path: untouched
    const name = request.params.name;
    if (!TASK_TOOLS.includes(name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} does not support task augmentation`);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    let runway: string | undefined;
    if (multi) {
      try {
        runway = registry.clientFor(args.runway as string | undefined, args.app as string | undefined).server.name;
      } catch {
        runway = undefined; // the tool itself reports why, as the task's result
      }
    }
    const tag = runway ? `[${runway}] ` : "";
    const taskStore = extra.taskStore;
    if (!taskStore) throw new McpError(ErrorCode.InternalError, "No task store configured.");
    const ttl = Math.min(taskParams.ttl ?? DEFAULT_TTL_MS, MAX_TTL_MS);
    const task = await taskStore.createTask({ ttl, pollInterval: POLL_INTERVAL_MS });
    const ctrl = store.register(task.taskId, runway);
    const started = Date.now();
    let phase = "Starting";
    const setStatus = async (): Promise<void> => {
      if (ctrl.signal.aborted) return;
      const secs = Math.round((Date.now() - started) / 1000);
      try {
        await taskStore.updateTaskStatus(task.taskId, "working", `${tag}${phase} (${secs}s)`);
      } catch {
        /* the task ended meanwhile */
      }
    };
    const ticker = setInterval(() => void setStatus(), TICK_MS);
    ticker.unref();

    const synthetic = { ...request, params: { name, arguments: request.params.arguments } };
    void (async () => {
      try {
        const result = await als.run(
          {
            phase: (m) => {
              phase = m;
              void setStatus();
            },
            signal: ctrl.signal,
          },
          () => call(synthetic, { ...extra, signal: ctrl.signal })
        );
        if (ctrl.signal.aborted) return; // cancelled: the store already says so
        await taskStore.storeTaskResult(task.taskId, result?.isError ? "failed" : "completed", result);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        const message = redactSecrets(err instanceof Error ? err.message : String(err), registry.secrets());
        const failed = { isError: true, content: [{ type: "text", text: `${tag}${message}` }] };
        try {
          await taskStore.storeTaskResult(task.taskId, "failed", failed);
        } catch {
          /* already terminal */
        }
      } finally {
        clearInterval(ticker);
        store.release(task.taskId);
      }
    })();

    const shown = await taskStore.getTask(task.taskId);
    return {
      task: shown,
      _meta: { [MODEL_IMMEDIATE]: `${tag}${name} started as a task (id ${task.taskId}). It keeps running; check it with tasks/get and fetch the result with tasks/result.` },
    };
  });
}
