// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Free-text marker: must never appear in any report output. */
export const CANARY = "CANARY-FREE-TEXT";

export interface Person {
  name: string;
  email: string;
}

export const DEV_A: Person = { name: "Dev A", email: "dev.a@example.com" };
export const DEV_B: Person = { name: "Dev B", email: "dev.b@example.com" };
export const LEAD: Person = { name: "Lead", email: "lead@example.com" };
const GITHUB: Person = { name: "GitHub", email: "noreply@github.com" };

/** Renders one audit block in the layout AI-DLC writes (`## Heading`, `**Key**: value`). */
export function block(heading: string, fields: Record<string, string | number>): string {
  return [`## ${heading}`, ...Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)].join("\n");
}

export function shard(...blocks: string[]): string {
  return `# AI-DLC Audit Log\n\n${blocks.join("\n\n---\n\n")}\n`;
}

export function usage(input: number, output: number, cacheRead: number, cacheWrite: number, cost: string) {
  return {
    "Tokens In": input,
    "Tokens Out": output,
    "Cache Read": cacheRead,
    "Cache Write": cacheWrite,
    "Cost USD": cost,
    "By Model": `opus-5=${cost}; <synthetic>=null`,
    "Tokens By Model": `opus-5=${input}/${output}/${cacheRead}/${cacheWrite}`,
  };
}

export const started = (ts: string) =>
  block("Workflow Start", { Timestamp: ts, Event: "WORKFLOW_STARTED", Scope: "bugfix", Request: CANARY });

export const stageDone = (ts: string, stage: string, u?: Record<string, string | number>) =>
  block("Stage Completion", { Timestamp: ts, Event: "STAGE_COMPLETED", Stage: stage, Details: CANARY, ...u });

export const workflowDone = (ts: string, u?: Record<string, string | number>) =>
  block("Workflow Completion", { Timestamp: ts, Event: "WORKFLOW_COMPLETED", Reason: CANARY, ...u });

export const session = (ts: string) =>
  block("Session Start", { Timestamp: ts, Event: "SESSION_STARTED", Source: "startup", Session: "s-1" });

export const humanTurn = (ts: string) =>
  block("Human Turn", { Timestamp: ts, Event: "HUMAN_TURN", "Person Reply": CANARY });

/** A throwaway git repository with deterministic authors and no user/global config. */
export class TestRepo {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? mkdtempSync(join(tmpdir(), "aidlc-usage-"));
    mkdirSync(this.dir, { recursive: true });
    this.git(["init", "-q", "-b", "main"]);
  }

  git(args: string[], author: Person = LEAD, committer: Person = author): string {
    return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: this.dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: this.dir,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
      },
    });
  }

  write(path: string, content: string): this {
    const file = join(this.dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return this;
  }

  /** Commits everything as `author`; `committer` defaults to the author. */
  commit(author: Person, message: string, committer: Person = author): this {
    this.git(["add", "-A"], author, committer);
    this.git(["commit", "-q", "-m", message], author, committer);
    return this;
  }

  /** Simulates a GitHub squash merge: author is the PR author, committer is GitHub. */
  squashMerge(prAuthor: Person, message: string): this {
    return this.commit(prAuthor, message, GITHUB);
  }

  /** Simulates a GitHub merge commit: the merge commit's author is whoever merged the PR. */
  mergeBranch(branch: string, merger: Person): this {
    this.git(["merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch], merger, GITHUB);
    return this;
  }
}

export const intentAudit = (intent: string, file: string) => `aidlc/spaces/default/intents/${intent}/audit/${file}`;
export const spaceAudit = (file: string) => `aidlc/spaces/default/intents/audit/${file}`;
export const registry = (rows: { uuid: string; slug: string; dirName: string; status: string }[]) =>
  `${JSON.stringify(rows, null, 2)}\n`;
