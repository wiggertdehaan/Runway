import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import { logApiAudit } from "../db/audit.js";
import { getClientIp } from "./rate-limit.js";
import type { ApiEnv } from "./auth.js";
import {
  actionFor,
  clientHint,
  describeBody,
  describeParams,
  resultForStatus,
  safeName,
  type AuditResult,
} from "../util/audit-detail.js";

/**
 * S12: every API call that changes something is written to the audit log, by
 * one middleware, so a route added next year cannot forget it. A request
 * that is refused (validation, wrong state) is logged too, with its result.
 *
 * GET routes are not logged by default (the log would be mostly noise) with
 * two exceptions listed below: reads that hand out something an attacker
 * wants. Every GET route must be in exactly one of the two lists; a test
 * walks the route table and fails on a route that is in neither, so adding a
 * route forces the question "is reading this sensitive?".
 */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

/** Read-only routes that ARE audited: they return secrets or source code. */
export const AUDITED_READS: ReadonlySet<string> = new Set([
  "/api/v1/app/env", // environment variables, values included
  "/api/v1/app/source", // the full source archive
  "/api/v1/tokens/all", // every person's tokens (names, hints, last use)
]);

/** Read-only routes that are deliberately NOT audited. */
export const UNAUDITED_READS: ReadonlySet<string> = new Set([
  "/api/v1/app",
  "/api/v1/app/deploys/:deployId/scan",
  "/api/v1/app/scan",
  "/api/v1/app/status",
  "/api/v1/app/logs",
  "/api/v1/app/volumes",
  "/api/v1/app/sso",
  "/api/v1/app/skills",
  "/api/v1/app/deploys",
  "/api/v1/me", // who am I (user token)
  "/api/v1/apps", // the apps this person may see
  "/api/v1/tokens", // this person's own token list
]);

/** Largest JSON body the middleware looks at to name the fields. */
const MAX_INSPECT_BYTES = 1_000_000;

export async function apiAudit(c: Context<ApiEnv>, next: Next) {
  const method = c.req.method;
  const mutating = MUTATING_METHODS.has(method);

  // Name the fields before the handler runs. Hono caches the parsed body,
  // so the handler's own c.req.json() gets the same object. The deploy
  // upload is a tar and is never read here.
  let fields = "";
  if (mutating) {
    const type = c.req.header("content-type") ?? "";
    const length = Number(c.req.header("content-length") ?? "0");
    if (type.includes("application/json") && length <= MAX_INSPECT_BYTES) {
      fields = describeBody(await c.req.json().catch(() => null));
    }
  }

  let threw = false;
  try {
    await next();
  } catch (err) {
    threw = true;
    throw err;
  } finally {
    const matched = routePath(c, -1);
    const audited = mutating || AUDITED_READS.has(matched);
    if (audited) {
      const actor = c.get("actor");
      const app = c.get("app");
      if (actor) {
        const status = c.res?.status ?? 500;
        const result: AuditResult = threw ? "error" : resultForStatus(status);
        const client = clientHint(c.req.header("x-runway-client"));
        const detail = [
          // For a user token the person is part of the record (the token id
          // is the actor, but "who is that" is the first question).
          actor.kind === "user-token" ? `user=${safeName(actor.username)}` : "",
          describeParams(c.req.param() as Record<string, string>),
          fields,
          `status=${threw ? 500 : status}`,
          client ? `client=${client}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        try {
          logApiAudit({
            actorType: actor.kind === "app-key" ? "api-key" : "user-token",
            actorId: actor.kind === "app-key" ? actor.appId : actor.tokenId,
            appId: app?.id ?? null,
            action: actionFor(method, matched),
            result,
            ip: getClientIp(c),
            detail,
          });
        } catch (err) {
          // A broken audit write must not turn a finished action into an
          // error for the caller, but it must not be silent either.
          console.error("audit write failed:", (err as Error).message);
        }
      }
    }
  }
}
