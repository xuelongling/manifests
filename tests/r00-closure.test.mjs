// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestCi = path.join(sourceRoot, "tools", "manifest-ci.mjs");
const version = "0.1.0";
const productRevision = "3".repeat(40);
const agentRevision = "4".repeat(40);
const postStableProductMain = "5".repeat(40);
const owner = { login: "release-owner", type: "User" };

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

function manifest() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- SPDX-License-Identifier: MIT -->
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

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

function commitAll(repository, message) {
  runGit(repository, "add", "-A");
  runGit(repository, "commit", "-m", message);
  return runGit(repository, "rev-parse", "HEAD");
}

async function writeAuthorization(root, repository, operation) {
  const filePath = path.join(root, `authorization-${operation}.json`);
  await writeJson(filePath, {
    actor: owner,
    environment: "protected-release-environment",
    environmentReviews: [],
    operation,
    repository: "xuelongling/manifests",
    reviewEvidenceSha256: byteDigest("reviews"),
    runEvidenceSha256: byteDigest("run"),
    schemaVersion: "1",
    source: "github-actions",
    workflow: {
      commit: runGit(repository, "rev-parse", "HEAD"),
      path: ".github/workflows/release-owner.yml",
      ref: "refs/heads/main",
      runId: "123",
    },
  });
  return filePath;
}

async function writeBundle(root, snapshotCommit) {
  const bundleRoot = path.join(root, "bundle");
  const candidateId = "a".repeat(64);
  const candidate = {
    agentRevision,
    candidateOverlayDigest: byteDigest("overlay"),
    id: candidateId,
    manifest: "snapshots/tsfg-v0.1.0.xml",
    manifestRepository: "https://github.com/xuelongling/manifests.git",
    manifestRevision: snapshotCommit,
    productRevision,
    resolvedManifestDigest: `sha256:${candidateId}`,
  };
  const files = {
    "offline-proof.json": {
      builds: [], candidate, candidateIds: [candidateId], candidateRun: {}, controllerRun: {},
      evidenceDigest: byteDigest("offline"), proof: "Offline Proof", requiredEvidence: {},
      resolvedManifestXmlSha256: byteDigest(manifest()), schemaVersion: "1", status: "success",
    },
    "owner-approval.json": {
      action: "promote-stable", actor: owner, additionalApprovals: [], candidateId, decision: "approved",
      productVersion: version, role: "Release Owner", schemaVersion: "1", source: "protected-release-environment",
    },
    "product-tag.json": {
      name: "tsfg-v0.1.0", repository: "https://github.com/xuelongling/tsfg.git", schemaVersion: "1",
      status: "fixed", targetRevision: productRevision,
    },
    "release-materials.json": {
      artifacts: ["linux-x86_64-gnu", "windows-x86_64-msvc"].map((target) => ({
        archiveSha256: byteDigest(`${target}/archive`), artifactManifestSha256: byteDigest(`${target}/manifest`),
        buildIdentityDigest: byteDigest(`${target}/identity`), checksumsSha256: byteDigest(`${target}/checksums`), target,
      })),
      candidateId, releaseStatus: "non-stable", schemaVersion: "1", status: "fixed",
    },
    "verified-candidate.json": {
      candidateIds: [candidateId], evidenceDigest: byteDigest("candidate"), evidenceRetentionDays: "90",
      promotionState: "Verified Candidate", requiredEvidence: {}, schemaVersion: "1",
    },
    "version-readiness.json": { candidateId, productVersion: version, schemaVersion: "1", status: "ready" },
  };
  for (const [name, value] of Object.entries(files)) await writeJson(path.join(bundleRoot, name), value);
  const entries = [];
  for (const name of Object.keys(files).sort()) {
    entries.push({ path: name, sha256: byteDigest(await readFile(path.join(bundleRoot, name))) });
  }
  await writeJson(path.join(bundleRoot, "bundle.json"), {
    contentAddress: digest({ entries, schemaVersion: "1" }), entries, schemaVersion: "1",
  });
  return { bundleRoot, candidate, candidateId };
}

const evidenceRequirements = [
  ["product-ci", "xuelongling/tsfg", ".github/workflows/product-pr.yml", "pull_request"],
  ["agent-ci", "xuelongling/.agents", ".github/workflows/agent-infrastructure-pr.yml", "pull_request"],
  ["manifest-candidate", "xuelongling/manifests", ".github/workflows/manifest-pr.yml", "pull_request"],
  ["vm-controller", "xuelongling/manifests", ".github/workflows/tier1-vm-controller.yml", "workflow_dispatch"],
  ["offline-proof", "xuelongling/manifests", ".github/workflows/tier1-offline-proof.yml", "workflow_dispatch"],
  ["release-inputs", "xuelongling/manifests", ".github/workflows/release-inputs.yml", "workflow_dispatch"],
  ["release-evidence", "xuelongling/manifests", ".github/workflows/release-owner.yml", "workflow_dispatch"],
  ["stable-promotion", "xuelongling/manifests", ".github/workflows/release-owner.yml", "workflow_dispatch"],
  ["release-finalization", "xuelongling/manifests", ".github/workflows/release-owner.yml", "workflow_dispatch"],
];

const acceptance = [
  ["fresh-bootstrap", ["manifest-candidate"]],
  ["repository-topology", ["product-ci", "agent-ci", "manifest-candidate"]],
  ["workspace-verification", ["manifest-candidate"]],
  ["offline-build-matrix", ["manifest-candidate"]],
  ["empty-contract-set", ["product-ci", "manifest-candidate"]],
  ["reproducibility", ["product-ci", "manifest-candidate"]],
  ["tier1-offline-proof", ["vm-controller", "offline-proof"]],
  ["source-license-provenance", ["product-ci", "agent-ci", "manifest-candidate"]],
  ["required-ci", ["product-ci", "agent-ci", "manifest-candidate"]],
  ["staged-release-evidence", ["release-inputs", "release-evidence"]],
  ["stable-default", ["stable-promotion"]],
  ["long-term-replay", ["offline-proof", "release-finalization"]],
  ["no-scope-leakage", ["product-ci", "agent-ci", "manifest-candidate"]],
].map(([id, evidence]) => ({ evidence, id }));

function requiredArtifacts(id, headSha, candidateId, runId) {
  const names = {
    "product-ci": [`verified-candidate-${headSha}`, `candidate-evidence-${headSha}`],
    "agent-ci": [],
    "manifest-candidate": [`manifest-verdict-${headSha}`, `manifest-candidate-evidence-${headSha}`],
    "vm-controller": [`tier1-vm-controller-${candidateId}`],
    "offline-proof": [`tier1-offline-proof-${candidateId}`],
    "release-inputs": [`release-provisional-inputs-${candidateId}`],
    "release-evidence": [`release-owner-record-release-evidence-${runId}`],
    "stable-promotion": [`release-owner-promote-stable-${runId}`],
    "release-finalization": [`release-owner-finalize-release-${runId}`],
  }[id];
  return names.map((name) => ({ digest: byteDigest(`${id}/${name}`), name }));
}

async function buildClosureFixture(mutateRecord = () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-r00-closure-"));
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await cp(path.join(sourceRoot, ".github", "workflows", "release-owner.yml"), path.join(repository, ".github", "workflows", "release-owner.yml"));
  await cp(path.join(sourceRoot, ".github", "workflows", "release-inputs.yml"), path.join(repository, ".github", "workflows", "release-inputs.yml"));
  await cp(path.join(sourceRoot, ".github", "workflows", "r00-closure.yml"), path.join(repository, ".github", "workflows", "r00-closure.yml"));
  await mkdir(path.join(repository, "bootstrap"));
  await writeFile(path.join(repository, "bootstrap", "r00.xml"), manifest());
  runGit(repository, "init", "-b", "main");
  runGit(repository, "config", "user.name", "Closure Fixture");
  runGit(repository, "config", "user.email", "closure-fixture@example.invalid");
  commitAll(repository, "bootstrap");

  await mkdir(path.join(repository, "snapshots"));
  await writeFile(path.join(repository, "snapshots", "tsfg-v0.1.0.xml"), manifest());
  const snapshotCommit = commitAll(repository, "snapshot");
  const bundle = await writeBundle(root, snapshotCommit);
  const evidenceAuthorization = await writeAuthorization(root, repository, "record-release-evidence");
  let result = invoke([
    "record-release-evidence", "--repository", repository, "--version", version,
    "--bundle", bundle.bundleRoot, "--authorization", evidenceAuthorization,
  ], repository);
  assert.equal(result.status, 0, result.stderr);
  const evidenceCommit = commitAll(repository, "release evidence");
  const promotionAuthorization = await writeAuthorization(root, repository, "promote-stable");
  result = invoke([
    "promote-stable", "--repository", repository, "--version", version, "--authorization", promotionAuthorization,
  ], repository);
  assert.equal(result.status, 0, result.stderr);
  const stableCommit = commitAll(repository, "stable");
  const metadata = path.join(root, "publication.json");
  await writeJson(metadata, {
    productVersion: version,
    publications: [{
      immutableId: "release-101", kind: "github-release",
      url: "https://github.com/xuelongling/tsfg/releases/tag/tsfg-v0.1.0",
    }],
    schemaVersion: "1", status: "complete",
  });
  const finalizeAuthorization = await writeAuthorization(root, repository, "finalize-release");
  result = invoke([
    "finalize-release", "--repository", repository, "--version", version,
    "--metadata", metadata, "--authorization", finalizeAuthorization,
  ], repository);
  assert.equal(result.status, 0, result.stderr);
  const publicationCommit = commitAll(repository, "publication");

  const headByLane = {
    "product-ci": productRevision, "agent-ci": agentRevision,
    "manifest-candidate": snapshotCommit, "vm-controller": snapshotCommit, "offline-proof": snapshotCommit,
    "release-inputs": snapshotCommit, "release-evidence": snapshotCommit,
    "stable-promotion": evidenceCommit, "release-finalization": stableCommit,
  };
  const evidence = evidenceRequirements.map(([id, evidenceRepository, workflow], index) => {
    const runId = String(301 + index);
    const headSha = headByLane[id];
    return { artifacts: requiredArtifacts(id, headSha, bundle.candidateId, runId), headSha, id, repository: evidenceRepository, runId, workflow };
  });
  const assets = [];
  const evidenceRecord = JSON.parse(await readFile(path.join(repository, "releases", "tsfg-v0.1.0", "evidence.json")));
  const releaseMaterials = new Map(evidenceRecord.releaseMaterials.artifacts.map((artifact) => [artifact.target, artifact]));
  const materialFields = {
    archive: "archiveSha256", "artifact-manifest": "artifactManifestSha256", checksums: "checksumsSha256",
  };
  for (const target of ["linux-x86_64-gnu", "windows-x86_64-msvc"]) {
    for (const kind of ["archive", "artifact-manifest", "checksums", "license-report", "reproducibility-report"]) {
      const name = `tsfg-${version}-${target}-${kind}.json`;
      const field = materialFields[kind];
      assets.push({ digest: field ? releaseMaterials.get(target)[field] : byteDigest(name), kind, name, target });
    }
  }
  const record = {
    acceptance,
    candidate: {
      agentRevision, id: bundle.candidateId, manifestRevision: snapshotCommit,
      productRevision, snapshot: "snapshots/tsfg-v0.1.0.xml",
    },
    evidence,
    productVersion: version,
    release: {
      assets,
      githubRelease: {
        id: 101, repository: "xuelongling/tsfg", tag: "tsfg-v0.1.0",
        url: "https://github.com/xuelongling/tsfg/releases/tag/tsfg-v0.1.0",
      },
      tag: { name: "tsfg-v0.1.0", repository: "xuelongling/tsfg", targetRevision: productRevision },
    },
    repositories: {
      agent: { mainOid: agentRevision, repository: "xuelongling/.agents" },
      manifest: { repository: "xuelongling/manifests", stableOid: stableCommit },
      product: { postStableMainOid: postStableProductMain, repository: "xuelongling/tsfg" },
    },
    schemaVersion: "1",
  };
  mutateRecord(record);
  const recordPath = path.join(repository, "releases", "tsfg-v0.1.0", "closure.json");
  await writeJson(recordPath, record);
  const closureCommit = commitAll(repository, "R00 closure record");
  const runs = record.evidence.map((entry) => {
    const requirement = evidenceRequirements.find(([id]) => id === entry.id);
    return {
      actor: owner,
      artifacts: entry.artifacts.map((artifact) => ({ ...artifact, expired: false })),
      conclusion: "success",
      event: requirement?.[3] ?? "pull_request",
      headBranch: requirement?.[3] === "workflow_dispatch" ? "main" : "candidate",
      headSha: entry.headSha,
      repository: entry.repository,
      runId: entry.runId,
      status: "completed",
      triggeringActor: owner,
      workflow: entry.workflow,
    };
  });
  const apiEvidence = {
    githubRelease: { assets: record.release.assets.map(({ digest: assetDigest, name }) => ({ digest: assetDigest, name })), id: 101, tag: "tsfg-v0.1.0", url: record.release.githubRelease.url },
    repositories: {
      agent: { containsCandidate: true, mainOid: agentRevision },
      manifest: { containsCandidate: true, mainOid: closureCommit },
      product: { containsCandidate: true, mainOid: postStableProductMain, productVersion: "0.2.0-dev.0" },
    },
    runs,
    schemaVersion: "1",
    tag: { name: "tsfg-v0.1.0", targetRevision: productRevision },
  };
  const apiPath = path.join(root, "api-evidence.json");
  await writeJson(apiPath, apiEvidence);
  return { apiEvidence, apiPath, closureCommit, record, recordPath, repository, root };
}

function closureCommand(fixture, apiPath = fixture.apiPath, outputName = "closure-report.json") {
  return [
    "validate-r00-closure", "--repository", fixture.repository,
    "--record", "releases/tsfg-v0.1.0/closure.json", "--api-evidence", apiPath,
    "--validation-run-id", "999", "--validation-sha", fixture.closureCommit,
    "--out", path.join(fixture.root, outputName),
  ];
}

test("R00 closure binds the complete Stable state, acceptance lanes, API runs, artifacts, OIDs, and digests", async () => {
  const fixture = await buildClosureFixture();
  try {
    const result = invoke(closureCommand(fixture), fixture.repository);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(path.join(fixture.root, "closure-report.json")));
    assert.equal(report.status, "passed");
    assert.equal(report.validation.commit, fixture.closureCommit);
    assert.equal(report.validation.runId, "999");
    assert.equal(report.closureRecordSha256, byteDigest(await readFile(fixture.recordPath)));

    const failedApi = structuredClone(fixture.apiEvidence);
    failedApi.runs.find((entry) => entry.runId === "304").conclusion = "failure";
    const failedApiPath = path.join(fixture.root, "failed-api.json");
    await writeJson(failedApiPath, failedApi);
    const failed = invoke(closureCommand(fixture, failedApiPath, "failed-report.json"), fixture.repository);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /did not complete/i);

    const digestApi = structuredClone(fixture.apiEvidence);
    digestApi.githubRelease.assets[0].digest = byteDigest("wrong asset");
    const digestApiPath = path.join(fixture.root, "digest-api.json");
    await writeJson(digestApiPath, digestApi);
    const wrongDigest = invoke(closureCommand(fixture, digestApiPath, "digest-report.json"), fixture.repository);
    assert.equal(wrongDigest.status, 1);
    assert.match(wrongDigest.stderr, /lacks exact long-term asset/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("R00 closure rejects an incomplete acceptance/evidence record before producing a report", async () => {
  const fixture = await buildClosureFixture((record) => record.evidence.pop());
  try {
    const result = invoke(closureCommand(fixture), fixture.repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /every required workflow evidence lane exactly once/i);
    assert.equal(await readFile(path.join(fixture.root, "closure-report.json")).catch(() => undefined), undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("R00 closure rejects duplicate release asset names even when target/kind slots are complete", async () => {
  const fixture = await buildClosureFixture((record) => {
    record.release.assets[1].name = record.release.assets[0].name;
    record.release.assets[1].digest = record.release.assets[0].digest;
  });
  try {
    const result = invoke(closureCommand(fixture), fixture.repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid Stable release asset/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("R00 closure rejects a published asset digest detached from immutable Release Evidence", async () => {
  const fixture = await buildClosureFixture((record) => {
    record.release.assets.find((asset) => asset.kind === "archive").digest = byteDigest("detached archive");
  });
  try {
    const result = invoke(closureCommand(fixture), fixture.repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /committed Stable release state does not match/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the repository gate makes an accepted closure record immutable", async () => {
  const fixture = await buildClosureFixture();
  try {
    fixture.record.release.githubRelease.url = "https://github.com/xuelongling/tsfg/releases/tag/tsfg-v0.1.0?changed=1";
    await writeJson(fixture.recordPath, fixture.record);
    const changedCommit = commitAll(fixture.repository, "illegal closure rewrite");
    const result = invoke([
      "gate", "--repository", fixture.repository, "--base", fixture.closureCommit, "--head", changedCommit,
      "--out", path.join(fixture.root, "gate"),
    ], fixture.repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /closure\.json is immutable/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
