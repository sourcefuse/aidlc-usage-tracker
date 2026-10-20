// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AidlcWorkspace, buildReport, main, readFileSafely, writeReportFiles } from "../src/index.ts";
import { CANARY, DEV_A, intentAudit, session, shard, stageDone, TestRepo, usage } from "./helpers.ts";

const OPTIONS = { since: new Date("2026-01-01T00:00:00Z"), until: new Date("2026-03-01T00:00:00Z"), roster: null };
const SECRET = "TOP-SECRET-OUTSIDE-REPO";

/** A file outside the repository that a hostile commit might try to make the tool read. */
function outsideSecret(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-outside-"));
  const file = join(dir, "secret.md");
  writeFileSync(file, shard(stageDone("2026-01-02T00:00:00Z", SECRET, usage(9, 9, 9, 9, "999.00"))));
  return file;
}

const quietly = (fn: () => number): number => {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return fn();
  } finally {
    process.stdout.write = write;
  }
};

describe("filesystem sandbox", () => {
  it("never follows a symlinked audit file", () => {
    const repo = new TestRepo().write(intentAudit("i1", "a.md"), shard(session("2026-01-02T00:00:00Z")));
    symlinkSync(outsideSecret(), join(repo.dir, intentAudit("i1", "evil.md")));
    repo.commit(DEV_A, "feat: a");
    const r = buildReport(AidlcWorkspace.open(repo.dir), OPTIONS);
    assert.deepEqual(
      r.audit_files.map((f) => f.path),
      [intentAudit("i1", "a.md")],
    );
    assert.ok(!JSON.stringify(r).includes(SECRET));
  });

  it("never traverses symlinked directories at any level", () => {
    const outside = mkdtempSync(join(tmpdir(), "aidlc-outside-dir-"));
    mkdirSync(join(outside, "audit"), { recursive: true });
    writeFileSync(join(outside, "audit", "x.md"), readFileSync(outsideSecret()));
    const repo = new TestRepo().write(intentAudit("i1", "a.md"), shard(session("2026-01-02T00:00:00Z")));
    symlinkSync(outside, join(repo.dir, "aidlc/spaces/default/intents/i2"));
    symlinkSync(join(outside), join(repo.dir, "aidlc/spaces/linked-space"));
    repo.commit(DEV_A, "feat: a");
    const r = buildReport(AidlcWorkspace.open(repo.dir), OPTIONS);
    assert.deepEqual(
      r.intents.map((i) => i.dir_name),
      ["i1"],
    );
    assert.ok(!JSON.stringify(r).includes(SECRET));
  });

  it("only reads allow-listed names: no hidden files or non-.md files", () => {
    const repo = new TestRepo()
      .write(intentAudit("i1", ".hidden.md"), shard(session("2026-01-02T00:00:00Z")))
      .write(intentAudit("i1", "notes.txt"), shard(session("2026-01-02T00:00:00Z")))
      .write("aidlc/spaces/default/intents/.i2/audit/a.md", shard(session("2026-01-02T00:00:00Z")))
      .commit(DEV_A, "feat: a");
    const r = buildReport(AidlcWorkspace.open(repo.dir), OPTIONS);
    assert.equal(r.audit_files.length, 0);
  });

  it("refuses oversized and non-regular files", () => {
    const dir = mkdtempSync(join(tmpdir(), "aidlc-size-"));
    writeFileSync(join(dir, "big.md"), "x".repeat(2048));
    assert.throws(() => readFileSafely(join(dir, "big.md"), 1024), /exceeds/);
    assert.throws(() => readFileSafely(dir, 1024));
    symlinkSync(join(dir, "big.md"), join(dir, "link.md"));
    assert.throws(() => readFileSafely(join(dir, "link.md"), 4096), /ELOOP|symbolic/i);
  });

  it("refuses to write through a pre-planted symlink or into aidlc/", () => {
    const out = mkdtempSync(join(tmpdir(), "aidlc-out-"));
    const target = join(mkdtempSync(join(tmpdir(), "aidlc-target-")), "victim.txt");
    writeFileSync(target, "original");
    symlinkSync(target, join(out, "developer-usage.csv"));
    assert.throws(() => writeReportFiles(out, { "developer-usage.csv": "x" }), /ELOOP|symbolic/i);
    assert.equal(readFileSync(target, "utf8"), "original");

    const repo = new TestRepo()
      .write(intentAudit("i1", "a.md"), shard(session("2026-01-02T00:00:00Z")))
      .commit(DEV_A, "a");
    assert.throws(
      () => quietly(() => main(["--repo", repo.dir, "--out", join(repo.dir, "aidlc", "report")])),
      /must not be inside/,
    );
  });

  it("writes only the four report files, readable by the owner only", () => {
    const repo = new TestRepo()
      .write(intentAudit("i1", "a.md"), shard(stageDone("2026-01-02T00:00:00Z", "a", { Request: CANARY })))
      .commit(DEV_A, "a");
    const out = mkdtempSync(join(tmpdir(), "aidlc-out-"));
    assert.equal(
      quietly(() => main(["--repo", repo.dir, "--out", out])),
      0,
    );
    assert.equal(readdirSync(out).length, 4);
    const mode = execFileSync(
      "stat",
      process.platform === "darwin"
        ? ["-f", "%Lp", join(out, "usage-report.json")]
        : ["-c", "%a", join(out, "usage-report.json")],
      {
        encoding: "utf8",
      },
    ).trim();
    assert.equal(mode, "600");
  });

  it("runs under Node's permission model with access limited to the repo and output", () => {
    const repo = new TestRepo()
      .write(intentAudit("i1", "a.md"), shard(session("2026-01-02T00:00:00Z")))
      .commit(DEV_A, "a");
    const out = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-perm-out-")));
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const run = (writeDir: string) =>
      execFileSync(
        process.execPath,
        [
          "--permission",
          `--allow-fs-read=${srcDir}`,
          `--allow-fs-read=${realpathSync(repo.dir)}`,
          `--allow-fs-read=${out}`,
          `--allow-fs-write=${writeDir}`,
          "--allow-child-process",
          join(srcDir, "cli.ts"),
          "--repo",
          realpathSync(repo.dir),
          "--out",
          out,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    assert.match(run(out), /Wrote 1 intents/);
    // Without write permission for the output directory, Node itself blocks the write.
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-perm-other-")));
    assert.throws(() => run(elsewhere), /ERR_ACCESS_DENIED|Access to this API has been restricted/);
  });
});

describe("licence headers", () => {
  it("every TypeScript source and test file carries the SourceFuse copyright header", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = ["src", "tests"].flatMap((d) =>
      readdirSync(join(root, d))
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(d, f)),
    );
    for (const f of [...files, "commitlint.config.mjs"]) {
      const head = readFileSync(join(root, f), "utf8").split("\n").slice(0, 2).join("\n");
      assert.equal(
        head,
        "// Copyright (c) 2026 SourceFuse\n// SPDX-License-Identifier: MIT",
        `${f} is missing the header`,
      );
    }
  });
});
