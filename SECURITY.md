# Security policy

## Supported versions

Only the latest release of the current major version (today: `v0`) receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue. Report privately through
[GitHub private vulnerability reporting](https://github.com/sourcefuse/aidlc-usage-tracker/security/advisories/new).

Include what you found, how to reproduce it, and its impact. We aim to acknowledge reports within
3 business days and to agree a disclosure date with you once a fix is ready.

## What this project does with your data

- It only **reads** the repository it runs in. It never writes to it, pushes, or calls any network service.
- It reads an allow-list of audit fields (event names, timestamps, stage names and usage numbers).
  Free-text fields, which can contain prompts or client requirements, are never read into the output.
- Reports contain developer names and email addresses taken from git history. They are uploaded only
  as workflow artifacts of *your* repository, visible to whoever can read that repository's Actions runs.

## Hardening in this repository

- Every third-party GitHub Action is pinned to a full commit SHA and kept current by Dependabot.
- Workflows default to `permissions: {}` and grant the minimum per job. They are audited by
  [zizmor](https://docs.zizmor.sh/), CodeQL and OpenSSF Scorecard.
- Releases are tag-only, created by a manual workflow with the short-lived `GITHUB_TOKEN`. No
  long-lived release credentials exist. Semver tags are protected from being moved or deleted.
