// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

/**
 * Conventional Commits, enforced locally by the husky commit-msg hook and in CI on the PR
 * title (PRs are squash-merged, so the title becomes the commit on main).
 * @type {import("@commitlint/types").UserConfig}
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    "type-enum": [2, "always", ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"]],
  },
};
