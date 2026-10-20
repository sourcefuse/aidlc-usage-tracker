// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/** Public API for programmatic use and future integrations. */
export { accountShard, addUsage, tokenTotal } from "./accounting.ts";
export { parseAuditShard } from "./audit.ts";
export { main, parseSince } from "./cli.ts";
export { normaliseIdentity, parseRoster } from "./identity.ts";
export { csvCell, renderCsvs, writeReportFiles } from "./output.ts";
export { AIDLC_COMPATIBILITY, AMBIGUOUS, buildReport, SCHEMA_VERSION, UNATTRIBUTED } from "./report.ts";
export type * from "./types.ts";
export { AidlcWorkspace, LIMITS, readFileSafely } from "./workspace.ts";
