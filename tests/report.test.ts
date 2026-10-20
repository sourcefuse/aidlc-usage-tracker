// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AidlcWorkspace,
  AMBIGUOUS,
  accountShard,
  buildReport,
  csvCell,
  main,
  normaliseIdentity,
  parseAuditShard,
  parseSince,
  type Report,
  type RosterMember,
  renderCsvs,
  tokenTotal,
} from "../src/index.ts";
import {
  block,
  CANARY,
  DEV_A,
  DEV_B,
  humanTurn,
  intentAudit,
  LEAD,
  registry,
  session,
  shard,
  spaceAudit,
  stageDone,
  started,
  TestRepo,
  usage,
  workflowDone,
} from "./helpers.ts";

const UNTIL = new Date("2026-03-01T00:00:00Z");
const SINCE = new Date("2026-01-01T00:00:00Z");
const report = (repo: TestRepo, roster: RosterMember[] | null = null): Report =>
  buildReport(AidlcWorkspace.open(repo.dir), { since: SINCE, until: UNTIL, roster });
const intent = (r: Report, dir: string) => {
  const found = r.intents.find((i) => i.dir_name === dir);
  assert.ok(found, `intent ${dir} missing`);
  return found;
};
const dev = (r: Report, name: string) => {
  const found = r.developers.find((d) => d.developer === name);
  assert.ok(found, `developer ${name} missing`);
  return found;
};

describe("parsing and accounting", () => {
  it("reads a sanitised real AI-DLC v2.10.0 shard with the expected totals", () => {
    const text = readFileSync(new URL("./fixtures/real-format/dev-a-laptop-0a1b2c3d4e5f.md", import.meta.url), "utf8");
    const events = parseAuditShard(text);
    assert.equal(events.length, 1224);
    const a = accountShard(events);
    // Expected values computed independently from the fixture (latest of three WORKFLOW_COMPLETED).
    assert.deepEqual(a.total, {
      input: 1490,
      output: 635349,
      cacheRead: 244654857,
      cacheWrite: 4648498,
      costUsd: 172.96,
      hasUnpriced: false, // `<synthetic>=null` has no tokens, so it is not unpriced usage
    });
    assert.equal(a.unstagedTokens, 23484597);
    assert.equal(a.stagesCompleted.size, 7);
    assert.equal(a.firstStartedAt, "2026-02-02T12:51:26.000Z");
    assert.equal(a.lastCompletedAt, "2026-02-07T14:12:32.000Z");
    assert.equal(a.sessions.length, 4);
    assert.deepEqual([...a.flags], []);
  });

  it("never reads free-text fields", () => {
    const events = parseAuditShard(shard(started("2026-01-02T00:00:00Z"), humanTurn("2026-01-02T00:01:00Z")));
    assert.equal(events.length, 2);
    assert.ok(!JSON.stringify(events).includes(CANARY));
  });

  it("uses the first Timestamp and skips malformed blocks", () => {
    const text = shard(
      "**Timestamp**: 2026-01-02T00:00:00Z\n**Timestamp**: 2027-01-01T00:00:00Z\n**Event**: SESSION_STARTED",
      "**Timestamp**: not-a-date\n**Event**: SESSION_STARTED",
      "**Timestamp**: 2026-01-02T00:00:00Z\n**Event**: lower_case",
      "**Timestamp**: 2026-01-02T00:00:00Z",
    );
    const events = parseAuditShard(text);
    assert.equal(events.length, 1);
    assert.equal(events[0].timestamp, "2026-01-02T00:00:00.000Z");
  });

  it("C: counts only the latest cumulative stage and workflow snapshots", () => {
    const a = accountShard(
      parseAuditShard(
        shard(
          started("2026-01-02T00:00:00Z"),
          stageDone("2026-01-02T01:00:00Z", "code-generation", usage(10, 100, 1000, 10, "1.00")),
          workflowDone("2026-01-02T02:00:00Z", usage(12, 120, 1200, 12, "1.20")),
          stageDone("2026-01-03T01:00:00Z", "code-generation", usage(20, 200, 2000, 20, "2.00")),
          workflowDone("2026-01-03T02:00:00Z", usage(25, 250, 2500, 25, "2.50")),
        ),
      ),
    );
    assert.equal(a.total?.costUsd, 2.5);
    assert.equal(a.total && tokenTotal(a.total), 2800);
    assert.equal(a.unstagedTokens, 2800 - 2240);
    assert.deepEqual([...a.flags], []);
  });

  it("takes the larger stage total when the intent was reopened after completing", () => {
    const a = accountShard(
      parseAuditShard(
        shard(
          stageDone("2026-01-02T01:00:00Z", "code-generation", usage(10, 100, 1000, 10, "1.00")),
          workflowDone("2026-01-02T02:00:00Z", usage(12, 120, 1200, 12, "1.20")),
          stageDone("2026-01-03T01:00:00Z", "code-generation", usage(30, 300, 3000, 30, "3.00")),
        ),
      ),
    );
    assert.equal(a.total?.costUsd, 3);
    assert.deepEqual([...a.flags], ["reopened"]);
  });

  it("flags a decreasing snapshot and a workflow total below the stage total", () => {
    const a = accountShard(
      parseAuditShard(
        shard(
          stageDone("2026-01-02T01:00:00Z", "code-generation", usage(10, 100, 1000, 10, "5.00")),
          stageDone("2026-01-02T02:00:00Z", "code-generation", usage(1, 10, 100, 1, "0.50")),
          stageDone("2026-01-02T03:00:00Z", "build-and-test", usage(1, 10, 100, 1, "0.50")),
          workflowDone("2026-01-02T04:00:00Z", usage(1, 10, 100, 1, "0.50")),
        ),
      ),
    );
    assert.equal(a.total?.costUsd, 1, "latest snapshots win; no reset reconstruction");
    assert.deepEqual([...a.flags].sort(), ["discrepancy", "usage_decreased"]);
  });

  it("marks unpriced usage without ever turning it into zero cost", () => {
    const nullCost = accountShard(
      parseAuditShard(shard(stageDone("2026-01-02T01:00:00Z", "a", { ...usage(1, 1, 1, 1, "null") }))),
    );
    assert.equal(nullCost.total?.costUsd, null);
    assert.equal(nullCost.total?.hasUnpriced, true);

    const mixed = accountShard(
      parseAuditShard(
        shard(
          stageDone("2026-01-02T01:00:00Z", "a", {
            ...usage(2, 2, 2, 2, "1.00"),
            "By Model": "opus-5=1.00; custom-model=null; <synthetic>=null",
            "Tokens By Model": "opus-5=1/1/1/1; custom-model=1/1/1/1",
          }),
        ),
      ),
    );
    assert.equal(mixed.total?.costUsd, 1);
    assert.equal(mixed.total?.hasUnpriced, true);
  });

  it("E: leaves usage blank when no usage was recorded", () => {
    const a = accountShard(
      parseAuditShard(shard(started("2026-01-02T00:00:00Z"), stageDone("2026-01-02T01:00:00Z", "a"))),
    );
    assert.equal(a.total, null);
    assert.equal(a.unstagedTokens, null);
    assert.equal(a.stagesCompleted.size, 1);
  });
});

describe("identity and CSV safety", () => {
  it("normalises quoted emails and GitHub noreply addresses", () => {
    assert.equal(normaliseIdentity("“Dev.A@Example.com”", " “Dev A ").email, "dev.a@example.com");
    assert.equal(normaliseIdentity("“Dev.A@Example.com”", " “Dev A ").name, "Dev A");
    const noreply = normaliseIdentity("12345+octo-cat@users.noreply.github.com", "Octo");
    assert.equal(noreply.login, "octo-cat");
    assert.equal(noreply.key, normaliseIdentity("octo-cat@users.noreply.github.com", "").key);
  });

  it("neutralises spreadsheet formulas and quotes special characters", () => {
    assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
    assert.equal(csvCell("-cmd"), "'-cmd");
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    assert.equal(csvCell(-5), "-5");
    assert.equal(csvCell(null), "");
  });

  it("parses --since as days or a date", () => {
    assert.equal(parseSince("30d", UNTIL).toISOString(), "2026-01-30T00:00:00.000Z");
    assert.equal(parseSince("2026-01-15", UNTIL).toISOString(), "2026-01-15T00:00:00.000Z");
    assert.throws(() => parseSince("yesterday", UNTIL));
  });
});

describe("acceptance (temporary git repositories)", () => {
  it("A: a squash merge done by someone else is attributed to the PR author", () => {
    const repo = new TestRepo()
      .write(
        intentAudit("i1", "dev-a-laptop-1.md"),
        shard(
          started("2026-01-02T00:00:00Z"),
          stageDone("2026-01-02T01:00:00Z", "a", usage(1, 1, 1, 1, "1.00")),
          workflowDone("2026-01-02T02:00:00Z", usage(1, 1, 1, 1, "1.00")),
        ),
      )
      .squashMerge(DEV_A, "feat: story 1 (#1)");
    const r = report(repo);
    const i = intent(r, "i1");
    assert.deepEqual(i.contributors, ["Dev A"]);
    assert.equal(i.usage_partial, false);
    assert.equal(i.usage?.costUsd, 1);
    assert.equal(r.audit_files[0].attribution, "attributed");
  });

  it("C: with merge commits, the merger is never credited", () => {
    const repo = new TestRepo().write("README.md", "x").commit(LEAD, "chore: init");
    repo.git(["checkout", "-q", "-b", "story"]);
    repo
      .write(intentAudit("i1", "dev-a-laptop-1.md"), shard(started("2026-01-02T00:00:00Z")))
      .commit(DEV_A, "feat: s1");
    repo.git(["checkout", "-q", "main"]);
    repo.mergeBranch("story", LEAD);
    assert.deepEqual(intent(report(repo), "i1").contributors, ["Dev A"]);
  });

  it("B: two developers on one intent are summed without double counting", () => {
    const repo = new TestRepo()
      .write(
        intentAudit("i1", "dev-a-laptop-1.md"),
        shard(
          started("2026-01-02T00:00:00Z"),
          stageDone("2026-01-02T01:00:00Z", "a", usage(1, 1, 1, 1, "1.00")),
          workflowDone("2026-01-02T02:00:00Z", usage(2, 2, 2, 2, "2.00")),
        ),
      )
      .commit(DEV_A, "feat: a")
      .write(
        intentAudit("i1", "dev-b-laptop-2.md"),
        shard(stageDone("2026-01-02T01:30:00Z", "b", usage(3, 3, 3, 3, "3.00"))),
      )
      .commit(DEV_B, "feat: b");
    const i = intent(report(repo), "i1");
    assert.deepEqual(i.contributors, ["Dev A", "Dev B"]);
    assert.equal(i.usage?.costUsd, 5);
    assert.equal(i.usage && tokenTotal(i.usage), 20);
    const perDev = i.by_developer.reduce((sum, d) => sum + (d.usage?.costUsd ?? 0), 0);
    assert.equal(perDev, i.usage?.costUsd, "per-developer rows reconcile to the intent row");
  });

  it("ambiguous shards go to their own bucket and still reconcile", () => {
    const repo = new TestRepo()
      .write(intentAudit("i1", "shared.md"), shard(stageDone("2026-01-02T01:00:00Z", "a", usage(1, 1, 1, 1, "1.00"))))
      .commit(DEV_A, "feat: a")
      .write(
        intentAudit("i1", "shared.md"),
        shard(
          stageDone("2026-01-02T01:00:00Z", "a", usage(1, 1, 1, 1, "1.00")),
          stageDone("2026-01-02T02:00:00Z", "b", usage(1, 1, 1, 1, "1.00")),
        ),
      )
      .commit(DEV_B, "feat: b");
    const i = intent(report(repo), "i1");
    assert.deepEqual(i.contributors, []);
    assert.deepEqual(
      i.by_developer.map((d) => [d.developer, d.usage?.costUsd]),
      [[AMBIGUOUS, 2]],
    );
  });

  it("C2: unregistered intents are reported; space-level activity counts as activity", () => {
    const repo = new TestRepo()
      .write(
        "aidlc/spaces/default/intents/intents.json",
        registry([{ uuid: "u-1", slug: "one", dirName: "i1", status: "complete" }]),
      )
      .write(intentAudit("i1", "a.md"), shard(started("2026-01-02T00:00:00Z")))
      .write(intentAudit("i2", "a.md"), shard(started("2026-01-03T00:00:00Z"), workflowDone("2026-01-03T05:00:00Z")))
      .commit(DEV_A, "feat: a")
      .write(
        spaceAudit("lead.md"),
        shard(block("Health Checked", { Timestamp: "2026-01-04T00:00:00Z", Event: "HEALTH_CHECKED" })),
      )
      .commit(LEAD, "chore: init");
    const r = report(repo);
    assert.equal(intent(r, "i1").intent_id, "u-1");
    assert.deepEqual(intent(r, "i2").flags, ["unregistered"]);
    assert.equal(intent(r, "i2").status, "complete");
    assert.equal(intent(r, "i2").elapsed_hours, 5);
    const lead = dev(r, "Lead");
    assert.equal(lead.roster_status, "active");
    assert.equal(lead.intents_participated_lifetime, 0);
    assert.equal(lead.lifetime_usage, null);
  });

  it("D: audit files on unmerged branches are excluded until merged to main", () => {
    const repo = new TestRepo().write("README.md", "x").commit(LEAD, "chore: init");
    repo.git(["checkout", "-q", "-b", "story"]);
    repo.write(intentAudit("i1", "a.md"), shard(started("2026-01-02T00:00:00Z"))).commit(DEV_A, "feat: s1");
    repo.git(["checkout", "-q", "main"]);
    assert.equal(report(repo).intents.length, 0);
    repo.mergeBranch("story", LEAD);
    assert.equal(report(repo).intents.length, 1);
  });

  it("E: an intent with activity but no completed stage shows blank usage", () => {
    const repo = new TestRepo()
      .write(intentAudit("i1", "a.md"), shard(started("2026-01-02T00:00:00Z"), session("2026-01-02T00:01:00Z")))
      .commit(DEV_A, "feat: a");
    const i = intent(report(repo), "i1");
    assert.equal(i.usage, null);
    assert.equal(i.usage_partial, true);
    const row = renderCsvs(report(repo))["implementation-usage.csv"].split("\n")[1].split(",");
    assert.equal(row[9], "", "blank, not 0");
  });

  it("F: roster members without activity are no_usage_recorded; unknown authors are unmatched", () => {
    const repo = new TestRepo()
      .write(intentAudit("i1", "a.md"), shard(session("2026-01-10T00:00:00Z")))
      .commit({ name: "Dev A (laptop)", email: "“dev.a@example.com”" }, "feat: a")
      .write(intentAudit("i1", "x.md"), shard(session("2026-01-11T00:00:00Z")))
      .commit({ name: "Stranger", email: "stranger@example.com" }, "feat: x");
    const roster: RosterMember[] = [
      { name: "Alice", github: null, emails: ["dev.a@example.com"] },
      { name: "Bob", github: "bob", emails: [] },
    ];
    const r = report(repo, roster);
    assert.equal(dev(r, "Alice").roster_status, "active");
    assert.equal(dev(r, "Alice").sessions, 1);
    assert.equal(dev(r, "Bob").roster_status, "no_usage_recorded");
    assert.equal(dev(r, "Stranger").roster_status, "unmatched");
  });

  it("writes JSON and CSVs that never contain free text", () => {
    const repo = new TestRepo()
      .write(
        intentAudit("i1", "a.md"),
        shard(
          started("2026-01-02T00:00:00Z"),
          humanTurn("2026-01-02T00:30:00Z"),
          stageDone("2026-01-02T01:00:00Z", "a", usage(1, 1, 1, 1, "1.00")),
          workflowDone("2026-01-02T02:00:00Z", usage(1, 1, 1, 1, "1.00")),
        ),
      )
      .commit(DEV_A, "feat: a");
    const out = mkdtempSync(join(tmpdir(), "aidlc-usage-out-"));
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
      assert.equal(main(["--repo", repo.dir, "--out", out]), 0);
    } finally {
      process.stdout.write = write;
    }
    const files = readdirSync(out).sort();
    assert.deepEqual(files, [
      "developer-usage.csv",
      "implementation-developer-usage.csv",
      "implementation-usage.csv",
      "usage-report.json",
    ]);
    for (const f of files) assert.ok(!readFileSync(join(out, f), "utf8").includes(CANARY), `${f} leaks free text`);
  });
});
