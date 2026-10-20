/**
 * Builds a small synthetic AI-DLC repository with git history, used by the CI smoke test
 * of the composite action and handy for trying the CLI locally:
 *
 *   node tests/make-sample-repo.ts /tmp/sample && node src/aidlc-usage-report.ts --repo /tmp/sample
 */
import { resolve } from "node:path";
import {
  DEV_A,
  DEV_B,
  intentAudit,
  registry,
  session,
  shard,
  stageDone,
  started,
  TestRepo,
  usage,
  workflowDone,
} from "./helpers.ts";

const target = process.argv[2];
if (!target) {
  process.stderr.write("usage: node tests/make-sample-repo.ts <empty-directory>\n");
  process.exit(1);
}

new TestRepo(resolve(target))
  .write(
    "aidlc/spaces/default/intents/intents.json",
    registry([{ uuid: "0190-sample-1", slug: "sample-feature", dirName: "260101-sample-feature", status: "complete" }]),
  )
  .write(
    intentAudit("260101-sample-feature", "dev-a-laptop-0a1b2c3d4e5f.md"),
    shard(
      started("2026-01-01T09:00:00Z"),
      session("2026-01-01T09:00:05Z"),
      stageDone("2026-01-01T10:00:00Z", "requirements-analysis", usage(100, 2000, 300000, 4000, "1.25")),
      stageDone("2026-01-01T12:00:00Z", "code-generation", usage(400, 9000, 1200000, 16000, "5.10")),
      workflowDone("2026-01-01T13:00:00Z", usage(520, 11500, 1550000, 20500, "6.60")),
    ),
  )
  .squashMerge(DEV_A, "feat: sample feature (#1)")
  .write(
    intentAudit("260102-sample-fix", "dev-b-laptop-6f5e4d3c2b1a.md"),
    shard(started("2026-01-02T09:00:00Z"), stageDone("2026-01-02T11:00:00Z", "code-generation")),
  )
  .squashMerge(DEV_B, "fix: sample fix in progress (#2)");
