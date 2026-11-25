/**
 * One-time backfill of app descriptions (follow-up to the description field).
 *
 * Apps deployed before the field existed only get a description at their next
 * deploy. This reads the README from the source Runway already keeps for each
 * app (`latestSource`) with the same code, limits and safety as a deploy
 * (`readmeDescription`) and writes it with the same conditional UPDATE, so a
 * description somebody wrote is never touched.
 *
 * Runs in the background after start, one app at a time with a yield in
 * between, and never throws. A settings marker makes it run once; it is set
 * only after a complete pass, so a crash halfway simply runs the (idempotent)
 * pass again at the next start.
 */
import { readFileSync } from "node:fs";
import { listApps, setDescriptionIfEmpty, type App } from "../db/apps.js";
import { getSetting, setSetting } from "../db/settings.js";
import { readmeDescription } from "./readme.js";
import { latestSource, type SourceRef } from "./source.js";

export interface BackfillDeps {
  listApps: () => Array<Pick<App, "id" | "description">>;
  latestSource: (appId: string) => Pick<SourceRef, "path"> | null;
  readFile: (path: string) => Buffer;
  describe: (tar: Buffer) => string | null;
  setIfEmpty: (appId: string, text: string) => boolean;
  done: () => boolean;
  markDone: () => void;
  yieldTurn: () => Promise<void>;
  log: (message: string) => void;
}

export interface BackfillResult {
  filled: number;
  noReadme: number;
  noSource: number;
  skipped: number;
  failed: number;
}

const realDeps = (log: (m: string) => void): BackfillDeps => ({
  listApps,
  latestSource,
  readFile: (p) => readFileSync(p),
  describe: readmeDescription,
  setIfEmpty: setDescriptionIfEmpty,
  done: () => getSetting("description_backfill_v1") !== undefined,
  markDone: () => setSetting("description_backfill_v1", new Date().toISOString()),
  yieldTurn: () => new Promise((r) => setImmediate(r)),
  log,
});

/** The pass itself. Returns null when it already ran. Never throws. */
export async function runDescriptionBackfill(deps: BackfillDeps): Promise<BackfillResult | null> {
  const result: BackfillResult = { filled: 0, noReadme: 0, noSource: 0, skipped: 0, failed: 0 };
  try {
    if (deps.done()) return null;
    for (const app of deps.listApps()) {
      try {
        if (app.description?.trim()) {
          result.skipped++;
          deps.log(`[description-backfill] ${app.id}: already has a description`);
        } else {
          const src = deps.latestSource(app.id);
          if (!src) {
            result.noSource++;
            deps.log(`[description-backfill] ${app.id}: no stored source`);
          } else {
            const text = deps.describe(deps.readFile(src.path));
            if (!text) {
              result.noReadme++;
              deps.log(`[description-backfill] ${app.id}: no README paragraph`);
            } else if (deps.setIfEmpty(app.id, text)) {
              result.filled++;
              deps.log(`[description-backfill] ${app.id}: filled`);
            } else {
              result.skipped++;
              deps.log(`[description-backfill] ${app.id}: set meanwhile, left alone`);
            }
          }
        }
      } catch (err) {
        result.failed++;
        deps.log(`[description-backfill] ${app.id}: failed (${err instanceof Error ? err.message : String(err)})`);
      }
      await deps.yieldTurn();
    }
    deps.markDone();
    deps.log(
      `[description-backfill] done: ${result.filled} filled, ${result.noReadme} no README, ${result.noSource} no source, ${result.skipped} kept, ${result.failed} failed`
    );
  } catch (err) {
    deps.log(`[description-backfill] aborted: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

/** Fire-and-forget entry point for startup. */
export async function runDescriptionBackfillOnce(opts: { log?: (m: string) => void } = {}): Promise<void> {
  await runDescriptionBackfill(realDeps(opts.log ?? (() => {})));
}
