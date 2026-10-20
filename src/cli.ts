// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/** Command-line entry point: `node src/cli.ts --repo <path> [--since 30d] [--roster file] [--out dir]`. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseRoster } from "./identity.ts";
import { renderCsvs, writeReportFiles } from "./output.ts";
import { buildReport } from "./report.ts";
import type { RosterMember } from "./types.ts";
import { AidlcWorkspace, LIMITS, readFileSafely } from "./workspace.ts";

const DAY_MS = 86_400_000;

const HELP = `Usage: aidlc-usage-report [options]

Reads committed AWS AI-DLC audit records and writes usage-report.json plus CSV reports.

Options:
  --repo <path>     AI-DLC repository to read (default: current directory)
  --since <value>   Activity period start: "<n>d" or an ISO date (default: 30d)
  --roster <file>   Team roster JSON (default: <repo>/.aidlc-usage/team.json if present)
  --out <dir>       Output directory (default: ./aidlc-usage-report); must be outside <repo>/aidlc
  -h, --help        Show this help
`;

export function parseSince(value: string, until: Date): Date {
  const days = /^(\d{1,5})d$/.exec(value);
  if (days) return new Date(until.getTime() - Number(days[1]) * DAY_MS);
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid --since value: ${value} (use e.g. 30d or 2026-01-31)`);
  }
  return date;
}

function loadRoster(workspace: AidlcWorkspace, explicit: string | undefined): RosterMember[] | null {
  if (explicit) {
    const file = resolve(explicit);
    return parseRoster(JSON.parse(readFileSafely(file, LIMITS.maxJsonBytes)), explicit);
  }
  const document = workspace.readDefaultRoster();
  return document === undefined ? null : parseRoster(document, ".aidlc-usage/team.json");
}

export function main(argv: string[], now: Date = new Date()): number {
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

  const workspace = AidlcWorkspace.open(values.repo);
  const out = resolve(values.out);
  if (workspace.isInsideAidlcData(out)) throw new Error("--out must not be inside the repository's aidlc/ directory.");

  const roster = loadRoster(workspace, values.roster);
  const report = buildReport(workspace, { since: parseSince(values.since, now), until: now, roster });
  if (!roster) report.warnings.push("No roster found; members without activity cannot be listed.");
  writeReportFiles(out, renderCsvs(report));

  for (const w of report.warnings) process.stderr.write(`warning: ${w}\n`);
  process.stdout.write(`Wrote ${report.intents.length} intents and ${report.developers.length} developers to ${out}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
