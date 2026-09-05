// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestCi = path.join(repositoryRoot, "tools", "manifest-ci.mjs");
const manifestRepositoryUrl = "https://github.com/xuelongling/manifests.git";
const productRepositoryUrl = "https://github.com/xuelongling/tsfg.git";

function invoke(arguments_, cwd) {
  return spawnSync(process.execPath, [manifestCi, ...arguments_], { cwd, encoding: "utf8" });
}

function runGit(repository, ...arguments_) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function byteDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

async function writeAuthorization(root, operation, actor = "release-owner") {
  const filePath = path.join(root, `authorization-${operation}-${Math.random().toString(16).slice(2)}.json`);
  await writeJson(filePath, {
    actor: { login: actor, type: "User" },
    environment: "protected-release-environment",
    environmentReviews: [],
    operation,
    repository: "xuelongling/manifests",
    reviewEvidenceSha256: byteDigest("reviews"),
    runEvidenceSha256: byteDigest("run"),
    schemaVersion: "1",
    source: "github-actions",
    workflow: {
      commit: runGit(path.join(root, "repository"), "rev-parse", "HEAD"), path: ".github/workflows/release-owner.yml",
      ref: "refs/heads/main", runId: "123",
    },
  });
  return filePath;
}

function manifest(productRevision, agentRevision) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest>
  <remote name="github-xuelongling" fetch="https://github.com/xuelongling/" />
  <project name="tsfg.git" path="tsfg" remote="github-xuelongling" revision="${productRevision}" upstream="refs/heads/main" />
  <project name=".agents.git" path=".agents" remote="github-xuelongling" revision="${agentRevision}" upstream="refs/heads/main">
    <linkfile src="AGENTS.md" dest="AGENTS.md" />
    <linkfile src="codex/config.toml" dest=".codex/config.toml" />
    <linkfile src="codex/hooks.json" dest=".codex/hooks.json" />
  </project>
</manifest>
`;
}

async function initializeRepository(root) {
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, "bootstrap"), { recursive: true });
  await writeFile(path.join(repository, "bootstrap", "r00.xml"), manifest("1".repeat(40), "2".repeat(40)));
  runGit(repository, "init", "-b", "main");
  runGit(repository, "config", "user.name", "Release Fixture");
  runGit(repository, "config", "user.email", "release-fixture@example.invalid");
  runGit(repository, "add", ".");
  runGit(repository, "commit", "-m", "bootstrap");
  return repository;
}

function commitAll(repository, message) {
  runGit(repository, "add", "-A");
  runGit(repository, "commit", "-m", message);
  return runGit(repository, "rev-parse", "HEAD");
}

async function writeBundle(root, {
  version, productRevision, agentRevision, manifestRevision, mutate = () => {}, owner = "release-owner",
}) {
  const bundleRoot = path.join(root, `bundle-${version}-${Math.random().toString(16).slice(2)}`);
  const candidateId = createHash("sha256").update(`candidate/${version}`).digest("hex");
  const candidate = {
    agentRevision,
    candidateOverlayDigest: byteDigest(`overlay/${version}`),
    id: candidateId,
    manifest: `snapshots/tsfg-v${version}.xml`,
    manifestRepository: manifestRepositoryUrl,
    manifestRevision,
    productRevision,
    resolvedManifestDigest: `sha256:${candidateId}`,
  };
  const files = {
    "offline-proof.json": {
      builds: [], candidate, candidateIds: [candidateId], candidateRun: {}, controllerRun: {},
      evidenceDigest: byteDigest(`offline/${version}`), proof: "Offline Proof", requiredEvidence: {},
      schemaVersion: "1", status: "success",
    },
    "owner-approval.json": {
      action: "promote-stable", actor: { login: owner, type: "User" }, additionalApprovals: [], candidateId,
      decision: "approved", productVersion: version, role: "Release Owner", schemaVersion: "1",
      source: "protected-release-environment",
    },
    "product-tag.json": {
      name: `tsfg-v${version}`, repository: productRepositoryUrl, schemaVersion: "1",
      status: "fixed", targetRevision: productRevision,
    },
    "release-materials.json": {
      artifacts: ["linux-x86_64-gnu", "windows-x86_64-msvc"].map((target) => ({
        archiveSha256: byteDigest(`${version}/${target}/archive`),
        artifactManifestSha256: byteDigest(`${version}/${target}/artifact-manifest`),
        buildIdentityDigest: byteDigest(`${version}/${target}/identity`),
        checksumsSha256: byteDigest(`${version}/${target}/checksums`),
        target,
      })),
      candidateId, releaseStatus: "non-stable", schemaVersion: "1", status: "fixed",
    },
    "verified-candidate.json": {
      candidateIds: [candidateId], evidenceDigest: byteDigest(`candidate-evidence/${version}`),
      evidenceRetentionDays: "90", promotionState: "Verified Candidate", requiredEvidence: {}, schemaVersion: "1",
    },
    "version-readiness.json": { candidateId, productVersion: version, schemaVersion: "1", status: "ready" },
  };
  mutate(files);
  for (const [name, value] of Object.entries(files)) await writeJson(path.join(bundleRoot, name), value);
  const entries = await Promise.all((await readdir(bundleRoot)).sort().map(async (name) => ({
    path: name,
    sha256: byteDigest(await readFile(path.join(bundleRoot, name))),
  })));
  await writeJson(path.join(bundleRoot, "bundle.json"), {
    contentAddress: digest({ entries, schemaVersion: "1" }), entries, schemaVersion: "1",
  });
  return { bundleRoot, candidateId };
}

async function makePromotable(root, repository, version, productRevision, agentRevision, options = {}) {
  const snapshot = manifest(productRevision, agentRevision);
  await mkdir(path.join(repository, "snapshots"), { recursive: true });
  await writeFile(path.join(repository, "snapshots", `tsfg-v${version}.xml`), snapshot);
  const snapshotCommit = commitAll(repository, `snapshot ${version}`);
  const bundle = await writeBundle(root, { version, productRevision, agentRevision, manifestRevision: snapshotCommit, ...options });
  const authorization = await writeAuthorization(root, "record-release-evidence", options.owner ?? "release-owner");
  const result = invoke([
    "record-release-evidence", "--repository", repository, "--version", version, "--bundle", bundle.bundleRoot,
    "--authorization", authorization,
  ], repository);
  assert.equal(result.status, 0, result.stderr);
  const evidenceCommit = commitAll(repository, `evidence ${version}`);
  return { ...bundle, evidenceCommit, snapshot, snapshotCommit };
}

async function makeStable(root, repository, version, productRevision, agentRevision, options = {}) {
  const fixture = await makePromotable(root, repository, version, productRevision, agentRevision, options);
  const authorization = await writeAuthorization(root, "promote-stable", options.owner ?? "release-owner");
  const result = invoke([
    "promote-stable", "--repository", repository, "--version", version, "--authorization", authorization,
  ], repository);
  assert.equal(result.status, 0, result.stderr);
  const stableCommit = commitAll(repository, `stable ${version}`);
  return { ...fixture, stableCommit };
}

test("first Stable is a three-commit, Owner-gated transaction with self-reference-free evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-promotion-first-"));
  try {
    const repository = await initializeRepository(root);
    const fixture = await makePromotable(root, repository, "0.1.0", "3".repeat(40), "4".repeat(40));
    assert.equal(await readFile(path.join(repository, "default.xml"), "utf8").catch(() => undefined), undefined);
    const evidencePath = path.join(repository, "releases", "tsfg-v0.1.0", "evidence.json");
    const evidenceBytes = await readFile(evidencePath);
    const evidence = JSON.parse(evidenceBytes);
    assert.equal(evidence.recordedState, "Promotable");
    assert.equal(evidence.productTag.targetRevision, "3".repeat(40));
    assert.equal(evidence.snapshot.sha256, byteDigest(fixture.snapshot));
    assert.equal("manifestCommit" in evidence, false);
    assert.equal("stableCommit" in evidence, false);
    assert.equal(evidenceBytes.includes(byteDigest(evidenceBytes)), false);
    assert.equal(runGit(repository, "merge-base", "--is-ancestor", fixture.snapshotCommit, fixture.evidenceCommit), "");

    const botAuthorization = await writeAuthorization(root, "promote-stable", "release-bot[bot]");
    const bot = invoke([
      "promote-stable", "--repository", repository, "--version", "0.1.0", "--authorization", botAuthorization,
    ], repository);
    assert.equal(bot.status, 1);
    assert.match(bot.stderr, /human (?:GitHub user|Release Owner)/i);
    assert.equal(await readFile(path.join(repository, "default.xml"), "utf8").catch(() => undefined), undefined);

    const promotionAuthorization = await writeAuthorization(root, "promote-stable");
    const promoted = invoke([
      "promote-stable", "--repository", repository, "--version", "0.1.0", "--authorization", promotionAuthorization,
    ], repository);
    assert.equal(promoted.status, 0, promoted.stderr);
    assert.equal(await readFile(path.join(repository, "default.xml"), "utf8"), fixture.snapshot);
    assert.equal(JSON.parse(await readFile(path.join(repository, "releases", "tsfg-v0.1.0", "state.json"))).promotionState, "Stable");
    const stableCommit = commitAll(repository, "first Stable commit point");
    assert.notEqual(stableCommit, fixture.evidenceCommit);

    const gate = invoke([
      "gate", "--repository", repository, "--base", fixture.evidenceCommit, "--head", stableCommit,
      "--out", path.join(root, "gate"),
    ], repository);
    assert.equal(gate.status, 0, gate.stderr);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, "gate", "manifest-plan.json"))).candidates, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Promotable fails closed for every missing or inconsistent gate", async (t) => {
  const cases = [
    ["required CI", (files) => { files["verified-candidate.json"].promotionState = "Candidate"; }, /required CI/i],
    ["Offline Proof", (files) => { files["offline-proof.json"].status = "failure"; }, /Offline Proof/i],
    ["Owner role", (files) => { files["owner-approval.json"].role = "Integration Owner"; }, /human Release Owner/i],
    ["bot approval", (files) => { files["owner-approval.json"].actor = { login: "release[bot]", type: "Bot" }; }, /human Release Owner/i],
    ["bot contract approval", (files) => {
      files["owner-approval.json"].additionalApprovals.push({
        actor: { login: "contracts[bot]", type: "Bot" }, decision: "approved", role: "Contracts Owner",
      });
    }, /applicable Owner approvals/i],
    ["version readiness", (files) => { files["version-readiness.json"].status = "pending"; }, /not ready/i],
    ["moving tag", (files) => { files["product-tag.json"].targetRevision = "9".repeat(40); }, /product tag/i],
    ["incomplete materials", (files) => { files["release-materials.json"].artifacts.pop(); }, /release materials/i],
  ];
  for (const [name, mutate, message] of cases) {
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "tsfg-promotion-negative-"));
      try {
        const repository = await initializeRepository(root);
        const snapshot = manifest("3".repeat(40), "4".repeat(40));
        await mkdir(path.join(repository, "snapshots"));
        await writeFile(path.join(repository, "snapshots", "tsfg-v0.1.0.xml"), snapshot);
        const manifestRevision = commitAll(repository, "snapshot");
        const { bundleRoot } = await writeBundle(root, {
          version: "0.1.0", productRevision: "3".repeat(40), agentRevision: "4".repeat(40), manifestRevision, mutate,
        });
        const authorization = await writeAuthorization(root, "record-release-evidence");
        const result = invoke([
          "record-release-evidence", "--repository", repository, "--version", "0.1.0", "--bundle", bundleRoot,
          "--authorization", authorization,
        ], repository);
        assert.equal(result.status, 1, `${name} unexpectedly passed`);
        assert.match(result.stderr, message);
        assert.equal(await readFile(path.join(repository, "releases", "tsfg-v0.1.0", "state.json")).catch(() => undefined), undefined);
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
});

test("evidence must be content-addressed, complete, and committed before Stable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-promotion-content-address-"));
  try {
    const repository = await initializeRepository(root);
    const snapshot = manifest("3".repeat(40), "4".repeat(40));
    await mkdir(path.join(repository, "snapshots"));
    await writeFile(path.join(repository, "snapshots", "tsfg-v0.1.0.xml"), snapshot);
    const manifestRevision = commitAll(repository, "snapshot");
    const { bundleRoot } = await writeBundle(root, {
      version: "0.1.0", productRevision: "3".repeat(40), agentRevision: "4".repeat(40), manifestRevision,
    });
    const bundlePath = path.join(bundleRoot, "bundle.json");
    const bundle = JSON.parse(await readFile(bundlePath));
    bundle.entries[0].sha256 = byteDigest("forged");
    await writeJson(bundlePath, bundle);
    const authorization = await writeAuthorization(root, "record-release-evidence");
    const rejected = invoke([
      "record-release-evidence", "--repository", repository, "--version", "0.1.0", "--bundle", bundleRoot,
      "--authorization", authorization,
    ], repository);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /content address/i);

    const valid = await writeBundle(root, {
      version: "0.1.0", productRevision: "3".repeat(40), agentRevision: "4".repeat(40), manifestRevision,
    });
    assert.equal(invoke([
      "record-release-evidence", "--repository", repository, "--version", "0.1.0", "--bundle", valid.bundleRoot,
      "--authorization", authorization,
    ], repository).status, 0);
    const promotionAuthorization = await writeAuthorization(root, "promote-stable");
    const premature = invoke([
      "promote-stable", "--repository", repository, "--version", "0.1.0", "--authorization", promotionAuthorization,
    ], repository);
    assert.equal(premature.status, 1);
    assert.match(premature.stderr, /clean.*worktree/i);
    assert.equal(await readFile(path.join(repository, "default.xml"), "utf8").catch(() => undefined), undefined);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("post-Stable publication metadata is idempotent and cannot rewrite Stable identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-promotion-finalize-"));
  try {
    const repository = await initializeRepository(root);
    const stable = await makeStable(root, repository, "0.1.0", "3".repeat(40), "4".repeat(40));
    const metadataPath = path.join(root, "publication.json");
    await writeJson(metadataPath, {
      productVersion: "0.1.0",
      publications: [{ immutableId: "release-100", kind: "github-release", url: "https://github.com/xuelongling/tsfg/releases/tag/tsfg-v0.1.0" }],
      schemaVersion: "1", status: "complete",
    });
    const authorization = await writeAuthorization(root, "finalize-release");
    const command = [
      "finalize-release", "--repository", repository, "--version", "0.1.0", "--metadata", metadataPath,
      "--authorization", authorization,
    ];
    assert.equal(invoke(command, repository).status, 0);
    const publicationCommit = commitAll(repository, "finalize publication");
    const defaultBefore = await readFile(path.join(repository, "default.xml"));
    const stateBefore = await readFile(path.join(repository, "releases", "tsfg-v0.1.0", "state.json"));
    const replayAuthorization = await writeAuthorization(root, "finalize-release");
    const replayCommand = [
      "finalize-release", "--repository", repository, "--version", "0.1.0", "--metadata", metadataPath,
      "--authorization", replayAuthorization,
    ];
    assert.equal(invoke(replayCommand, repository).status, 0);
    assert.equal(runGit(repository, "status", "--porcelain"), "");

    await writeJson(metadataPath, {
      productVersion: "0.1.0",
      publications: [{ immutableId: "release-CHANGED", kind: "github-release", url: "https://github.com/xuelongling/tsfg/releases/tag/tsfg-v0.1.0" }],
      schemaVersion: "1", status: "complete",
    });
    const conflict = invoke(replayCommand, repository);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /immutable/i);
    assert.deepEqual(await readFile(path.join(repository, "default.xml")), defaultBefore);
    assert.deepEqual(await readFile(path.join(repository, "releases", "tsfg-v0.1.0", "state.json")), stateBefore);

    const gate = invoke([
      "gate", "--repository", repository, "--base", stable.stableCommit, "--head", publicationCommit,
      "--out", path.join(root, "publication-gate"),
    ], repository);
    assert.equal(gate.status, 0, gate.stderr);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("rollback is a new commit that withdraws the bad release without changing old identities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-promotion-rollback-"));
  try {
    const repository = await initializeRepository(root);
    const first = await makeStable(root, repository, "0.1.0", "3".repeat(40), "4".repeat(40));
    const second = await makeStable(root, repository, "0.2.0", "5".repeat(40), "6".repeat(40));
    const immutablePaths = [
      "snapshots/tsfg-v0.1.0.xml", "snapshots/tsfg-v0.2.0.xml",
      "releases/tsfg-v0.1.0/evidence.json", "releases/tsfg-v0.2.0/evidence.json",
    ];
    const before = new Map(immutablePaths.map((filePath) => [filePath, runGit(repository, "rev-parse", `HEAD:${filePath}`)]));
    const approvalPath = path.join(root, "rollback.json");
    await writeJson(approvalPath, {
      action: "rollback", actor: { login: "release-owner", type: "User" }, decision: "approved",
      fromVersion: "0.2.0", reason: "fixture regression", role: "Release Owner", schemaVersion: "1",
      source: "protected-release-environment", toVersion: "0.1.0",
    });
    const authorization = await writeAuthorization(root, "rollback");
    const rolledBack = invoke([
      "rollback", "--repository", repository, "--approval", approvalPath, "--authorization", authorization,
    ], repository);
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(await readFile(path.join(repository, "default.xml"), "utf8"), first.snapshot);
    const badState = JSON.parse(await readFile(path.join(repository, "releases", "tsfg-v0.2.0", "state.json")));
    assert.equal(badState.promotionState, "Withdrawn");
    assert.equal(badState.withdrawal.rollbackTargetVersion, "0.1.0");
    assert.equal(JSON.parse(await readFile(path.join(repository, "releases", "tsfg-v0.1.0", "state.json"))).promotionState, "Superseded");
    const rollbackCommit = commitAll(repository, "rollback 0.2.0 to 0.1.0");
    assert.equal(runGit(repository, "merge-base", "--is-ancestor", second.stableCommit, rollbackCommit), "");
    for (const [filePath, oid] of before) assert.equal(runGit(repository, "rev-parse", `HEAD:${filePath}`), oid);

    const gate = invoke([
      "gate", "--repository", repository, "--base", second.stableCommit, "--head", rollbackCommit,
      "--out", path.join(root, "rollback-gate"),
    ], repository);
    assert.equal(gate.status, 0, gate.stderr);

    const reverseBase = rollbackCommit;
    const firstStatePath = path.join(repository, "releases", "tsfg-v0.1.0", "state.json");
    const firstState = JSON.parse(await readFile(firstStatePath));
    firstState.promotionState = "Stable";
    delete firstState.supersededBy;
    await writeJson(firstStatePath, firstState);
    const reverseHead = commitAll(repository, "illegal reverse transition");
    const reverse = invoke([
      "gate", "--repository", repository, "--base", reverseBase, "--head", reverseHead,
      "--out", path.join(root, "reverse-gate"),
    ], repository);
    assert.equal(reverse.status, 1);
    assert.match(reverse.stderr, /cannot move/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manual default creation and Release Evidence mutation fail the repository gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-promotion-gate-negative-"));
  try {
    const repository = await initializeRepository(root);
    const promotable = await makePromotable(root, repository, "0.1.0", "3".repeat(40), "4".repeat(40));
    await writeFile(path.join(repository, "default.xml"), promotable.snapshot);
    const manualHead = commitAll(repository, "manual default");
    const manual = invoke([
      "gate", "--repository", repository, "--base", promotable.evidenceCommit, "--head", manualHead,
      "--out", path.join(root, "manual-gate"),
    ], repository);
    assert.equal(manual.status, 1);
    assert.match(manual.stderr, /rollback|commit point|transition/i);

    runGit(repository, "reset", "--hard", promotable.evidenceCommit);
    const evidencePath = path.join(repository, "releases", "tsfg-v0.1.0", "evidence.json");
    const evidence = JSON.parse(await readFile(evidencePath));
    evidence.stableCommit = "7".repeat(40);
    await writeJson(evidencePath, evidence);
    const mutatedHead = commitAll(repository, "mutate evidence");
    const mutation = invoke([
      "gate", "--repository", repository, "--base", promotable.evidenceCommit, "--head", mutatedHead,
      "--out", path.join(root, "mutation-gate"),
    ], repository);
    assert.equal(mutation.status, 1);
    assert.match(mutation.stderr, /evidence\.json is immutable/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("release transaction authorization is mandatory and bound to the current main commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-promotion-authorization-"));
  try {
    const repository = await initializeRepository(root);
    const metadataPath = path.join(root, "publication.json");
    await writeJson(metadataPath, {
      productVersion: "0.1.0", publications: [], schemaVersion: "1", status: "complete",
    });
    const missing = invoke([
      "finalize-release", "--repository", repository, "--version", "0.1.0", "--metadata", metadataPath,
    ], repository);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /missing required option: --authorization/i);

    const stale = await writeAuthorization(root, "finalize-release");
    await writeFile(path.join(repository, "note.txt"), "advance main\n");
    commitAll(repository, "advance protected main");
    const rejected = invoke([
      "finalize-release", "--repository", repository, "--version", "0.1.0", "--metadata", metadataPath,
      "--authorization", stale,
    ], repository);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /current protected main commit/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
