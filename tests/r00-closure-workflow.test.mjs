// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "r00-closure.yml");

test("R00 closure validates only a committed record on exact protected main", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(source, /pull_request_target|schedule:|\bpush:/);
  assert.match(source, /expected_main_sha:[\s\S]*required: true/);
  assert.match(source, /expected_record_sha256:[\s\S]*required: true/);
  assert.match(source, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(source, /test "\$GITHUB_SHA" = "\$TSFG_EXPECTED_MAIN_SHA"/);
  assert.match(source, /git rev-parse FETCH_HEAD/);
  assert.match(source, /git show "HEAD:\$TSFG_RECORD_PATH"/);
  assert.match(source, /node tools\/manifest-ci\.mjs validate-r00-closure/);
  assert.match(source, /--validation-run-id "\$GITHUB_RUN_ID" --validation-sha "\$GITHUB_SHA"/);
});

test("R00 closure is API-backed, read-only, retained, and action-pinned", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^permissions:\n  actions: read\n  contents: read$/m);
  assert.match(source, /^    environment: protected-release-environment$/m);
  assert.match(source, /test -n "\$TSFG_GOVERNANCE_TOKEN"/);
  assert.match(source, /GH_TOKEN: \$\{\{ secrets\.TSFG_RELEASE_GOVERNANCE_TOKEN \}\}/);
  assert.match(source, /name: r00-closure-\$\{\{ inputs\.product_version \}\}-\$\{\{ inputs\.expected_main_sha \}\}/);
  assert.match(source, /retention-days: 90/);
  const references = [...source.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) assert.match(reference, /@[0-9a-f]{40}$/);
});
