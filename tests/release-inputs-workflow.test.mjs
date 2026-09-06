// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "release-inputs.yml");

test("provisional release inputs are exact human-provided protected-main bytes", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(source, /pull_request_target|schedule:|\bpush:/);
  assert.match(source, /^    environment: protected-release-environment$/m);
  assert.match(source, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(source, /test "\$TSFG_ACTOR" = "\$TSFG_TRIGGERING_ACTOR"/);
  assert.match(source, /owner_approval_base64:[\s\S]*required: true/);
  assert.match(source, /owner_approval_sha256:[\s\S]*required: true/);
  assert.match(source, /printf '%s' "\$TSFG_OWNER_APPROVAL" \| base64 --decode > .*owner-approval\.json/);
  assert.match(source, /--owner-approval-sha256 "\$TSFG_OWNER_APPROVAL_SHA256"/);
  assert.match(source, /--candidate-id "\$TSFG_CANDIDATE_ID"/);
  assert.doesNotMatch(source, /decision["':\s]+approved|actor["':\s]+\$?GITHUB_ACTOR/i);
});

test("provisional release inputs authenticate runs, artifacts, tag, and output retention", async () => {
  const source = await readFile(workflowPath, "utf8");
  for (const endpoint of [
    "actions/runs/$GITHUB_RUN_ID",
    "actions/runs/$GITHUB_RUN_ID/approvals",
    "actions/runs/$TSFG_CANDIDATE_RUN_ID",
    "actions/runs/$TSFG_CANDIDATE_RUN_ID/artifacts?per_page=100",
    "actions/runs/$TSFG_OFFLINE_PROOF_RUN_ID",
    "actions/runs/$TSFG_OFFLINE_PROOF_RUN_ID/artifacts?per_page=100",
  ]) assert.ok(source.includes(endpoint), endpoint);
  assert.match(source, /run-id: \$\{\{ inputs\.candidate_run_id \}\}/);
  assert.match(source, /run-id: \$\{\{ inputs\.offline_proof_run_id \}\}/);
  assert.match(source, /git ls-remote --tags https:\/\/github\.com\/xuelongling\/tsfg\.git/);
  assert.match(source, /node tools\/manifest-ci\.mjs prepare-release-bundle/);
  assert.match(source, /name: release-provisional-inputs-\$\{\{ inputs\.candidate_id \}\}/);
  assert.match(source, /retention-days: 90/);
});

test("provisional release workflow is read-only and pins all actions", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^permissions:\n  actions: read\n  contents: read$/m);
  const references = [...source.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) assert.match(reference, /@[0-9a-f]{40}$/);
});
