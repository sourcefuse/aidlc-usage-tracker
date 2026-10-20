// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/**
 * Read-only git queries. git is invoked without a shell, with fixed arguments, a literal
 * pathspec limited to `aidlc/spaces`, no pager, no external diff or textconv drivers,
 * no optional locks and a timeout, so repository contents cannot inject options or commands.
 */
import { execFileSync } from "node:child_process";
import { isBot, normaliseIdentity } from "./identity.ts";
import type { Identity } from "./types.ts";

const SAFE_CONFIG = [
  "-c",
  "core.quotePath=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.pager=cat",
  "--no-pager",
  "--literal-pathspecs",
];

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...SAFE_CONFIG, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    });
  } catch {
    return null;
  }
}

export interface GitInfo {
  /** Repository-relative path -> distinct human authors of non-merge commits touching it. */
  authors: Map<string, Identity[]> | null;
  ref: string | null;
  commit: string | null;
  shallow: boolean;
}

export function readGitInfo(repo: string): GitInfo {
  return {
    authors: readAuthors(repo),
    ref: git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || null,
    commit: git(repo, ["rev-parse", "HEAD"])?.trim() || null,
    shallow: git(repo, ["rev-parse", "--is-shallow-repository"])?.trim() === "true",
  };
}

/**
 * `--no-merges` skips merge commits, whose author is whoever merged the PR; squash merges
 * keep the PR author. Bot authors are ignored.
 */
function readAuthors(repo: string): Map<string, Identity[]> | null {
  const out = git(repo, [
    "log",
    "--no-merges",
    "--no-ext-diff",
    "--no-textconv",
    "--format=%x00%ae%x09%an",
    "--name-only",
    "--",
    "aidlc/spaces",
  ]);
  if (out === null) return null;
  const authors = new Map<string, Map<string, Identity>>();
  let current: Identity | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("\0")) {
      const [email = "", name = ""] = line.slice(1).split("\t");
      current = isBot(email, name) ? null : normaliseIdentity(email, name);
    } else if (line && current) {
      const byKey = authors.get(line) ?? new Map<string, Identity>();
      byKey.set(current.key, current);
      authors.set(line, byKey);
    }
  }
  return new Map([...authors].map(([path, byKey]) => [path, [...byKey.values()]]));
}
