// Copyright (c) 2026 SourceFuse
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { AIDLC_COMPATIBILITY } from "../src/index.ts";

it("the README AI-DLC badge and compatibility section match the versions the code reports", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const { records_tested, format_checked } = AIDLC_COMPATIBILITY;
  const badge = `AWS%20AI--DLC-${records_tested}%20%E2%80%93%20${format_checked}-FF9900`;
  assert.ok(readme.includes(badge), `README badge should read ${records_tested} – ${format_checked}`);
  assert.ok(readme.includes(`**AWS AI-DLC v${records_tested}**`));
  assert.ok(readme.includes(`**v${format_checked}**`));
});
