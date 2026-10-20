# Contributing

Thanks for helping. This project is deliberately small, so please open an issue to discuss anything
larger than a bug fix before you start.

## Development

Requirements: Node.js 22.18 or later (`.nvmrc` pins 24), git.

```sh
npm ci --ignore-scripts   # never run third-party install scripts
npm run prepare           # installs the husky git hooks (commit-msg: commitlint, pre-commit: npm run check)
npm run check             # typecheck + lint + tests
node tests/make-sample-repo.ts /tmp/sample
node src/cli.ts --repo /tmp/sample --since 2026-01-01 --out /tmp/report
```

Source layout:

| Module | Responsibility |
|---|---|
| `src/workspace.ts` | The **only** code that reads the repository: allow-listed paths, no symlinks, size and count caps |
| `src/audit.ts` | Parses audit blocks; reads allow-listed fields only |
| `src/accounting.ts` | Latest-snapshot accounting per audit file |
| `src/git.ts` | Read-only, shell-free `git log` for attribution |
| `src/identity.ts` | Identity normalisation and roster validation |
| `src/report.ts` | Assembles intents, developers and audit-file rows |
| `src/output.ts` | CSV/JSON rendering and safe writes |
| `src/cli.ts`, `src/index.ts` | CLI entry point and public API |

Every `.ts` file starts with the SourceFuse copyright and `SPDX-License-Identifier: MIT` header. A test enforces this.

There is no build step. Node runs the TypeScript directly through type stripping, so use only
[erasable syntax](https://www.typescriptlang.org/tsconfig/#erasableSyntaxOnly): no `enum`, `namespace`
or constructor parameter properties. `npm run typecheck` enforces this.

The reporter has **zero runtime dependencies**. Please keep it that way.

## Pull requests

- Commit messages are checked by commitlint in the `commit-msg` hook, and `npm run check` runs before each commit.
- PRs are **squash-merged**. The **PR title** becomes the commit on `main`, must follow
  [Conventional Commits](https://www.conventionalcommits.org/), and is checked in CI:
  - `fix: …` produces a patch release;
  - `feat: …` produces a minor release;
  - `feat!: …`, or a `BREAKING CHANGE:` footer, produces a major release;
  - `docs:`, `test:`, `ci:`, `build:`, `chore:` and `refactor:` don't trigger a release.
- CI must pass. That covers lint, typecheck, tests on Node 22 and 24, the Bun run, the action smoke
  test, zizmor, CodeQL and dependency review.

## Test data

**Never commit real audit records.** They contain prompts, client details, names and emails. Build
scenarios with the helpers in `tests/helpers.ts`. The single real-format fixture in
`tests/fixtures/real-format/` was sanitised: free text replaced with canaries, numbers rescaled,
dates shifted and identifiers replaced.

## Releasing (maintainers)

Run the **Release** workflow from `main`. Leave *dry-run* on first, check the proposed version and notes,
then run it again with *dry-run* off. release-it:

1. creates the `vX.Y.Z` tag;
2. publishes a GitHub Release with notes generated from the PR titles;
3. moves the floating major tag (for example `v0`).

Nothing is committed to `main`.
