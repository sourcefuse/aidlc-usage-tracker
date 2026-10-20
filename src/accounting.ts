// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/**
 * Per-shard accounting rules (see README "How it works"):
 * - STAGE_COMPLETED / WORKFLOW_COMPLETED usage is a cumulative snapshot of one clone's
 *   ledger, so only the latest snapshot per stage and per workflow counts.
 * - A shard's total is the larger of the latest workflow total and the sum of the latest
 *   stage snapshots (the stage sum is larger only when the intent was reopened).
 * - Decreasing snapshots (ledger reset) are flagged, never reconstructed.
 */
import type { AuditEvent, ShardAccount, Usage } from "./types.ts";

export function tokenTotal(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

/** Adds two usages. Null means "nothing recorded", so it is an identity, never zero cost. */
export function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    hasUnpriced: a.hasUnpriced || b.hasUnpriced,
  };
}

/** Chronological order with the shard position as a stable tie-breaker. */
export function byTime(a: AuditEvent, b: AuditEvent): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.index - b.index;
}

export function accountShard(events: AuditEvent[]): ShardAccount {
  const sorted = [...events].sort(byTime);
  const latestStage = new Map<string, Usage>();
  const flags = new Set<string>();
  const account: ShardAccount = {
    total: null,
    unstagedTokens: null,
    stagesCompleted: new Set<string>(),
    flags,
    firstStartedAt: null,
    lastCompletedAt: null,
    lastStageCompletedAt: null,
    activity: sorted.map((e) => e.timestamp),
    sessions: [],
  };
  let workflow: Usage | null = null;

  for (const e of sorted) {
    switch (e.event) {
      case "WORKFLOW_STARTED":
        account.firstStartedAt ??= e.timestamp;
        break;
      case "STAGE_COMPLETED":
        account.lastStageCompletedAt = e.timestamp;
        if (!e.stage) break;
        account.stagesCompleted.add(e.stage);
        if (e.usage) {
          const previous = latestStage.get(e.stage);
          if (previous && tokenTotal(e.usage) < tokenTotal(previous)) flags.add("usage_decreased");
          latestStage.set(e.stage, e.usage);
        }
        break;
      case "WORKFLOW_COMPLETED":
        account.lastCompletedAt = e.timestamp;
        if (e.usage) {
          if (workflow && tokenTotal(e.usage) < tokenTotal(workflow)) flags.add("usage_decreased");
          workflow = e.usage;
        }
        break;
      case "SESSION_STARTED":
      case "SESSION_RESUMED":
        account.sessions.push(e.timestamp);
        break;
    }
  }

  let stageSum: Usage | null = null;
  for (const usage of latestStage.values()) stageSum = addUsage(stageSum, usage);

  const reopened =
    account.lastCompletedAt !== null &&
    account.lastStageCompletedAt !== null &&
    account.lastStageCompletedAt > account.lastCompletedAt;

  account.total = workflow ?? stageSum;
  if (workflow) {
    account.unstagedTokens = tokenTotal(workflow) - (stageSum ? tokenTotal(stageSum) : 0);
    if (stageSum && tokenTotal(stageSum) > tokenTotal(workflow)) {
      account.total = stageSum;
      if (!reopened) flags.add("discrepancy");
    }
  }
  if (reopened) flags.add("reopened");
  return account;
}
