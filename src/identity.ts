// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

import type { Identity, RosterMember } from "./types.ts";

const NOREPLY_EMAIL = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/;
const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;

/** Normalises a git author into a stable identity. Handles noreply addresses and stray quotes. */
export function normaliseIdentity(rawEmail: string, rawName: string): Identity {
  const clean = (s: string) => s.trim().replace(QUOTES, "").trim();
  const email = clean(rawEmail).toLowerCase();
  const name = clean(rawName);
  const login = NOREPLY_EMAIL.exec(email)?.[1] ?? null;
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
