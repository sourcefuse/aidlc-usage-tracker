// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/** Token usage and estimated cost recorded by AI-DLC for one scope (stage, workflow, shard or intent). */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Priced portion in USD; null when no portion could be priced. */
  costUsd: number | null;
  /** True when some tokens came from a model without a known price. */
  hasUnpriced: boolean;
}

/** One audit event, reduced to the allow-listed fields the tracker needs. */
export interface AuditEvent {
  event: string;
  timestamp: string;
  stage: string | null;
  usage: Usage | null;
  /** Position in the shard, used as a stable tie-breaker for equal timestamps. */
  index: number;
}

/** Accounting result for one audit shard (one clone's ledger). */
export interface ShardAccount {
  total: Usage | null;
  /** Workflow total minus stage total, in tokens; null without a workflow total. */
  unstagedTokens: number | null;
  stagesCompleted: Set<string>;
  flags: Set<string>;
  firstStartedAt: string | null;
  lastCompletedAt: string | null;
  lastStageCompletedAt: string | null;
  activity: string[];
  sessions: string[];
}

export interface Identity {
  /** Stable key: `github:<login>` for noreply addresses, otherwise the email. */
  key: string;
  email: string;
  login: string | null;
  name: string;
}

export interface RosterMember {
  name: string;
  github: string | null;
  emails: string[];
}

export type Attribution = "attributed" | "ambiguous" | "unattributed";

export interface IntentReport {
  space: string;
  intent_id: string;
  slug: string;
  dir_name: string;
  registered: boolean;
  status: string;
  contributors: string[];
  started_at: string | null;
  completed_at: string | null;
  elapsed_hours: number | null;
  stages_completed: number;
  usage: Usage | null;
  usage_partial: boolean;
  unstaged_tokens: number | null;
  flags: string[];
  by_developer: { developer: string; attribution: Attribution; usage: Usage | null }[];
}

export interface DeveloperReport {
  developer: string;
  github: string | null;
  emails: string[];
  roster_status: "active" | "inactive_in_period" | "no_usage_recorded" | "unmatched";
  first_activity: string | null;
  last_activity: string | null;
  active_days: number;
  sessions: number;
  intents_participated_lifetime: number;
  intents_completed_lifetime: number;
  lifetime_usage: Usage | null;
}

export interface AuditFileReport {
  path: string;
  space: string;
  intent_dir: string | null;
  attribution: Attribution;
  authors: string[];
  usage: Usage | null;
  flags: string[];
}

export interface Report {
  schema_version: number;
  generated_at: string;
  source: { repo: string | null; ref: string | null; commit: string | null; shallow: boolean };
  aidlc_compatibility: { records_tested: string; format_checked: string };
  period: { since: string; until: string };
  warnings: string[];
  intents: IntentReport[];
  developers: DeveloperReport[];
  audit_files: AuditFileReport[];
}
