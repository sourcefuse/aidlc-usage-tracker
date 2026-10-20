// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/**
 * Parser for AWS AI-DLC audit shards (`audit/<host>-<clone>.md`).
 *
 * Blocks are separated by `---` lines and hold `**Key**: value` fields. Only the
 * allow-listed fields below are ever read: free-text fields (Request, Details, Reason,
 * Person Reply, Feedback, ...) can contain prompts or client data and are ignored.
 */
import type { AuditEvent, Usage } from "./types.ts";

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
const ZERO_COMPACT = /^0(?:\.0+)?[kMB]?$/;

/** Parses one audit shard. Malformed blocks are skipped rather than guessed. */
export function parseAuditShard(text: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split(/^---[ \t]*$/m)) {
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
  let hasUnpriced: boolean;
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
  const tokens = splitPairs(tokensByModel ?? "");
  for (const [model, price] of splitPairs(byModel)) {
    if (price !== "null") continue;
    if (
      tokens
        .get(model)
        ?.split("/")
        .some((part) => !ZERO_COMPACT.test(part.trim()))
    )
      return true;
  }
  return false;
}

/** Splits `a=1; b=2` into a map. Model names may contain `<`/`>` but not `=`. */
function splitPairs(value: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const entry of value.split(";")) {
    const at = entry.lastIndexOf("=");
    if (at > 0) pairs.set(entry.slice(0, at).trim(), entry.slice(at + 1).trim());
  }
  return pairs;
}
