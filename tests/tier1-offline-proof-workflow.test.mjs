// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "tier1-offline-proof.yml");

test("Tier 1 Offline Proof consumes trusted candidate and controller evidence fail closed", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^on:\n  workflow_dispatch:\s*$/m);
  for (const input of ["candidate_run_id", "candidate_id", "proof_run_id", "proof_artifact"]) {
    assert.match(source, new RegExp(`^      ${input}:\\n        required: true$`, "m"));
  }
  assert.match(source, /^permissions:\n  actions: read\n  contents: read$/m);
  assert.doesNotMatch(source, /pull_request_target|\bsecrets\b/i);
  assert.match(source, /runs-on: ubuntu-24\.04/);
  for (const reference of [...source.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1])) {
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/);
  }
  assert.match(source, /pattern: manifest-candidate-evidence-\*/);
  assert.match(source, /pattern: manifest-verdict-\*/);
  assert.match(source, /run-id: \$\{\{ inputs\.candidate_run_id \}\}/);
  assert.match(source, /name: \$\{\{ inputs\.proof_artifact \}\}/);
  assert.match(source, /run-id: \$\{\{ inputs\.proof_run_id \}\}/);
  assert.match(source, /node tools\/manifest-ci\.mjs offline-proof/);
  assert.match(source, /--candidate-evidence \.ci\/candidate-evidence/);
  assert.match(source, /--verified-verdict \.ci\/verified-verdict\/manifest-verdict\.json/);
  assert.match(source, /^          TSFG_CANDIDATE_ID: \$\{\{ inputs\.candidate_id \}\}$/m);
  assert.match(source, /--candidate-id "\$TSFG_CANDIDATE_ID"/);
  assert.doesNotMatch(source, /run:[\s\S]*--candidate-id[^\n]*\$\{\{/);
  assert.match(source, /--proof-evidence \.ci\/proof-evidence/);
  assert.match(source, /retention-days: 90/);
  assert.doesNotMatch(source, /promotionState|Promotable|Stable/);
});
