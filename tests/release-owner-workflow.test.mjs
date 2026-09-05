// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "release-owner.yml");

test("Release Owner workflow is manual, main-bound, environment-gated, and human-only", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(source, /pull_request_target|schedule:|\bpush:/);
  assert.match(source, /^    environment: protected-release-environment$/m);
  assert.match(source, /test "\$GITHUB_REF" = refs\/heads\/main/);
  assert.match(source, /test "\$GITHUB_REPOSITORY" = xuelongling\/manifests/);
  assert.match(source, /test "\$TSFG_ACTOR" = "\$TSFG_TRIGGERING_ACTOR"/);
  assert.match(source, /test -n "\$TSFG_RELEASE_OWNER_TOKEN"/);
  assert.match(source, /\*'\[bot\]'\|github-actions\) exit 1/);
  assert.match(source, /git rev-parse FETCH_HEAD/);
  assert.match(source, /release-owner-context/);
  assert.match(source, /actions\/runs\/\$GITHUB_RUN_ID\$endpoint/);
  assert.match(source, /\/approvals/);
});

test("Release Owner workflow exposes every transaction only behind authorization", async () => {
  const source = await readFile(workflowPath, "utf8");
  for (const operation of ["record-release-evidence", "promote-stable", "finalize-release", "rollback"]) {
    assert.match(source, new RegExp(`node tools/manifest-ci\\.mjs ${operation}[\\s\\S]*?--authorization`));
  }
  assert.doesNotMatch(source, /promote-stable[^\n]*--actor/);
  assert.doesNotMatch(source, /owner-approval\.json|decision[^\n]*approved|source[^\n]*protected-release-environment/i);
});

test("recording Release Evidence consumes the real trusted Offline Proof unchanged", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /name: tier1-offline-proof-\$\{\{ inputs\.candidate_id \}\}/);
  assert.match(source, /run-id: \$\{\{ inputs\.offline_proof_run_id \}\}/);
  assert.match(source, /\.github\/workflows\/tier1-offline-proof\.yml/);
  assert.match(source, /run\.conclusion !== "success"/);
  assert.match(source, /proof\.status !== "success"/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /cmp --silent[\s\S]*offline-proof\.json[\s\S]*input\/offline-proof\.json/);
  assert.match(source, /git ls-remote --tags https:\/\/github\.com\/xuelongling\/tsfg\.git/);
});

test("operation input artifacts come only from a successful trusted-main human run", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /name: Authenticate the operation input artifact run/);
  assert.match(source, /actions\/runs\/\$TSFG_INPUT_RUN_ID/);
  assert.match(source, /run\.event !== "workflow_dispatch"/);
  assert.match(source, /run\.head_branch !== "main"/);
  assert.match(source, /run\.head_repository\?\.full_name !== "xuelongling\/manifests"/);
  assert.match(source, /!human\(run\.actor\) \|\| !human\(run\.triggering_actor\)/);
  assert.match(source, /input-run-sha\.txt[\s\S]*git merge-base --is-ancestor/);
});

test("Release Owner workflow prepares a PR and never pushes main, tags, or releases", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /git push origin "HEAD:refs\/heads\/\$branch"/);
  assert.match(source, /"https:\/\/api\.github\.com\/repos\/\$GITHUB_REPOSITORY\/pulls"/);
  assert.doesNotMatch(source, /git push[^\n]*(?:refs\/heads\/main|\bmain\b)/);
  assert.doesNotMatch(source, /\bgit tag\b|\/git\/refs\/tags|\/releases(?:"|'|\s)/);
});

test("Release Owner workflow pins actions and keeps the default token read-only", async () => {
  const source = await readFile(workflowPath, "utf8");
  assert.match(source, /^permissions:\n  actions: read\n  contents: read$/m);
  assert.match(source, /token: \$\{\{ secrets\.TSFG_RELEASE_OWNER_TOKEN \}\}/);
  assert.match(source, /GH_TOKEN: \$\{\{ secrets\.TSFG_RELEASE_OWNER_TOKEN \}\}/);
  const references = [...source.matchAll(/uses:\s*([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) assert.match(reference, /@[0-9a-f]{40}$/);
});
