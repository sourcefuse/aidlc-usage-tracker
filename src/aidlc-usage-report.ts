/**
 * aidlc-usage-report: team-level AI-DLC adoption and token/cost reporting.
 *
 * Reads the AWS AI-DLC audit shards committed under `aidlc/spaces/<space>/intents/`,
 * attributes each shard to its git author, and writes `usage-report.json` plus three
 * CSV views. Read-only, zero runtime dependencies, runs on Node >= 22.18 and Bun.
 *
 * Accounting rules (see __docs__/v0.1-implementation-plan.md §4):
 * - STAGE_COMPLETED / WORKFLOW_COMPLETED usage fields are cumulative snapshots of one
 *   clone's local ledger, so only the latest snapshot per stage / workflow counts.
 * - A shard's total is max(latest workflow total, sum of latest stage snapshots).
 * - Shards come from disjoint per-clone ledgers, so an intent's total is the sum of its
 *   shard totals.
 * - Free-text audit fields are never read into the output.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SCHEMA_VERSION = 1;
export const AIDLC_COMPATIBILITY = {
  records_tested: "2.10.0",
  format_checked: "2.11.1",
} as const;

// Only these audit fields are ever read. Everything else (Request, Details, Reason,
// Person Reply, Feedback, ...) may contain prompts or client data and is ignored.
const ALLOWED_FIELDS = new Set([
  "Timestamp",
  "Event",
  "Stage",
  "Tokens In",
  "Tokens Out",
  "Cache Read",
  "Cache Write",
  "Cost USD",
  "By Model",
  "Tokens By Model",
]);

const FIELD_LINE = /^\*\*([^*\n]+)\*\*:[ \t]?(.*)$/;
const EVENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const NON_NEGATIVE_INT = /^\d+$/;
const NON_NEGATIVE_DECIMAL = /^\d+(?:\.\d+)?$/;
const NOREPLY_EMAIL = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/;
const DAY_MS = 86_400_000;

export const UNATTRIBUTED = "(unattributed)";
export const AMBIGUOUS = "(ambiguous)";

// ---------------------------------------------------------------------------
// Types

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

export interface AuditEvent {
  event: string;
  timestamp: string;
  stage: string | null;
  usage: Usage | null;
  /** Position in the shard, used as a stable tie-breaker for equal timestamps. */
  index: number;
}

export interface ShardAccount {
  total: Usage | null;
  /** Workflow total minus stage total, in tokens; null without a workflow total. */
  unstagedTokens: number | null;
  stagesCompleted: Set<string>;
  hasWorkflowCompleted: boolean;
  flags: Set<string>;
  firstStartedAt: string | null;
  lastCompletedAt: string | null;
  lastStageCompletedAt: string | null;
  activity: string[];
  sessions: { timestamp: string }[];
}

export interface Identity {
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

export interface Options {
  repo: string;
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
  attribution: "attributed" | "ambiguous" | "unattributed";
}

// ---------------------------------------------------------------------------
// Parsing

/** Parses one audit shard. Only allow-listed fields are kept; malformed blocks are skipped. */
export function parseAuditShard(text: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  const blocks = text.replace(/\r\n/g, "\n").split(/^---[ \t]*$/m);
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const match = FIELD_LINE.exec(line);
      if (!match) continue;
      const key = match[1].trim();
      // First occurrence wins: older AI-DLC versions could write Timestamp twice.
      if (ALLOWED_FIELDS.has(key) && !fields.has(key)) fields.set(key, match[2].trim());
    }
    const event = fields.get("Event");
    const timestamp = fields.get("Timestamp");
    if (!event || !EVENT_NAME.test(event) || !timestamp || !ISO_TIMESTAMP.test(timestamp)) continue;
    events.push({
      event,
      timestamp: new Date(timestamp).toISOString(),
      stage: fields.get("Stage") || null,
      usage: parseUsage(fields),
      index: events.length,
    });
  }
  return events;
}

function parseUsage(fields: Map<string, string>): Usage | null {
  const raw = ["Tokens In", "Tokens Out", "Cache Read", "Cache Write"].map((k) => fields.get(k));
  if (raw.some((v) => v === undefined || !NON_NEGATIVE_INT.test(v))) return null;
  const [input, output, cacheRead, cacheWrite] = raw.map(Number);
  const anyTokens = input + output + cacheRead + cacheWrite > 0;
  const cost = fields.get("Cost USD");
  let costUsd: number | null;
  let hasUnpriced = false;
  if (cost === undefined) {
    // AI-DLC omits Cost USD only when the scope recorded no tokens.
    costUsd = anyTokens ? null : 0;
    hasUnpriced = anyTokens;
  } else if (cost === "null") {
    costUsd = null;
    hasUnpriced = true;
  } else if (NON_NEGATIVE_DECIMAL.test(cost)) {
    costUsd = Number(cost);
    hasUnpriced = hasUnpricedModelWithTokens(fields.get("By Model"), fields.get("Tokens By Model"));
  } else {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, costUsd, hasUnpriced };
}

/**
 * `By Model` lists `<model>=null` for models without a price. `<synthetic>` (Claude Code's
 * zero-token synthetic messages) appears there on most events, so a null-priced model only
 * counts as unpriced when `Tokens By Model` shows it actually used tokens.
 */
function hasUnpricedModelWithTokens(byModel: string | undefined, tokensByModel: string | undefined): boolean {
  if (!byModel) return false;
  const tokenModels = new Map<string, string>();
  for (const entry of (tokensByModel ?? "").split(";")) {
    const at = entry.lastIndexOf("=");
    if (at > 0) tokenModels.set(entry.slice(0, at).trim(), entry.slice(at + 1).trim());
  }
  for (const entry of byModel.split(";")) {
    const at = entry.lastIndexOf("=");
    if (at <= 0 || entry.slice(at + 1).trim() !== "null") continue;
    const tokens = tokenModels.get(entry.slice(0, at).trim());
    if (tokens?.split("/").some((part) => !/^0(?:\.0+)?[kMB]?$/.test(part.trim()))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Accounting

export function tokenTotal(u: Usage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

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

function byTime(a: AuditEvent, b: AuditEvent): number {
  return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.index - b.index;
}

/** Applies the per-shard accounting rules to one shard's events. */
export function accountShard(events: AuditEvent[]): ShardAccount {
  const sorted = [...events].sort(byTime);
  const latestStage = new Map<string, Usage>();
  const stagesCompleted = new Set<string>();
  const flags = new Set<string>();
  let workflow: Usage | null = null;
  let hasWorkflowCompleted = false;
  let firstStartedAt: string | null = null;
  let lastCompletedAt: string | null = null;
  let lastStageCompletedAt: string | null = null;
  const sessions: { timestamp: string }[] = [];

  for (const e of sorted) {
    switch (e.event) {
      case "WORKFLOW_STARTED":
        firstStartedAt ??= e.timestamp;
        break;
      case "STAGE_COMPLETED":
        if (e.stage) stagesCompleted.add(e.stage);
        lastStageCompletedAt = e.timestamp;
        if (e.stage && e.usage) {
          const previous = latestStage.get(e.stage);
          if (previous && tokenTotal(e.usage) < tokenTotal(previous)) flags.add("usage_decreased");
          latestStage.set(e.stage, e.usage);
        }
        break;
      case "WORKFLOW_COMPLETED":
        hasWorkflowCompleted = true;
        lastCompletedAt = e.timestamp;
        if (e.usage) {
          if (workflow && tokenTotal(e.usage) < tokenTotal(workflow)) flags.add("usage_decreased");
          workflow = e.usage;
        }
        break;
      case "SESSION_STARTED":
      case "SESSION_RESUMED":
        sessions.push({ timestamp: e.timestamp });
        break;
    }
  }

  let stageSum: Usage | null = null;
  for (const usage of latestStage.values()) stageSum = addUsage(stageSum, usage);

  const reopened = lastCompletedAt !== null && lastStageCompletedAt !== null && lastStageCompletedAt > lastCompletedAt;
  let total: Usage | null = workflow ?? stageSum;
  let unstagedTokens: number | null = null;
  if (workflow) {
    unstagedTokens = tokenTotal(workflow) - (stageSum ? tokenTotal(stageSum) : 0);
    if (stageSum && tokenTotal(stageSum) > tokenTotal(workflow)) {
      total = stageSum;
      if (!reopened) flags.add("discrepancy");
    }
  }
  if (reopened) flags.add("reopened");

  return {
    total,
    unstagedTokens,
    stagesCompleted,
    hasWorkflowCompleted,
    flags,
    firstStartedAt,
    lastCompletedAt,
    lastStageCompletedAt,
    activity: sorted.map((e) => e.timestamp),
    sessions,
  };
}

// ---------------------------------------------------------------------------
// Identity and git attribution

/** Normalises a git author into a stable identity. Handles noreply addresses and stray quotes. */
export function normaliseIdentity(rawEmail: string, rawName: string): Identity {
  const clean = (s: string) =>
    s
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
  const email = clean(rawEmail).toLowerCase();
  const name = clean(rawName);
  const noreply = NOREPLY_EMAIL.exec(email);
  const login = noreply ? noreply[1] : null;
  return { key: login ? `github:${login}` : email, email, login, name };
}

function isBot(email: string, name: string): boolean {
  return /\[bot\]/i.test(name) || /\[bot\]/i.test(email);
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Maps each path under `aidlc/` to the identities of the non-merge commits that touched it
 * on the current HEAD. `--no-merges` skips merge commits, whose author is the merger.
 */
export function readGitAuthors(repo: string): Map<string, Identity[]> | null {
  const out = git(repo, ["log", "--no-merges", "--format=%x00%ae%x09%an", "--name-only", "--", "aidlc"]);
  if (out === null) return null;
  const authors = new Map<string, Map<string, Identity>>();
  let current: Identity | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("\0")) {
      const [email = "", name = ""] = line.slice(1).split("\t");
      current = isBot(email, name) ? null : normaliseIdentity(email, name);
      continue;
    }
    if (!line || !current) continue;
    const byKey = authors.get(line) ?? new Map<string, Identity>();
    byKey.set(current.key, current);
    authors.set(line, byKey);
  }
  return new Map([...authors].map(([path, byKey]) => [path, [...byKey.values()]]));
}

// ---------------------------------------------------------------------------
// Discovery

interface RegistryRow {
  uuid: string | null;
  slug: string | null;
  status: string | null;
}

function readRegistry(intentsDir: string, warnings: string[]): Map<string, RegistryRow> {
  const rows = new Map<string, RegistryRow>();
  const file = join(intentsDir, "intents.json");
  if (!existsSync(file)) return rows;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { intents?: unknown }).intents)
        ? (parsed as { intents: unknown[] }).intents
        : [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
      const dirName = str(r.dirName);
      if (dirName) rows.set(dirName, { uuid: str(r.uuid), slug: str(r.slug), status: str(r.status) });
    }
  } catch {
    warnings.push(`Could not parse ${relative(process.cwd(), file)}; intents are reported without registry data.`);
  }
  return rows;
}

function listShards(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
}

function toRepoPath(repo: string, file: string): string {
  return relative(repo, file).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// Report

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
  by_developer: { developer: string; attribution: string; usage: Usage | null }[];
}

export interface DeveloperReport {
  developer: string;
  github: string | null;
  emails: string[];
  roster_status: string;
  first_activity: string | null;
  last_activity: string | null;
  active_days: number;
  sessions: number;
  intents_participated_lifetime: number;
  intents_completed_lifetime: number;
  lifetime_usage: Usage | null;
}

export interface Report {
  schema_version: number;
  generated_at: string;
  source: { repo: string | null; ref: string | null; commit: string | null; shallow: boolean };
  aidlc_compatibility: typeof AIDLC_COMPATIBILITY;
  period: { since: string; until: string };
  warnings: string[];
  intents: IntentReport[];
  developers: DeveloperReport[];
  audit_files: {
    path: string;
    space: string;
    intent_dir: string | null;
    attribution: string;
    authors: string[];
    usage: Usage | null;
    flags: string[];
  }[];
}

export function buildReport(options: Options): Report {
  const repo = resolve(options.repo);
  const warnings: string[] = [];
  const spacesDir = join(repo, "aidlc", "spaces");
  if (!existsSync(spacesDir)) warnings.push("No aidlc/spaces directory found; is this an AI-DLC repository?");

  const gitAuthors = readGitAuthors(repo);
  if (!gitAuthors) warnings.push("Not a git repository or git is unavailable; all usage is unattributed.");
  const shallow = git(repo, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";
  if (shallow) warnings.push("Shallow clone detected; attribution may be incomplete. Check out with fetch-depth: 0.");

  const shards: Shard[] = [];
  const registries = new Map<string, Map<string, RegistryRow>>();
  const spaces = existsSync(spacesDir)
    ? readdirSync(spacesDir)
        .filter((s) => statSync(join(spacesDir, s)).isDirectory())
        .sort()
    : [];

  for (const space of spaces) {
    const intentsDir = join(spacesDir, space, "intents");
    if (!existsSync(intentsDir)) continue;
    registries.set(space, readRegistry(intentsDir, warnings));
    const entries = readdirSync(intentsDir).sort();
    const loadShard = (file: string, intentDir: string | null) => {
      const path = toRepoPath(repo, file);
      const events = parseAuditShard(readFileSync(file, "utf8"));
      const authors = gitAuthors?.get(path) ?? [];
      const attribution = authors.length === 1 ? "attributed" : authors.length > 1 ? "ambiguous" : "unattributed";
      shards.push({ path, space, intentDir, events, account: accountShard(events), authors, attribution });
    };
    for (const file of listShards(join(intentsDir, "audit"))) loadShard(file, null);
    for (const entry of entries) {
      const auditDir = join(intentsDir, entry, "audit");
      if (entry !== "audit" && existsSync(auditDir)) for (const file of listShards(auditDir)) loadShard(file, entry);
    }
  }

  // Developer identities: roster members first, then observed authors.
  const roster = options.roster;
  const developerOf = new Map<string, string>(); // identity key -> developer display key
  const developers = new Map<string, { github: string | null; emails: Set<string>; onRoster: boolean }>();
  for (const member of roster ?? []) {
    developers.set(member.name, {
      github: member.github,
      emails: new Set(member.emails),
      onRoster: true,
    });
  }
  const resolveDeveloper = (id: Identity): string => {
    const known = developerOf.get(id.key);
    if (known) return known;
    const member = roster?.find(
      (m) => (id.login && m.github?.toLowerCase() === id.login.toLowerCase()) || m.emails.includes(id.email),
    );
    const display = member ? member.name : id.name || id.login || id.email;
    let devKey = display;
    if (!member && developers.has(devKey) && !developers.get(devKey)?.emails.has(id.email)) devKey = id.email;
    developerOf.set(id.key, devKey);
    const entry = developers.get(devKey) ?? { github: null, emails: new Set<string>(), onRoster: false };
    if (!id.login) entry.emails.add(id.email);
    entry.github ??= id.login;
    developers.set(devKey, entry);
    return devKey;
  };
  const bucketOf = (shard: Shard): string =>
    shard.attribution === "attributed"
      ? resolveDeveloper(shard.authors[0])
      : shard.attribution === "ambiguous"
        ? AMBIGUOUS
        : UNATTRIBUTED;

  // Intents.
  const intents: IntentReport[] = [];
  const intentShards = new Map<string, Shard[]>();
  for (const shard of shards) {
    if (!shard.intentDir) continue;
    const key = `${shard.space}/${shard.intentDir}`;
    intentShards.set(key, [...(intentShards.get(key) ?? []), shard]);
  }
  const intentStatus = new Map<string, string>();
  for (const [key, group] of [...intentShards].sort(([a], [b]) => a.localeCompare(b))) {
    const { space, intentDir } = group[0];
    const dirName = intentDir as string;
    const row = registries.get(space)?.get(dirName);
    let usage: Usage | null = null;
    let unstaged: number | null = null;
    const flags = new Set<string>();
    const stages = new Set<string>();
    let startedAt: string | null = null;
    let completedAt: string | null = null;
    let lastStageAt: string | null = null;
    const byDev = new Map<string, { attribution: string; usage: Usage | null }>();
    for (const shard of group) {
      const a = shard.account;
      usage = addUsage(usage, a.total);
      if (a.unstagedTokens !== null) unstaged = (unstaged ?? 0) + a.unstagedTokens;
      for (const f of a.flags) flags.add(f);
      for (const s of a.stagesCompleted) stages.add(s);
      if (a.firstStartedAt && (!startedAt || a.firstStartedAt < startedAt)) startedAt = a.firstStartedAt;
      if (a.lastCompletedAt && (!completedAt || a.lastCompletedAt > completedAt)) completedAt = a.lastCompletedAt;
      if (a.lastStageCompletedAt && (!lastStageAt || a.lastStageCompletedAt > lastStageAt)) {
        lastStageAt = a.lastStageCompletedAt;
      }
      const bucket = bucketOf(shard);
      const prev = byDev.get(bucket);
      byDev.set(bucket, { attribution: shard.attribution, usage: addUsage(prev?.usage ?? null, a.total) });
    }
    if (!row) flags.add("unregistered");
    let status = row?.status ?? (completedAt ? "complete" : "in-flight");
    if (status !== "complete" && status !== "archived" && endsParked(group)) status = "parked";
    intentStatus.set(key, status);
    const usagePartial = !completedAt || (lastStageAt !== null && lastStageAt > completedAt);
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
      usage_partial: usagePartial,
      unstaged_tokens: unstaged,
      flags: [...flags].sort(),
      by_developer: [...byDev]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([developer, v]) => ({ developer, attribution: v.attribution, usage: v.usage })),
    });
  }

  // Developers.
  const since = options.since.toISOString();
  const until = options.until.toISOString();
  const stats = new Map<string, { activity: string[]; sessions: number; intents: Set<string>; usage: Usage | null }>();
  for (const shard of shards) {
    if (shard.attribution !== "attributed") continue;
    const dev = resolveDeveloper(shard.authors[0]);
    const s = stats.get(dev) ?? { activity: [], sessions: 0, intents: new Set<string>(), usage: null };
    s.activity.push(...shard.account.activity);
    s.sessions += shard.account.sessions.filter((x) => x.timestamp >= since && x.timestamp <= until).length;
    if (shard.intentDir) {
      s.intents.add(`${shard.space}/${shard.intentDir}`);
      s.usage = addUsage(s.usage, shard.account.total);
    }
    stats.set(dev, s);
  }
  const developerReports: DeveloperReport[] = [...developers]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([developer, info]) => {
      const s = stats.get(developer);
      const activity = [...(s?.activity ?? [])].sort();
      const inPeriod = activity.filter((t) => t >= since && t <= until);
      const rosterStatus =
        roster && !info.onRoster
          ? "unmatched"
          : inPeriod.length > 0
            ? "active"
            : activity.length > 0
              ? "inactive_in_period"
              : "no_usage_recorded";
      const intentKeys = [...(s?.intents ?? [])];
      return {
        developer,
        github: info.github,
        emails: [...info.emails].sort(),
        roster_status: rosterStatus,
        first_activity: activity[0] ?? null,
        last_activity: activity.at(-1) ?? null,
        active_days: new Set(inPeriod.map((t) => t.slice(0, 10))).size,
        sessions: s?.sessions ?? 0,
        intents_participated_lifetime: intentKeys.length,
        intents_completed_lifetime: intentKeys.filter((k) => intentStatus.get(k) === "complete").length,
        lifetime_usage: s?.usage ?? null,
      };
    });

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: options.until.toISOString(),
    source: {
      repo: process.env.GITHUB_REPOSITORY ?? null,
      ref: git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || null,
      commit: git(repo, ["rev-parse", "HEAD"])?.trim() || null,
      shallow,
    },
    aidlc_compatibility: AIDLC_COMPATIBILITY,
    period: { since, until },
    warnings,
    intents,
    developers: developerReports,
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

const LIFECYCLE_EVENTS = new Set([
  "WORKFLOW_STARTED",
  "WORKFLOW_PARKED",
  "WORKFLOW_UNPARKED",
  "WORKFLOW_COMPLETED",
  "STAGE_STARTED",
  "STAGE_COMPLETED",
]);

function endsParked(group: Shard[]): boolean {
  const lifecycle = group.flatMap((s) => s.events.filter((e) => LIFECYCLE_EVENTS.has(e.event))).sort(byTime);
  return lifecycle.at(-1)?.event === "WORKFLOW_PARKED";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// CSV

/** Quotes a CSV cell and neutralises spreadsheet formula injection in text values. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(header: string[], rows: (string | number | boolean | null)[][]): string {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

function usageCells(u: Usage | null): (number | boolean | null)[] {
  if (!u) return [null, null, null, null, null, null];
  return [u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd === null ? null : round2(u.costUsd), u.hasUnpriced];
}

const USAGE_HEADER = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "est_cost_usd_list_price",
  "cost_has_unpriced",
];

export function renderCsvs(report: Report): Record<string, string> {
  const developers = toCsv(
    [
      "developer",
      "github",
      "emails",
      "roster_status",
      "period_start",
      "period_end",
      "first_activity",
      "last_activity",
      "active_days",
      "sessions",
      "intents_participated_lifetime",
      "intents_completed_lifetime",
      ...USAGE_HEADER.map((h) => `lifetime_${h}`),
    ],
    report.developers.map((d) => [
      d.developer,
      d.github,
      d.emails.join(";"),
      d.roster_status,
      report.period.since,
      report.period.until,
      d.first_activity,
      d.last_activity,
      d.active_days,
      d.sessions,
      d.intents_participated_lifetime,
      d.intents_completed_lifetime,
      ...usageCells(d.lifetime_usage),
    ]),
  );
  const implementations = toCsv(
    [
      "space",
      "intent_id",
      "slug",
      "status",
      "contributors",
      "started_at",
      "completed_at",
      "elapsed_hours",
      "stages_completed",
      ...USAGE_HEADER,
      "usage_partial",
      "unstaged_tokens",
      "flags",
    ],
    report.intents.map((i) => [
      i.space,
      i.intent_id,
      i.slug,
      i.status,
      i.contributors.join(";"),
      i.started_at,
      i.completed_at,
      i.elapsed_hours,
      i.stages_completed,
      ...usageCells(i.usage),
      i.usage_partial,
      i.unstaged_tokens,
      i.flags.join(";"),
    ]),
  );
  const perDeveloper = toCsv(
    ["space", "intent_id", "slug", "developer", "attribution", ...USAGE_HEADER],
    report.intents.flatMap((i) =>
      i.by_developer.map((d) => [i.space, i.intent_id, i.slug, d.developer, d.attribution, ...usageCells(d.usage)]),
    ),
  );
  return {
    "developer-usage.csv": developers,
    "implementation-usage.csv": implementations,
    "implementation-developer-usage.csv": perDeveloper,
  };
}

// ---------------------------------------------------------------------------
// CLI

export function parseSince(value: string, until: Date): Date {
  const days = /^(\d+)d$/.exec(value);
  if (days) return new Date(until.getTime() - Number(days[1]) * DAY_MS);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid --since value: ${value} (use e.g. 30d or 2026-01-31)`);
  return date;
}

export function loadRoster(file: string): RosterMember[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const members = (parsed as { members?: unknown })?.members;
  if (!Array.isArray(members)) throw new Error(`Roster ${file} must be an object with a "members" array.`);
  return members.map((m, i) => {
    const r = (m ?? {}) as Record<string, unknown>;
    if (typeof r.name !== "string" || !r.name.trim()) throw new Error(`Roster member #${i + 1} needs a "name".`);
    const emails = Array.isArray(r.emails) ? r.emails.filter((e): e is string => typeof e === "string") : [];
    return {
      name: r.name.trim(),
      github: typeof r.github === "string" && r.github.trim() ? r.github.trim().replace(/^@/, "") : null,
      emails: emails.map((e) => normaliseIdentity(e, "").email),
    };
  });
}

const HELP = `Usage: aidlc-usage-report [options]

Reads committed AWS AI-DLC audit records and writes usage-report.json plus CSV reports.

Options:
  --repo <path>     AI-DLC repository to read (default: current directory)
  --since <value>   Activity period start: "<n>d" or an ISO date (default: 30d)
  --roster <file>   Team roster JSON (default: <repo>/.aidlc-usage/team.json if present)
  --out <dir>       Output directory (default: ./aidlc-usage-report)
  -h, --help        Show this help
`;

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string", default: "." },
      since: { type: "string", default: "30d" },
      roster: { type: "string" },
      out: { type: "string", default: "aidlc-usage-report" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const repo = resolve(values.repo);
  const until = new Date();
  const rosterFile = values.roster ?? join(repo, ".aidlc-usage", "team.json");
  const roster = values.roster || existsSync(rosterFile) ? loadRoster(rosterFile) : null;
  const report = buildReport({ repo, since: parseSince(values.since, until), until, roster });
  if (!roster) report.warnings.push("No roster found; members without activity cannot be listed.");

  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "usage-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const [name, content] of Object.entries(renderCsvs(report))) writeFileSync(join(out, name), content);

  for (const w of report.warnings) process.stderr.write(`warning: ${w}\n`);
  process.stdout.write(
    `Wrote ${report.intents.length} intents and ${report.developers.length} developers to ${relative(process.cwd(), out) || "."}\n`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
