// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestCi = path.join(repositoryRoot, "tools", "manifest-ci.mjs");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "release-owner.yml");

function invoke(arguments_, cwd) {
  return spawnSync(process.execPath, [manifestCi, ...arguments_], { cwd, encoding: "utf8" });
}

function git(repository, ...arguments_) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-release-owner-context-"));
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(repository, ".github", "workflows", "release-owner.yml"), await readFile(workflowPath));
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Release Context Fixture");
  git(repository, "config", "user.email", "release-context@example.invalid");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "trusted release workflow");
  const sha = git(repository, "rev-parse", "HEAD");
  const run = {
    actor: { login: "release-owner", type: "User" },
    event: "workflow_dispatch",
    head_branch: "main",
    head_repository: { full_name: "xuelongling/manifests" },
    head_sha: sha,
    id: 123,
    path: ".github/workflows/release-owner.yml@main",
    repository: { full_name: "xuelongling/manifests" },
    triggering_actor: { login: "release-owner", type: "User" },
  };
  const reviews = [{
    environments: [{ name: "protected-release-environment" }],
    state: "approved",
    user: { login: "second-maintainer", type: "User" },
  }];
  const runPath = path.join(root, "run.json");
  const reviewsPath = path.join(root, "reviews.json");
  const output = path.join(root, "authorization.json");
  await writeJson(runPath, run);
  await writeJson(reviewsPath, reviews);
  return { output, repository, reviews, reviewsPath, root, run, runPath, sha };
}

function argumentsFor(value, overrides = {}) {
  return [
    "release-owner-context",
    "--repository", value.repository,
    "--run", value.runPath,
    "--reviews", value.reviewsPath,
    "--run-id", overrides.runId ?? "123",
    "--operation", overrides.operation ?? "record-release-evidence",
    "--actor", overrides.actor ?? "release-owner",
    "--triggering-actor", overrides.triggeringActor ?? "release-owner",
    "--ref", overrides.ref ?? "refs/heads/main",
    "--sha", overrides.sha ?? value.sha,
    "--out", value.output,
  ];
}

test("release-owner-context records API-backed protected-main human authorization", async () => {
  const value = await fixture();
  try {
    const result = invoke(argumentsFor(value), value.repository);
    assert.equal(result.status, 0, result.stderr);
    const authorization = JSON.parse(await readFile(value.output));
    assert.deepEqual(authorization.actor, { login: "release-owner", type: "User" });
    assert.equal(authorization.environment, "protected-release-environment");
    assert.deepEqual(authorization.environmentReviews, [{ login: "second-maintainer", type: "User" }]);
    assert.equal(authorization.operation, "record-release-evidence");
    assert.equal(authorization.workflow.commit, value.sha);
    assert.equal(authorization.workflow.path, ".github/workflows/release-owner.yml");
    assert.equal(authorization.workflow.ref, "refs/heads/main");
    assert.equal(authorization.workflow.runId, "123");
    assert.match(authorization.runEvidenceSha256, /^sha256:[0-9a-f]{64}$/);
    assert.match(authorization.reviewEvidenceSha256, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("release-owner-context permits the documented single-maintainer zero-review stage", async () => {
  const value = await fixture();
  try {
    await writeJson(value.reviewsPath, []);
    const result = invoke(argumentsFor(value), value.repository);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(value.output)).environmentReviews, []);
  } finally {
    await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("release-owner-context fails closed outside trusted main and a same human actor", async (t) => {
  const cases = [
    ["non-main ref", {}, { ref: "refs/heads/release" }],
    ["untrusted workflow", { path: ".github/workflows/manifest-pr.yml" }, {}],
    ["non-main workflow run", { head_branch: "release" }, {}],
    ["different triggering human", { triggering_actor: { login: "other-owner", type: "User" } }, { triggeringActor: "other-owner" }],
    ["bot actor", { actor: { login: "release-bot[bot]", type: "Bot" }, triggering_actor: { login: "release-bot[bot]", type: "Bot" } }, { actor: "release-bot[bot]", triggeringActor: "release-bot[bot]" }],
  ];
  for (const [name, runChanges, overrides] of cases) {
    await t.test(name, async () => {
      const value = await fixture();
      try {
        await writeJson(value.runPath, { ...value.run, ...runChanges });
        const result = invoke(argumentsFor(value, overrides), value.repository);
        assert.equal(result.status, 1, `${name} unexpectedly passed`);
        assert.match(result.stderr, /human|protected manifest main|workflow_dispatch/i);
        await assert.rejects(readFile(value.output));
      } finally {
        await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});

test("release-owner-context rejects a protected-environment rejection or bot review", async (t) => {
  const cases = [
    ["rejected", { state: "rejected", user: { login: "release-owner", type: "User" } }, /rejected/i],
    ["bot", { state: "approved", user: { login: "review-bot[bot]", type: "Bot" } }, /human GitHub user/i],
  ];
  for (const [name, review, message] of cases) {
    await t.test(name, async () => {
      const value = await fixture();
      try {
        await writeJson(value.reviewsPath, [{
          environments: [{ name: "protected-release-environment" }], ...review,
        }]);
        const result = invoke(argumentsFor(value), value.repository);
        assert.equal(result.status, 1, `${name} unexpectedly passed`);
        assert.match(result.stderr, message);
      } finally {
        await rm(value.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});
