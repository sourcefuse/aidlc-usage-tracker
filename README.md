# AI-DLC Usage Tracker

[![CI](https://github.com/sourcefuse/aidlc-usage-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/sourcefuse/aidlc-usage-tracker/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sourcefuse/aidlc-usage-tracker/badge)](https://scorecard.dev/viewer/?uri=github.com/sourcefuse/aidlc-usage-tracker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![AWS AI-DLC](https://img.shields.io/badge/AWS%20AI--DLC-2.10.0%20%E2%80%93%202.11.1-FF9900)](#compatibility)

**A community extension for [AWS AI-DLC](https://github.com/awslabs/aidlc-workflows).** It provides
team-level **adoption** and **token/cost** reporting, built entirely from the audit records AI-DLC
already commits to your repository.

> **Status: experimental (v0).** The output format may change before v1.

The tracker answers two questions:

1. **Who on the team is using AI-DLC, and who isn't?**
2. **What did each implementation (AI-DLC intent) cost in tokens and estimated USD?**

There is nothing to install on developer machines: no hooks, agents, databases or external services.
A GitHub Action reads `main` whenever AI-DLC work is merged, and uploads CSV and JSON reports as a workflow artifact.

## How it works

```text
Developer runs AI-DLC ─► commits aidlc/ (incl. audit/*.md) on a branch ─► PR ─► merged to main
                                                                                   │
Workflow in the same repo (on merge) ─► this action reads main ─► reports as an artifact
```

AI-DLC writes one audit file per clone (`aidlc/spaces/<space>/intents/<intent>/audit/<host>-<clone>.md`).
When a stage or workflow completes, AI-DLC records the clone's cumulative token usage and list-price cost
in that file. The tracker:

- **Counts only the latest snapshot.** The figures are cumulative, so only the latest snapshot per stage
  and per workflow counts. A revisited stage is never double-counted.
- **Takes one total per audit file.** It uses the larger of the latest workflow total and the sum of the
  latest stage snapshots. The stage sum can be larger when the intent was reopened after completing.
- **Sums audit files per intent.** Each audit file comes from a separate, non-overlapping local ledger.
- **Attributes each file to its git author** (`git log --no-merges`). Squash merges credit the PR author,
  and with merge commits the merger is never credited.
- **Reads only an allow-list of fields:** event, timestamp, stage and usage numbers. Free-text fields can
  contain prompts or client requirements and are never read.

## Setup

Set this up once per project, in the repository where the team's AI-DLC workspace (`aidlc/`) lives.
It takes about 10 minutes.

### Prerequisites

- **AI-DLC run through Claude Code.** This is the only harness for which AI-DLC records token usage.
- **The repository commits `aidlc/`, including every `audit/` folder.** AI-DLC's own generated
  `.gitignore` already does this. Keep it as generated, and never commit `aidlc/.aidlc-sessions/`.
- **Stories reach `main` through pull requests.** Squash, merge-commit and rebase merges all work.
- **GitHub Actions is enabled** for the repository. No secrets or tokens are needed.

### Step 1: Add the workflow

Copy [`templates/aidlc-usage-report.yml`](templates/aidlc-usage-report.yml) to
`.github/workflows/aidlc-usage-report.yml` in your AI-DLC repository:

```yaml
name: AI-DLC usage report

on:
  push:
    branches: [main]
    paths:
      - "aidlc/spaces/*/intents/intents.json"
      - "aidlc/spaces/*/intents/**/audit/*.md" # intent-level and space-level audit files
      - ".aidlc-usage/team.json"
  workflow_dispatch:
  # Optional weekly snapshot, e.g. for a Monday review:
  # schedule:
  #   - cron: "0 2 * * 1"

permissions: {}

concurrency:
  group: aidlc-usage-report
  cancel-in-progress: true

jobs:
  report:
    name: Generate usage report
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: main
          fetch-depth: 0 # full history is needed to attribute work to developers
          persist-credentials: false
      - uses: sourcefuse/aidlc-usage-tracker@ba3c481053062d78f44ffcdd2b8f587dc2661983 # v0.1.0
        with:
          since: 30d
```

Points to note:

- **When it runs:** when a file the report reads changes on `main`, or on demand. Those files are the
  intent registry, the AI-DLC audit files and the roster. Changes to the knowledge base, codekb, memory or
  stage artifacts don't trigger a run, because they never change the report. If you pass a custom
  `roster` path, add it to `paths`.
- **Weekly snapshot (optional):** activity columns such as `active_days` and `roster_status` cover the
  period ending when the report ran. In weeks with no merges, the latest report stays as of the last
  merge. Uncomment `schedule` to also get a fresh report every Monday.
- **`fetch-depth: 0` is required.** Without full history the action cannot tell who did the work.
- **Pinning:** the action is pinned to a release's full commit SHA rather than a tag. A tag can be moved
  to different code, so a SHA guarantees you run exactly the release you reviewed. Step 3 keeps it up to date.

### Step 2: Add the team roster (recommended)

Create `.aidlc-usage/team.json` listing everyone expected to use AI-DLC. Without a roster, the report can't
show who has **no** recorded usage.

```json
{
  "members": [
    { "name": "Ada Lovelace", "github": "ada-l", "emails": ["ada@example.com", "ada.personal@example.org"] }
  ]
}
```

- **`name`** is how the person appears in the reports.
- **`emails`** lists every address the person commits with (`git config user.email`).
- **`github`** is the person's GitHub login. It is used when commits come from a
  `…@users.noreply.github.com` address, as with web-UI squash merges.

Authors who match nobody appear as `unmatched`. Add their address to the right member.
See also [`examples/team.json`](examples/team.json).

### Step 3: Keep the action up to date

Enable Dependabot for GitHub Actions in your AI-DLC repository, so you get a PR that bumps the pinned
SHA whenever a new tracker release is published. Add `.github/dependabot.yml`, or merge this entry into
an existing one:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

If you'd rather receive every v0 release automatically without review, use
`sourcefuse/aidlc-usage-tracker@v0` instead of the SHA. It's convenient, but it trusts every future v0
release unseen.

### Step 4: Run it and check the output

1. Go to **Actions → AI-DLC usage report → Run workflow**.
2. When the run finishes, download the **`aidlc-usage-report`** artifact from the run's summary page.
3. Check that:
   - everyone on the roster appears;
   - no one is `unmatched` (if someone is, add their email to the roster);
   - the run log shows no `warning:` lines.

### Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `No aidlc/spaces directory found` | `aidlc/` isn't committed on `main`, or `path` points at the wrong folder. |
| Everything is `(unattributed)`, or a "shallow clone" warning | The checkout is missing `fetch-depth: 0`. |
| A teammate shows as `unmatched` | They commit with an email that isn't in the roster. Add it. |
| A teammate shows as `no_usage_recorded` but uses AI-DLC | Their work isn't merged to `main` yet, or their `audit/` files weren't committed. |
| Usage cells are blank | The intent hasn't completed a stage yet, it was run outside Claude Code, or AI-DLC usage tracking is disabled (`AIDLC_DISABLE_USAGE_TRACKING`). |

### What developers do from now on

- **One intent per story.** Run AI-DLC through Claude Code, with one intent per user story, on your own
  branch and in your own clone.
- **Commit `aidlc/` with your story.** Include the `audit/*.md` files, and **push at the end of every
  working session**.
- **Merge to `main`.** Work is counted once its PR is merged.
- **Finish the AI-DLC workflow,** so the intent's full cost is recorded.
- **Commit with your work email,** or make sure the roster lists the address you use.
- **Leave audit files alone.** Don't edit, delete or rewrite them, and don't commit another developer's.
  Never paste their contents anywhere public: they contain prompts.

## Action inputs and outputs

| Input | Default | Description |
|---|---|---|
| `path` | `.` | Checked-out AI-DLC repository. |
| `since` | `30d` | Start of the activity period: `<n>d` or an ISO date. |
| `roster` | `<path>/.aidlc-usage/team.json` if present | Team roster JSON. |
| `output-dir` | `$RUNNER_TEMP/aidlc-usage-report` | Report directory, outside the checkout. |
| `upload-artifact` | `true` | Upload the reports as an artifact. |
| `artifact-name` | `aidlc-usage-report` | Artifact name. |
| `retention-days` | `90` | Artifact retention, subject to repository and organisation limits. |

Output: `report-dir`, the directory holding the reports.

## Reports

All costs are AI-DLC's **estimates at list price**, not your bill. Missing values are **blank, never 0**.

### `developer-usage.csv`: one row per person

- **`roster_status`** is one of four values:
  - `active`: AI-DLC activity during the period;
  - `inactive_in_period`: activity only before the period;
  - `no_usage_recorded`: on the roster, with no activity in the merged records on `main`;
  - `unmatched`: an author who isn't on the roster.

  `no_usage_recorded` means *nothing was found on `main`*. It doesn't prove someone never used AI-DLC.
- **Activity for the period:** `active_days` and `sessions` (`SESSION_STARTED` and `SESSION_RESUMED` events).
  `first_activity` and `last_activity` cover all time.
- **Lifetime totals:** `intents_participated_lifetime`, `intents_completed_lifetime`, and the `lifetime_*` token and cost columns.

### `implementation-usage.csv`: one row per intent

- **Identity and status:** `intent_id`, `slug`, `status` (`in-flight` / `complete` / `archived` / `parked`) and `contributors`.
- **Timing:** `started_at`, `completed_at` and `elapsed_hours`. Elapsed time is wall clock, not effort.
- **Usage:** input, output, cache-read and cache-write tokens; `est_cost_usd_list_price`; `cost_has_unpriced`.
- **`usage_partial`** is true while the intent is in progress or was reopened after completing.
- **`unstaged_tokens`** is usage recorded outside any stage.
- **`flags`** can contain:
  - `unregistered`: missing from `intents.json`;
  - `reopened`;
  - `usage_decreased`: a local ledger was reset; the latest value is used;
  - `discrepancy`.

### `implementation-developer-usage.csv`: one row per intent and developer

Each intent's rows sum exactly to its row in `implementation-usage.csv`. Usage in an audit file with more
than one author goes to an `(ambiguous)` row, and usage in a file with no attributable author goes to
`(unattributed)`. Neither is ever guessed.

### `usage-report.json`

This is the normalised source of all three CSVs, for dashboards or other integrations (`schema_version: 1`).

## Run it locally

You need Node.js 22.18 or later. There's no `npm install` and no build step:

```sh
git clone https://github.com/sourcefuse/aidlc-usage-tracker
node aidlc-usage-tracker/src/cli.ts --repo path/to/your-aidlc-repo --since 30d --out ./report
```

## Limitations

1. **Only merged work counts.** Usage appears after the PR reaches `main`. Push `aidlc/` with every story.
2. **Usage arrives when a stage or workflow completes.** Work in progress shows activity but partial or blank usage.
3. **Shared intents can be partial.** A contributor who didn't complete the workflow contributes only their
   completed-stage snapshots.
4. **Ledger resets are not reconstructed.** The latest snapshot is used and the intent is flagged `usage_decreased`.
5. **Identity is the git author.** It is self-declared. A squash merge credits the PR author, and
   `Co-authored-by` trailers are ignored.
6. **Only the Claude Code harness writes usage in AI-DLC.** Other harnesses show activity with blank usage.
7. **Usage is lifetime only.** It isn't split by period.
8. **Claude Code used outside AI-DLC is not detected.**
9. **Worktree/swarm audit merges (`AUDIT_MERGED`) are untested.** Latest-snapshot accounting is
   duplicate-safe, but no real data with them has been verified.

## Compatibility

- Tested on audit records written by **AWS AI-DLC v2.10.0**.
- The format was checked against the **v2.11.1** source.

If a future AI-DLC release changes the audit format, the affected usage cells stay blank (never 0)
rather than failing silently. Please open an issue.

## Security and privacy

The reporter treats the repository it reads as untrusted input.

- **Allow-listed reads only.** It reads only `aidlc/spaces/<space>/intents/intents.json`,
  `…/intents/audit/*.md`, `…/intents/<intent>/audit/*.md` and `.aidlc-usage/team.json`.
- **No symlinks or odd names.** Symbolic links are never followed, at any level. Hidden or unusual
  file names are ignored.
- **Size and count limits.** File sizes and counts are capped.
- **Free text is never read.** Only an allow-list of fields is parsed out of each audit block.
- **Safe git calls.** git runs without a shell, with fixed arguments, a literal pathspec, and no pager or
  diff drivers.
- **Safe writes.** Output goes only to the four report files. They are created through `O_NOFOLLOW`
  with owner-only permissions, and never inside `aidlc/`.
- **Runtime sandbox.** In the GitHub Action, Node's
  [permission model](https://nodejs.org/api/permissions.html) enforces the same boundary at runtime:
  the process can read only its own source, the repository and the roster, and can write only to the
  output directory.

See [SECURITY.md](SECURITY.md). Reports include developer names and emails from git history, and are
visible to anyone who can read the repository's Actions artifacts. Treat your AI-DLC repository as
confidential: its committed audit records contain prompts.

## Contributing and releases

See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Code layout:** the source lives in small modules under `src/`:
  - `workspace.ts`: sandboxed reads;
  - `audit.ts`: parsing;
  - `accounting.ts`: the accounting rules;
  - `git.ts`: attribution;
  - `report.ts`: assembling the report;
  - `output.ts`: CSV, JSON and safe writes;
  - `cli.ts`: the command line;
  - `index.ts`: the public API.
- **Commit checks:** husky runs commitlint on commit messages locally, and CI checks the PR title with `amannn/action-semantic-pull-request`.
- **Merging:** PRs are squash-merged with Conventional Commit titles.
- **Releasing:** releases are tag-only (`vX.Y.Z` plus a floating `v0`) and created from a manual workflow
  with [release-it](https://github.com/release-it/release-it). Release notes are on the
  [Releases](https://github.com/sourcefuse/aidlc-usage-tracker/releases) page.

## Acknowledgements

This project builds on [AWS AI-DLC (AI-Driven Development Life Cycle)](https://github.com/awslabs/aidlc-workflows)
by Amazon Web Services. All usage accounting (token counting, pricing and audit records) is done by
AI-DLC itself; this tracker only reads and aggregates what AI-DLC records. Thanks to the AI-DLC
maintainers and contributors.

AWS and AI-DLC are trademarks of Amazon.com, Inc. or its affiliates. This is an independent community
project by SourceFuse. It is not affiliated with, sponsored by or endorsed by Amazon Web Services.

## License

[MIT](LICENSE) © 2026 SourceFuse
