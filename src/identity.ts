// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

import type { Identity, RosterMember } from "./types.ts";

const NOREPLY_DOMAIN = "@users.noreply.github.com";
const QUOTES = new Set(['"', "'", "“", "”", "‘", "’"]);

/**
 * Trims whitespace and surrounding quote characters. Implemented as a linear scan rather
 * than a regex because git author fields are untrusted input (avoids ReDoS).
 */
function trimQuotes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (QUOTES.has(value[start]) || value[start].trim() === "")) start++;
  while (end > start && (QUOTES.has(value[end - 1]) || value[end - 1].trim() === "")) end--;
  return value.slice(start, end);
}

/** `12345+login@users.noreply.github.com` or `login@users.noreply.github.com` -> `login`. */
function noreplyLogin(email: string): string | null {
  if (!email.endsWith(NOREPLY_DOMAIN)) return null;
  const local = email.slice(0, -NOREPLY_DOMAIN.length);
  const login = local.slice(local.indexOf("+") + 1);
  return login && !login.includes("@") ? login : null;
}

/** Normalises a git author into a stable identity. Handles noreply addresses and stray quotes. */
export function normaliseIdentity(rawEmail: string, rawName: string): Identity {
  const email = trimQuotes(rawEmail).toLowerCase();
  const name = trimQuotes(rawName);
  const login = noreplyLogin(email);
  return { key: login ? `github:${login}` : email, email, login, name };
}

export function isBot(email: string, name: string): boolean {
  return /\[bot\]/i.test(name) || /\[bot\]/i.test(email);
}

/** Validates a parsed roster document: `{ "members": [{ "name", "github"?, "emails"? }] }`. */
export function parseRoster(document: unknown, source: string): RosterMember[] {
  const members = (document as { members?: unknown } | null)?.members;
  if (!Array.isArray(members)) throw new Error(`Roster ${source} must be an object with a "members" array.`);
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

export function findRosterMember(roster: RosterMember[] | null, id: Identity): RosterMember | undefined {
  return roster?.find(
    (m) => (id.login !== null && m.github?.toLowerCase() === id.login.toLowerCase()) || m.emails.includes(id.email),
  );
}
