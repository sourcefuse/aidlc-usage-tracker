// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/**
 * Conventional Commits for local commits, enforced by the husky commit-msg hook.
 * PR titles are checked in CI by .github/workflows/pr-title.yml; keep `type-enum` in sync.
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    "type-enum": [2, "always", ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"]],
  },
};
