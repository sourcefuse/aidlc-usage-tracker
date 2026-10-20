// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/** CSV views of the report and safe writing of the four output files. */
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { round2 } from "./report.ts";
import type { Report, Usage } from "./types.ts";

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Quotes a CSV cell and neutralises spreadsheet formula injection in text values. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

type Cell = string | number | boolean | null;

function toCsv(header: string[], rows: Cell[][]): string {
  return `${[header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}

const USAGE_HEADER = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "est_cost_usd_list_price",
  "cost_has_unpriced",
];

function usageCells(u: Usage | null): Cell[] {
  if (!u) return [null, null, null, null, null, null];
  return [u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd === null ? null : round2(u.costUsd), u.hasUnpriced];
}

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
    "usage-report.json": `${JSON.stringify(report, null, 2)}\n`,
    "developer-usage.csv": developers,
    "implementation-usage.csv": implementations,
    "implementation-developer-usage.csv": perDeveloper,
  };
}

/**
 * Writes the report files into `dir`. The directory must not be a symlink and each file is
 * opened with O_NOFOLLOW, so a pre-planted symlink cannot redirect a write. Files are
 * owner-readable only because they contain names and email addresses.
 */
export function writeReportFiles(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) {
    throw new Error(`Output directory must be a real directory: ${dir}`);
  }
  for (const [name, content] of Object.entries(files)) {
    const fd = openSync(
      join(dir, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
  }
}
