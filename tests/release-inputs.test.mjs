// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestCi = path.join(sourceRoot, "tools", "manifest-ci.mjs");
const version = "0.1.0";
const actor = { login: "release-owner", type: "User" };

function invoke(arguments_, cwd) {
  return spawnSync(process.execPath, [manifestCi, ...arguments_], { cwd, encoding: "utf8" });
}

function runGit(repository, ...arguments_) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function byteDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-release-inputs-"));
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, ".github", "workflows"), { recursive: true });
  await cp(
    path.join(sourceRoot, ".github", "workflows", "release-inputs.yml"),
    path.join(repository, ".github", "workflows", "release-inputs.yml"),
  );
  runGit(repository, "init", "-b", "main");
  runGit(repository, "config", "user.name", "Release Fixture");
  runGit(repository, "config", "user.email", "release-fixture@example.invalid");
  runGit(repository, "add", ".");
  runGit(repository, "commit", "-m", "fixture main");
  return { repository, root };
}

function workflowRun({ id, event, headSha, path: workflow, status = "completed", conclusion = "success", runActor = actor }) {
  return {
    actor: runActor,
    conclusion,
    event,
    head_branch: event === "workflow_dispatch" ? "main" : "candidate",
    head_repository: { full_name: "xuelongling/manifests" },
    head_sha: headSha,
    id: Number(id),
    path: workflow,
    repository: { full_name: "xuelongling/manifests" },
    status,
    triggering_actor: runActor,
  };
}

async function createInputs(root, repository, mutate = () => {}) {
  const inputRoot = path.join(root, "inputs");
  const apiRoot = path.join(root, "api");
  const head = runGit(repository, "rev-parse", "HEAD");
  const productRevision = "3".repeat(40);
  const agentRevision = "4".repeat(40);
  const candidateId = "a".repeat(64);
  const candidateRunId = "201";
  const offlineRunId = "202";
  const releaseInputRunId = "203";
  const candidate = {
    agentRevision,
    candidateOverlayDigest: byteDigest("overlay"),
    id: candidateId,
    manifest: "snapshots/tsfg-v0.1.0.xml",
    manifestRepository: "https://github.com/xuelongling/manifests.git",
    manifestRevision: head,
    productRevision,
    resolvedManifestDigest: `sha256:${candidateId}`,
  };
  const releaseReports = ["linux-x86_64-gnu", "windows-x86_64-msvc"].map((target) => ({
    candidateId,
    licenseReport: {
      path: `producers/${candidateId}/${target}/release/a/workspace-report.json`, sha256: byteDigest(`${target}/license-report`),
    },
    reproducibilityReport: {
      path: `reproducibility/${candidateId}/${target}/release/report.json`, sha256: byteDigest(`${target}/reproducibility-report`),
    },
    target,
  }));
  const files = {
    "offline-proof.json": {
      builds: [], candidate, candidateIds: [candidateId], candidateRun: { runId: candidateRunId }, controllerRun: {},
      evidenceDigest: byteDigest("offline"), proof: "Offline Proof", requiredEvidence: {},
      resolvedManifestXmlSha256: byteDigest("manifest"), schemaVersion: "1", status: "success",
    },
    "owner-approval.json": {
      action: "promote-stable", actor: { ...actor }, additionalApprovals: [], candidateId, decision: "approved",
      productVersion: version, role: "Release Owner", schemaVersion: "1", source: "protected-release-environment",
    },
    "product-tag.json": {
      name: "tsfg-v0.1.0", repository: "https://github.com/xuelongling/tsfg.git", schemaVersion: "1",
      status: "fixed", targetRevision: productRevision,
    },
    "release-materials.json": {
      artifacts: ["linux-x86_64-gnu", "windows-x86_64-msvc"].map((target) => ({
        archiveSha256: byteDigest(`${target}/archive`), artifactManifestSha256: byteDigest(`${target}/manifest`),
        buildIdentityDigest: byteDigest(`${target}/identity`), checksumsSha256: byteDigest(`${target}/checksums`),
        licenseReport: { ...releaseReports.find((entry) => entry.target === target).licenseReport },
        reproducibilityReport: { ...releaseReports.find((entry) => entry.target === target).reproducibilityReport }, target,
      })),
      candidateEvidence: {
        artifact: `manifest-candidate-evidence-${head}`,
        digest: byteDigest("candidate-evidence-artifact"),
        headSha: head,
        runId: candidateRunId,
        workflow: ".github/workflows/manifest-pr.yml",
      },
      candidateId, releaseStatus: "non-stable", schemaVersion: "1", status: "fixed",
    },
    "verified-candidate.json": {
      candidateIds: [candidateId], evidenceDigest: byteDigest("candidate"), evidenceRetentionDays: "90",
      promotionState: "Verified Candidate", releaseReports, requiredEvidence: {}, schemaVersion: "1",
    },
    "version-readiness.json": { candidateId, productVersion: version, schemaVersion: "1", status: "ready" },
  };
  const api = {
    "workflow-run.json": workflowRun({
      id: releaseInputRunId, event: "workflow_dispatch", headSha: head,
      path: ".github/workflows/release-inputs.yml", status: "in_progress", conclusion: null,
    }),
    "reviews.json": [],
    "candidate-run.json": workflowRun({
      id: candidateRunId, event: "pull_request", headSha: head, path: ".github/workflows/manifest-pr.yml",
    }),
    "candidate-artifacts.json": {
      artifacts: [
        { digest: byteDigest("candidate-verdict-artifact"), expired: false, name: `manifest-verdict-${head}`, workflow_run: { id: Number(candidateRunId) } },
        { digest: byteDigest("candidate-evidence-artifact"), expired: false, name: `manifest-candidate-evidence-${head}`, workflow_run: { id: Number(candidateRunId) } },
      ],
    },
    "offline-proof-run.json": workflowRun({
      id: offlineRunId, event: "workflow_dispatch", headSha: head, path: ".github/workflows/tier1-offline-proof.yml",
    }),
    "offline-proof-artifacts.json": {
      artifacts: [{ digest: byteDigest("offline-proof-artifact"), expired: false, name: `tier1-offline-proof-${candidateId}`, workflow_run: { id: Number(offlineRunId) } }],
    },
  };
  mutate({ api, files });
  for (const [name, value] of Object.entries(files)) await writeJson(path.join(inputRoot, name), value);
  for (const [name, value] of Object.entries(api)) await writeJson(path.join(apiRoot, name), value);
  const tagRefs = path.join(apiRoot, "tag-refs.txt");
  await writeFile(tagRefs, `${productRevision}\trefs/tags/tsfg-v0.1.0\n`);
  const ownerBytes = await readFile(path.join(inputRoot, "owner-approval.json"));
  return {
    arguments: [
      "prepare-release-bundle", "--repository", repository, "--version", version,
      "--verified-candidate", path.join(inputRoot, "verified-candidate.json"),
      "--offline-proof", path.join(inputRoot, "offline-proof.json"),
      "--owner-approval", path.join(inputRoot, "owner-approval.json"),
      "--owner-approval-sha256", byteDigest(ownerBytes),
      "--version-readiness", path.join(inputRoot, "version-readiness.json"),
      "--product-tag", path.join(inputRoot, "product-tag.json"),
      "--release-materials", path.join(inputRoot, "release-materials.json"),
      "--workflow-run", path.join(apiRoot, "workflow-run.json"), "--reviews", path.join(apiRoot, "reviews.json"),
      "--run-id", releaseInputRunId, "--actor", actor.login, "--triggering-actor", actor.login,
      "--ref", "refs/heads/main", "--sha", head, "--candidate-id", candidateId,
      "--candidate-run", path.join(apiRoot, "candidate-run.json"), "--candidate-run-id", candidateRunId,
      "--candidate-artifacts", path.join(apiRoot, "candidate-artifacts.json"),
      "--candidate-artifact", `manifest-verdict-${head}`,
      "--offline-proof-run", path.join(apiRoot, "offline-proof-run.json"), "--offline-proof-run-id", offlineRunId,
      "--offline-proof-artifacts", path.join(apiRoot, "offline-proof-artifacts.json"), "--tag-refs", tagRefs,
      "--out", path.join(root, "bundle"),
    ],
    inputRoot,
    output: path.join(root, "bundle"),
    ownerBytes,
  };
}

test("prepare-release-bundle preserves the human approval bytes and content-addresses all exact inputs", async () => {
  const { repository, root } = await fixtureRoot();
  try {
    const fixture = await createInputs(root, repository);
    const result = invoke(fixture.arguments, repository);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(path.join(fixture.output, "owner-approval.json")), fixture.ownerBytes);
    assert.deepEqual(await readdir(fixture.output), [
      "bundle.json", "offline-proof.json", "owner-approval.json", "product-tag.json",
      "release-materials.json", "verified-candidate.json", "version-readiness.json",
    ]);
    const bundle = JSON.parse(await readFile(path.join(fixture.output, "bundle.json")));
    assert.equal(bundle.entries.length, 6);
    for (const entry of bundle.entries) {
      assert.equal(entry.sha256, byteDigest(await readFile(path.join(fixture.output, entry.path))));
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

for (const [name, mutate, pattern] of [
  ["bot dispatch", ({ api }) => { api["workflow-run.json"].actor = { login: "release-bot[bot]", type: "Bot" }; }, /human GitHub user/i],
  ["missing candidate artifact", ({ api }) => { api["candidate-artifacts.json"].artifacts = []; }, /exact run/i],
  ["failed offline proof run", ({ api }) => { api["offline-proof-run.json"].conclusion = "failure"; }, /required API-backed workflow run/i],
  ["owner identity mismatch", ({ files }) => { files["owner-approval.json"].actor.login = "different-owner"; }, /dispatching human/i],
  ["detached license report", ({ files }) => {
    files["release-materials.json"].artifacts[0].licenseReport.sha256 = byteDigest("detached report");
  }, /not bound to the Verified Candidate report/i],
  ["detached Candidate evidence artifact", ({ api }) => {
    api["candidate-artifacts.json"].artifacts.find((artifact) => artifact.name.startsWith("manifest-candidate-evidence-")).digest = byteDigest("detached evidence artifact");
  }, /Candidate report source does not match/i],
]) {
  test(`prepare-release-bundle fails closed on ${name}`, async () => {
    const { repository, root } = await fixtureRoot();
    try {
      const fixture = await createInputs(root, repository, mutate);
      const result = invoke(fixture.arguments, repository);
      assert.equal(result.status, 1);
      assert.match(result.stderr, pattern);
      assert.equal(await readFile(path.join(fixture.output, "bundle.json")).catch(() => undefined), undefined);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}

test("prepare-release-bundle rejects an unconfirmed approval byte digest", async () => {
  const { repository, root } = await fixtureRoot();
  try {
    const fixture = await createInputs(root, repository);
    const index = fixture.arguments.indexOf("--owner-approval-sha256") + 1;
    fixture.arguments[index] = byteDigest("not-the-owner-record");
    const result = invoke(fixture.arguments, repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /approval bytes do not match/i);
    assert.equal(await readFile(path.join(fixture.output, "bundle.json")).catch(() => undefined), undefined);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("prepare-release-bundle rejects a dispatch Candidate ID that differs from the evidence", async () => {
  const { repository, root } = await fixtureRoot();
  try {
    const fixture = await createInputs(root, repository);
    const index = fixture.arguments.indexOf("--candidate-id") + 1;
    fixture.arguments[index] = "b".repeat(64);
    const result = invoke(fixture.arguments, repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Candidate identity does not match/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
