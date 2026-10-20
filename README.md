# AI-DLC Usage Tracker

[![CI](https://github.com/sourcefuse/aidlc-usage-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/sourcefuse/aidlc-usage-tracker/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/sourcefuse/aidlc-usage-tracker/badge)](https://scorecard.dev/viewer/?uri=github.com/sourcefuse/aidlc-usage-tracker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Team-level **adoption** and **token/cost** reporting for [AWS AI-DLC](https://github.com/awslabs/aidlc-workflows),
built entirely from the audit records AI-DLC already commits to your repository.

> **Status: experimental (v0).** The output format may change before v1.

The tracker answers two questions:

1. **Who on the team is using AI-DLC, and who isn't?**
2. **What did each implementation (AI-DLC intent) cost in tokens and estimated USD?**

There is nothing to install on developer machines: no hooks, agents, databases or external services.
A GitHub Action reads `main` on a schedule and uploads CSV and JSON reports as a workflow artifact.

## How it works

```text
Developer runs AI-DLC ─► commits aidlc/ (incl. audit/*.md) on a branch ─► PR ─► merged to main
                                                                                   │
Scheduled workflow in the same repo ─► this action reads main ─► reports as an artifact
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

## Quick start

1. Make sure your AI-DLC repository commits `aidlc/`, including the `audit/` folders, as AI-DLC's own
   generated `.gitignore` intends, and that stories are merged to `main` through PRs.
2. Copy [`templates/aidlc-usage-report.yml`](templates/aidlc-usage-report.yml) to
   `.github/workflows/aidlc-usage-report.yml` in that repository.
3. Optionally add a roster at `.aidlc-usage/team.json` (see [`examples/team.json`](examples/team.json)), so that
   team members with no recorded usage are listed too.
4. Run the workflow, either manually or on its daily schedule, and download the `aidlc-usage-report` artifact.

The core of the workflow:

```yaml
- uses: actions/checkout@<sha>
  with:
    fetch-depth: 0 # needed for attribution
    persist-credentials: false
- uses: sourcefuse/aidlc-usage-tracker@v0 # or pin a full commit SHA
  with:
    since: 30d
```

### Inputs

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

## Roster

```json
{
  "members": [
    { "name": "Ada Lovelace", "github": "ada-l", "emails": ["ada@example.com", "ada.personal@example.org"] }
  ]
}
```

Members are matched on any listed email, or on their GitHub login when commits use a
`@users.noreply.github.com` address. Authors who match nobody are reported as `unmatched`. Add their
address to the right member.

## Run it locally

You need Node.js 22.18 or later. There's no `npm install` and no build step:

```sh
git clone https://github.com/sourcefuse/aidlc-usage-tracker
node aidlc-usage-tracker/src/aidlc-usage-report.ts --repo path/to/your-aidlc-repo --since 30d --out ./report
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

See [SECURITY.md](SECURITY.md). Reports include developer names and emails from git history, and are
visible to anyone who can read the repository's Actions artifacts. Treat your AI-DLC repository as
confidential: its committed audit records contain prompts.

## Contributing and releases

See [CONTRIBUTING.md](CONTRIBUTING.md).
- **Merging:** PRs are squash-merged with Conventional Commit titles.
- **Releasing:** releases are tag-only (`vX.Y.Z` plus a floating `v0`) and created from a manual workflow
  with [release-it](https://github.com/release-it/release-it). Release notes are on the
  [Releases](https://github.com/sourcefuse/aidlc-usage-tracker/releases) page.

## License

[MIT](LICENSE) © SourceFuse
