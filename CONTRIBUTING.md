# Contributing

Thanks for helping. This project is deliberately small, so please open an issue to discuss anything
larger than a bug fix before you start.

## Development

Requirements: Node.js 22.18 or later (`.nvmrc` pins 24), git.

```sh
npm ci --ignore-scripts
npm run check          # typecheck + lint + tests
node tests/make-sample-repo.ts /tmp/sample
node src/aidlc-usage-report.ts --repo /tmp/sample --since 2026-01-01 --out /tmp/report
```

There is no build step. Node runs the TypeScript directly through type stripping, so use only
[erasable syntax](https://www.typescriptlang.org/tsconfig/#erasableSyntaxOnly): no `enum`, `namespace`
or constructor parameter properties. `npm run typecheck` enforces this.

The reporter has **zero runtime dependencies**. Please keep it that way.

## Pull requests

- PRs are **squash-merged**. The **PR title** becomes the commit on `main`, must follow
  [Conventional Commits](https://www.conventionalcommits.org/), and is checked in CI:
  - `fix: …` produces a patch release;
  - `feat: …` produces a minor release;
  - `feat!: …`, or a `BREAKING CHANGE:` footer, produces a major release;
  - `docs:`, `test:`, `ci:`, `build:`, `chore:` and `refactor:` don't trigger a release.
- Individual commits on your branch don't need to follow any convention.
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
