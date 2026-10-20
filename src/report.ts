// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/** Builds the normalised report from an AI-DLC workspace: intents, developers and audit files. */
import { accountShard, addUsage, byTime } from "./accounting.ts";
import { parseAuditShard } from "./audit.ts";
import { readGitInfo } from "./git.ts";
import { findRosterMember } from "./identity.ts";
import type {
  Attribution,
  AuditEvent,
  DeveloperReport,
  Identity,
  IntentReport,
  Report,
  RosterMember,
  ShardAccount,
  Usage,
} from "./types.ts";
import type { AidlcWorkspace } from "./workspace.ts";

export const SCHEMA_VERSION = 1;
export const AIDLC_COMPATIBILITY = { records_tested: "2.10.0", format_checked: "2.11.1" };
export const UNATTRIBUTED = "(unattributed)";
export const AMBIGUOUS = "(ambiguous)";

export interface ReportOptions {
  since: Date;
  until: Date;
  roster: RosterMember[] | null;
}

interface Shard {
  path: string;
  space: string;
  intentDir: string | null;
  events: AuditEvent[];
  account: ShardAccount;
  authors: Identity[];
  attribution: Attribution;
}

interface RegistryRow {
  uuid: string | null;
  slug: string | null;
  status: string | null;
}

const LIFECYCLE_EVENTS = new Set([
  "WORKFLOW_STARTED",
  "WORKFLOW_PARKED",
  "WORKFLOW_UNPARKED",
  "WORKFLOW_COMPLETED",
  "STAGE_STARTED",
  "STAGE_COMPLETED",
]);

export function buildReport(workspace: AidlcWorkspace, options: ReportOptions): Report {
  const warnings: string[] = [];
  if (!workspace.hasAidlc()) warnings.push("No aidlc/spaces directory found; is this an AI-DLC repository?");
  const git = readGitInfo(workspace.root);
  if (!git.authors) warnings.push("Not a git repository or git is unavailable; all usage is unattributed.");
  if (git.shallow)
    warnings.push("Shallow clone detected; attribution may be incomplete. Check out with fetch-depth: 0.");

  const registries = new Map<string, Map<string, RegistryRow>>();
  const shards: Shard[] = [];
  for (const space of workspace.spaces()) {
    registries.set(space, toRegistry(workspace.readRegistry(space)));
    for (const file of workspace.shards(space)) {
      const events = parseAuditShard(file.text);
      const authors = git.authors?.get(file.path) ?? [];
      shards.push({
        path: file.path,
        space,
        intentDir: file.intentDir,
        events,
        account: accountShard(events),
        authors,
        attribution: authors.length === 1 ? "attributed" : authors.length > 1 ? "ambiguous" : "unattributed",
      });
    }
  }
  warnings.push(...workspace.warnings);

  const people = new People(options.roster);
  const bucketOf = (s: Shard) =>
    s.attribution === "attributed"
      ? people.resolve(s.authors[0])
      : s.attribution === "ambiguous"
        ? AMBIGUOUS
        : UNATTRIBUTED;

  const { intents, statusByKey } = buildIntents(shards, registries, bucketOf);
  const developers = buildDevelopers(shards, people, statusByKey, options);

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: options.until.toISOString(),
    source: { repo: process.env.GITHUB_REPOSITORY ?? null, ref: git.ref, commit: git.commit, shallow: git.shallow },
    aidlc_compatibility: AIDLC_COMPATIBILITY,
    period: { since: options.since.toISOString(), until: options.until.toISOString() },
    warnings,
    intents,
    developers,
    audit_files: shards.map((s) => ({
      path: s.path,
      space: s.space,
      intent_dir: s.intentDir,
      attribution: s.attribution,
      authors: s.authors.map((a) => a.login ?? a.email),
      usage: s.account.total,
      flags: [...s.account.flags].sort(),
    })),
  };
}

function toRegistry(document: unknown): Map<string, RegistryRow> {
  const rows = new Map<string, RegistryRow>();
  const list = Array.isArray(document)
    ? document
    : Array.isArray((document as { intents?: unknown } | null)?.intents)
      ? (document as { intents: unknown[] }).intents
      : [];
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 256 ? v : null);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const dirName = str(r.dirName);
    if (dirName) rows.set(dirName, { uuid: str(r.uuid), slug: str(r.slug), status: str(r.status) });
  }
  return rows;
}

/** Maps git identities to developer display keys, roster members first. */
class People {
  readonly entries = new Map<string, { github: string | null; emails: Set<string>; onRoster: boolean }>();
  private readonly byIdentity = new Map<string, string>();
  private readonly roster: RosterMember[] | null;

  constructor(roster: RosterMember[] | null) {
    this.roster = roster;
    for (const m of roster ?? [])
      this.entries.set(m.name, { github: m.github, emails: new Set(m.emails), onRoster: true });
  }

  resolve(id: Identity): string {
    const known = this.byIdentity.get(id.key);
    if (known) return known;
    const member = findRosterMember(this.roster, id);
    let key = member ? member.name : id.name || id.login || id.email;
    // Two different people with the same display name stay separate.
    if (!member && this.entries.has(key) && !this.entries.get(key)?.emails.has(id.email)) key = id.email;
    const entry = this.entries.get(key) ?? { github: null, emails: new Set<string>(), onRoster: false };
    if (!id.login) entry.emails.add(id.email);
    entry.github ??= id.login;
    this.entries.set(key, entry);
    this.byIdentity.set(id.key, key);
    return key;
  }
}

function buildIntents(
  shards: Shard[],
  registries: Map<string, Map<string, RegistryRow>>,
  bucketOf: (s: Shard) => string,
): { intents: IntentReport[]; statusByKey: Map<string, string> } {
  const groups = new Map<string, Shard[]>();
  for (const s of shards) {
    if (s.intentDir) groups.set(`${s.space}/${s.intentDir}`, [...(groups.get(`${s.space}/${s.intentDir}`) ?? []), s]);
  }
  const statusByKey = new Map<string, string>();
  const intents: IntentReport[] = [];

  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const { space, intentDir } = group[0];
    const dirName = intentDir as string;
    const row = registries.get(space)?.get(dirName);
    let usage: Usage | null = null;
    let unstaged: number | null = null;
    let startedAt: string | null = null;
    let completedAt: string | null = null;
    let lastStageAt: string | null = null;
    const flags = new Set<string>();
    const stages = new Set<string>();
    const byDev = new Map<string, { attribution: Attribution; usage: Usage | null }>();

    for (const s of group) {
      const a = s.account;
      usage = addUsage(usage, a.total);
      if (a.unstagedTokens !== null) unstaged = (unstaged ?? 0) + a.unstagedTokens;
      for (const f of a.flags) flags.add(f);
      for (const st of a.stagesCompleted) stages.add(st);
      startedAt = minIso(startedAt, a.firstStartedAt);
      completedAt = maxIso(completedAt, a.lastCompletedAt);
      lastStageAt = maxIso(lastStageAt, a.lastStageCompletedAt);
      const bucket = bucketOf(s);
      byDev.set(bucket, { attribution: s.attribution, usage: addUsage(byDev.get(bucket)?.usage ?? null, a.total) });
    }
    if (!row) flags.add("unregistered");

    let status = row?.status ?? (completedAt ? "complete" : "in-flight");
    if (status !== "complete" && status !== "archived" && endsParked(group)) status = "parked";
    statusByKey.set(key, status);

    intents.push({
      space,
      intent_id: row?.uuid ?? dirName,
      slug: row?.slug ?? dirName,
      dir_name: dirName,
      registered: Boolean(row),
      status,
      contributors: [...byDev.keys()].filter((d) => d !== AMBIGUOUS && d !== UNATTRIBUTED).sort(),
      started_at: startedAt,
      completed_at: completedAt,
      elapsed_hours:
        startedAt && completedAt ? round2((Date.parse(completedAt) - Date.parse(startedAt)) / 3_600_000) : null,
      stages_completed: stages.size,
      usage,
      usage_partial: !completedAt || (lastStageAt !== null && lastStageAt > completedAt),
      unstaged_tokens: unstaged,
      flags: [...flags].sort(),
      by_developer: [...byDev]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([developer, v]) => ({ developer, attribution: v.attribution, usage: v.usage })),
    });
  }
  return { intents, statusByKey };
}

function buildDevelopers(
  shards: Shard[],
  people: People,
  statusByKey: Map<string, string>,
  options: ReportOptions,
): DeveloperReport[] {
  const since = options.since.toISOString();
  const until = options.until.toISOString();
  const inPeriod = (t: string) => t >= since && t <= until;
  const stats = new Map<string, { activity: string[]; sessions: number; intents: Set<string>; usage: Usage | null }>();

  for (const s of shards) {
    if (s.attribution !== "attributed") continue;
    const dev = people.resolve(s.authors[0]);
    const st = stats.get(dev) ?? { activity: [], sessions: 0, intents: new Set<string>(), usage: null };
    st.activity.push(...s.account.activity);
    st.sessions += s.account.sessions.filter(inPeriod).length;
    if (s.intentDir) {
      st.intents.add(`${s.space}/${s.intentDir}`);
      st.usage = addUsage(st.usage, s.account.total);
    }
    stats.set(dev, st);
  }

  return [...people.entries]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([developer, info]) => {
      const st = stats.get(developer);
      const activity = [...(st?.activity ?? [])].sort();
      const recent = activity.filter(inPeriod);
      const intentKeys = [...(st?.intents ?? [])];
      return {
        developer,
        github: info.github,
        emails: [...info.emails].sort(),
        roster_status:
          options.roster && !info.onRoster
            ? "unmatched"
            : recent.length > 0
              ? "active"
              : activity.length > 0
                ? "inactive_in_period"
                : "no_usage_recorded",
        first_activity: activity[0] ?? null,
        last_activity: activity.at(-1) ?? null,
        active_days: new Set(recent.map((t) => t.slice(0, 10))).size,
        sessions: st?.sessions ?? 0,
        intents_participated_lifetime: intentKeys.length,
        intents_completed_lifetime: intentKeys.filter((k) => statusByKey.get(k) === "complete").length,
        lifetime_usage: st?.usage ?? null,
      };
    });
}

function endsParked(group: Shard[]): boolean {
  const lifecycle = group.flatMap((s) => s.events.filter((e) => LIFECYCLE_EVENTS.has(e.event))).sort(byTime);
  return lifecycle.at(-1)?.event === "WORKFLOW_PARKED";
}

function minIso(a: string | null, b: string | null): string | null {
  return a === null ? b : b === null ? a : b < a ? b : a;
}

function maxIso(a: string | null, b: string | null): string | null {
  return a === null ? b : b === null ? a : b > a ? b : a;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
