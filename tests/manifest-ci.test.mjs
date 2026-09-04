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
const bootstrapRevision = "d94f4e6bff9aa980b18b0df94e133559e4b61240";
const bootstrapProductRevision = "eb2838e4c4910113b23072b40c526a8b2843f744";
const candidateRevision = "4".repeat(40);

function invoke(arguments_, cwd = repositoryRoot) {
  return spawnSync(process.execPath, [manifestCi, ...arguments_], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
}

function runGit(repository, ...arguments_) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function initializeRepository(root, manifest) {
  await mkdir(path.join(root, "bootstrap"), { recursive: true });
  await writeFile(path.join(root, "bootstrap", "r00.xml"), manifest);
  runGit(root, "init", "-b", "main");
  runGit(root, "config", "user.name", "Fixture");
  runGit(root, "config", "user.email", "fixture@example.invalid");
  runGit(root, "add", ".");
  runGit(root, "commit", "-m", "baseline");
  return runGit(root, "rev-parse", "HEAD");
}

function commitAll(repository, message) {
  runGit(repository, "add", "-A");
  runGit(repository, "commit", "-m", message);
  return runGit(repository, "rev-parse", "HEAD");
}

function manifest(productRevision, agentRevision, extra = "") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest>
  <remote name="github-xuelongling" fetch="https://github.com/xuelongling/" />
  <project name="tsfg.git" path="tsfg" remote="github-xuelongling" revision="${productRevision}" upstream="refs/heads/main" />
  <project name=".agents.git" path=".agents" remote="github-xuelongling" revision="${agentRevision}" upstream="refs/heads/main">
    <linkfile src="AGENTS.md" dest="AGENTS.md" />
    <linkfile src="codex/config.toml" dest=".codex/config.toml" />
    <linkfile src="codex/hooks.json" dest=".codex/hooks.json" />
  </project>
  ${extra}
</manifest>
`;
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

function workspaceReport(candidate, resolved) {
  return {
    command: "verify-workspace",
    result: {
      manifest: {
        repositoryUrl: resolved.baseline.repository,
        revision: candidate.manifestRevision,
        selected: candidate.manifest,
      },
      projects: resolved.projects.map((project) => ({
        dirty: false,
        head: project.revision,
        id: project.name,
        path: project.path,
      })),
    },
    schemaVersion: "1",
    status: "success",
  };
}

async function treeDigest(root) {
  async function files(directory, relative = "") {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    const paths = [];
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) paths.push(...await files(path.join(directory, entry.name), child));
      else paths.push(child);
    }
    return paths;
  }
  const entries = await Promise.all((await files(root)).map(async (relativePath) => ({
    path: relativePath,
    sha256: byteDigest(await readFile(path.join(root, ...relativePath.split("/")))),
  })));
  return digest({ entries, schemaVersion: "1" });
}

async function writeOfflineProofFixture(root) {
  const candidateEvidence = path.join(root, "candidate-evidence");
  const proofEvidence = path.join(root, "proof-evidence");
  const candidateId = "c".repeat(64);
  const productRevision = "3".repeat(40);
  const agentRevision = "2".repeat(40);
  const manifestRevision = "4".repeat(40);
  const candidateOverlay = {
    baseline: {
      manifest: "snapshots/tsfg-v0.1.0.xml",
      repository: "https://github.com/xuelongling/manifests.git",
      revision: manifestRevision,
    },
    replacements: [{ project: "tsfg.git", revision: productRevision }],
    schemaVersion: "1",
  };
  const candidate = {
    agentRevision,
    candidateOverlayDigest: digest(candidateOverlay),
    id: candidateId,
    manifest: "snapshots/tsfg-v0.1.0.xml",
    manifestRepository: "https://github.com/xuelongling/manifests.git",
    manifestRevision,
    productRevision,
    resolvedManifestDigest: `sha256:${candidateId}`,
  };
  await writeJson(path.join(candidateEvidence, "manifest-plan.json"), {
    candidates: [{
      agentRevision, baselineProductRevision: "1".repeat(40), candidateOverlayDigest: candidate.candidateOverlayDigest,
      id: candidateId, manifest: candidate.manifest, manifestRepository: candidate.manifestRepository,
      manifestRevision, productRevision,
    }],
    evidenceRetentionDays: "90",
    schemaVersion: "1",
  });
  await writeJson(path.join(candidateEvidence, "candidates", candidateId, "candidate-overlay.json"), candidateOverlay);
  await writeJson(path.join(candidateEvidence, "candidates", candidateId, "candidate-summary.json"), {
    overlayDigest: candidate.candidateOverlayDigest,
    resolvedManifestDigest: candidate.resolvedManifestDigest,
    resolvedManifestXmlSha256: byteDigest("resolved manifest XML"),
    schemaVersion: "1",
  });
  const canaries = {
    after: ["1.1.1.1:443", "8.8.8.8:443"].map((endpoint) => ({ endpoint, status: "blocked" })),
    before: ["1.1.1.1:443", "8.8.8.8:443"].map((endpoint) => ({ endpoint, status: "blocked" })),
  };
  const buildIdentities = new Map();
  const archives = new Map();
  for (const target of ["linux-x86_64-gnu", "windows-x86_64-msvc"]) {
    for (const profile of ["debug", "release"]) {
      const buildIdentityDigest = byteDigest(`${target}/${profile}/identity`);
      const toolchainClosureDigest = byteDigest(`${target}/closure`);
      const archiveBytes = Buffer.from(`${target}/${profile}/archive\n`);
      const archiveSha256 = byteDigest(archiveBytes);
      buildIdentities.set(`${target}/${profile}`, { buildIdentityDigest, toolchainClosureDigest });
      archives.set(`${target}/${profile}`, archiveSha256);
      for (const producer of ["a", "b"]) {
        const producerRoot = path.join(candidateEvidence, "producers", candidateId, target, profile, producer);
        const archive = `tsfg-${target}-${profile}.archive`;
        const packageReport = {
          command: "package",
          result: {
            archive,
            buildIdentity: { digest: buildIdentityDigest, profile, target, toolchainClosureDigest },
          },
          schemaVersion: "1",
          status: "success",
        };
        const packageReportBytes = `${JSON.stringify(packageReport)}\n`;
        await writeJson(path.join(producerRoot, "package-report.json"), packageReport);
        await mkdir(path.join(producerRoot, "package"), { recursive: true });
        await writeFile(path.join(producerRoot, "package", archive), archiveBytes);
        if (target === "linux-x86_64-gnu") {
          const hostedRoot = path.join(candidateEvidence, "hosted-offline", candidateId, profile, producer);
          const beforeBytes = `${JSON.stringify({ canaries: canaries.before, schemaVersion: "1", status: "success" })}\n`;
          const afterBytes = `${JSON.stringify({ canaries: canaries.after, schemaVersion: "1", status: "success" })}\n`;
          await mkdir(hostedRoot, { recursive: true });
          await writeFile(path.join(hostedRoot, "canary-before.json"), beforeBytes);
          await writeFile(path.join(hostedRoot, "canary-after.json"), afterBytes);
          await writeJson(path.join(hostedRoot, "report.json"), {
            buildIdentityDigest,
            candidate,
            canaries,
            isolation: { boundary: "linux-network-namespace", loopbackOnly: true, status: "isolated" },
            producer,
            profile,
            schemaVersion: "1",
            sources: {
              canaryAfterSha256: byteDigest(afterBytes),
              canaryBeforeSha256: byteDigest(beforeBytes),
              packageReportSha256: byteDigest(packageReportBytes),
            },
            status: "success",
            target,
            toolchainClosureDigest,
          });
        }
      }
    }
  }
  const verifiedVerdict = path.join(root, "verified-verdict.json");
  await writeJson(verifiedVerdict, {
    candidateIds: [candidateId],
    evidenceDigest: await treeDigest(candidateEvidence),
    evidenceRetentionDays: "90",
    promotionState: "Verified Candidate",
    schemaVersion: "1",
  });
  for (const profile of ["release"]) {
    const identity = buildIdentities.get(`linux-x86_64-gnu/${profile}`);
    const linuxSources = {
      isolationAttestationSha256: byteDigest("linux/isolation-attestation"),
      osAttestationSha256: byteDigest("linux/os-attestation"),
      packageReportSha256: byteDigest("linux/package-report"),
      runtimeReportSha256: byteDigest("linux/runtime-report"),
    };
    await writeJson(path.join(proofEvidence, "linux-minimum", candidateId, profile, "report.json"), {
      archiveSha256: archives.get(`linux-x86_64-gnu/${profile}`),
      buildIdentityDigest: identity.buildIdentityDigest,
      candidate,
      canaries,
      controller: {
        attestationSha256: byteDigest("linux/controller-attestation"),
        executionChannel: "out-of-band",
        sourceReportsDigest: digest(linuxSources),
        status: "attested",
      },
      environment: {
        architecture: "x86_64",
        attestationSha256: byteDigest("linux/os-attestation"),
        distribution: "Debian GNU/Linux",
        distributionVersion: "12.15",
        glibcVersion: "2.36",
        kernelRelease: "6.1.0-39-amd64",
      },
      isolation: { boundary: "linux-network-namespace", loopbackOnly: true, status: "isolated" },
      profile,
      runtimeSmoke: { cpp: "passed", reportSha256: byteDigest("linux/runtime-report"), status: "passed", zig: "passed" },
      schemaVersion: "1",
      sources: linuxSources,
      status: "success",
      target: "linux-x86_64-gnu",
      toolchainClosureDigest: identity.toolchainClosureDigest,
    });
    for (const vm of ["a", "b"]) {
      const windowsIdentity = buildIdentities.get(`windows-x86_64-msvc/${profile}`);
      const windowsSources = {
        buildReportSha256: byteDigest(`${vm}/${profile}/build-report`),
        cacheVerificationReportSha256: byteDigest(`${vm}/${profile}/cache-verification-report`),
        environmentAttestationSha256: byteDigest(`${vm}/os-attestation`),
        packageReportSha256: byteDigest(`${vm}/${profile}/package-report`),
        runtimeReportSha256: byteDigest(`${vm}/${profile}/runtime-report`),
        testReportSha256: byteDigest(`${vm}/${profile}/test-report`),
        virtualNetworkAttestationSha256: byteDigest(`${vm}/virtual-network-attestation`),
        workspaceReportSha256: byteDigest(`${vm}/${profile}/workspace-report`),
      };
      await writeJson(path.join(proofEvidence, "windows", candidateId, vm, profile, "report.json"), {
        archiveSha256: archives.get(`windows-x86_64-msvc/${profile}`),
        buildIdentityDigest: windowsIdentity.buildIdentityDigest,
        buildOutputPathDigest: byteDigest(`${vm}/${profile}/build-output`),
        cache: {
          addressing: "sha256",
          cacheKey: `windows-x86_64-msvc/sha256/${windowsIdentity.toolchainClosureDigest.slice("sha256:".length)}`,
          injectedArtifactSha256: byteDigest("windows-cache"),
          objectVerification: "complete",
          pathDigest: byteDigest(`${vm}/cache-root`),
          toolchainClosureDigest: windowsIdentity.toolchainClosureDigest,
          unexpectedObjects: "rejected",
          verificationReportSha256: windowsSources.cacheVerificationReportSha256,
        },
        candidate,
        canaries,
        controller: {
          attestationSha256: byteDigest(`${vm}/controller-attestation`),
          executionChannel: "out-of-band",
          networkAuthority: "host-hypervisor",
          sourceReportsDigest: digest(windowsSources),
          status: "attested",
        },
        commands: {
          build: {
            buildExecuted: true, buildIdentityDigest: windowsIdentity.buildIdentityDigest,
            processIsolation: "blocked", reportSha256: windowsSources.buildReportSha256, status: "passed",
          },
          package: {
            buildIdentityDigest: windowsIdentity.buildIdentityDigest, processIsolation: "blocked",
            reportSha256: windowsSources.packageReportSha256, source: "local-build", status: "passed",
          },
          runtimeSmoke: {
            cpp: "passed", processIsolation: "blocked", reportSha256: windowsSources.runtimeReportSha256,
            source: "local-package", status: "passed", zig: "passed",
          },
          test: {
            buildIdentityDigest: windowsIdentity.buildIdentityDigest, processIsolation: "blocked",
            reportSha256: windowsSources.testReportSha256, status: "passed",
          },
          workspaceVerification: {
            processIsolation: "blocked", reportSha256: windowsSources.workspaceReportSha256, status: "passed",
          },
        },
        environment: {
          architecture: "AMD64", attestationSha256: windowsSources.environmentAttestationSha256, buildNumber: "26100",
          displayVersion: "24H2", product: "Windows 11",
        },
        processIsolation: { mode: "wfp-dynamic-app-id", scope: "locked-process-set", status: "blocked" },
        profile,
        schemaVersion: "1",
        sources: windowsSources,
        status: "success",
        target: "windows-x86_64-msvc",
        toolchainClosureDigest: windowsIdentity.toolchainClosureDigest,
        virtualNetwork: {
          attestationSha256: windowsSources.virtualNetworkAttestationSha256,
          configuredBy: "hypervisor",
          externalAdapters: "disconnected",
          status: "disconnected",
        },
        vm,
        vmIdentityDigest: byteDigest(`${vm}/vm-identity`),
        workspacePathDigest: byteDigest(`${vm}/workspace-root`),
      });
    }
  }
  return { candidate, candidateEvidence, candidateId, proofEvidence, verifiedVerdict };
}

test("candidate overlay replaces one baseline project by complete OID and publishes canonical evidence", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-candidate-"));
  const output = path.join(sandbox, "candidate");
  try {
    const result = invoke([
      "candidate",
      "--repository", repositoryRoot,
      "--baseline-revision", bootstrapRevision,
      "--replacement", `tsfg.git=${candidateRevision}`,
      "--out", output,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const overlay = JSON.parse(await readFile(path.join(output, "candidate-overlay.json"), "utf8"));
    const resolved = JSON.parse(await readFile(path.join(output, "resolved-manifest.json"), "utf8"));
    const summary = JSON.parse(await readFile(path.join(output, "candidate-summary.json"), "utf8"));
    const resolvedXml = await readFile(path.join(output, "resolved-manifest.xml"), "utf8");
    assert.deepEqual(overlay, {
      baseline: {
        manifest: "bootstrap/r00.xml",
        repository: "https://github.com/xuelongling/manifests.git",
        revision: bootstrapRevision,
      },
      replacements: [{ project: "tsfg.git", revision: candidateRevision }],
      schemaVersion: "1",
    });
    assert.equal(resolved.projects.find((project) => project.name === "tsfg.git").revision, candidateRevision);
    assert.match(resolvedXml, new RegExp(`name="tsfg\\.git"[\\s\\S]*revision="${candidateRevision}"`));
    assert.deepEqual(summary, {
      overlayDigest: digest(overlay),
      resolvedManifestDigest: digest(resolved),
      resolvedManifestXmlSha256: byteDigest(resolvedXml),
      schemaVersion: "1",
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manifest PR gate emits one content-addressed full-matrix candidate for a new resolved snapshot", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-gate-"));
  const output = path.join(sandbox, "evidence");
  const baseProduct = "1".repeat(40);
  const baseAgent = "2".repeat(40);
  const nextProduct = "3".repeat(40);
  try {
    const base = await initializeRepository(sandbox, manifest(baseProduct, baseAgent));
    await mkdir(path.join(sandbox, "snapshots"));
    await writeFile(
      path.join(sandbox, "snapshots", "tsfg-v0.1.0.xml"),
      manifest(nextProduct, baseAgent),
    );
    runGit(sandbox, "add", ".");
    runGit(sandbox, "commit", "-m", "candidate snapshot");
    const head = runGit(sandbox, "rev-parse", "HEAD");

    const result = invoke([
      "gate", "--repository", sandbox,
      "--base", base,
      "--head", head,
      "--out", output,
    ], sandbox);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(await readFile(path.join(output, "manifest-plan.json"), "utf8"));
    const candidateRoot = path.join(output, "candidates", plan.candidates[0].id);
    const overlay = JSON.parse(await readFile(path.join(candidateRoot, "candidate-overlay.json"), "utf8"));
    assert.equal(plan.schemaVersion, "1");
    assert.equal(plan.evidenceRetentionDays, "90");
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(plan.candidates[0], {
      agentChanged: false,
      agentRevision: baseAgent,
      baselineProductRevision: baseProduct,
      candidateOverlayDigest: digest(overlay),
      id: plan.candidates[0].id,
      manifest: "snapshots/tsfg-v0.1.0.xml",
      manifestRepository: "https://github.com/xuelongling/manifests.git",
      manifestRevision: head,
      productChanged: true,
      productRevision: nextProduct,
    });
    assert.match(plan.candidates[0].id, /^[0-9a-f]{64}$/);
    assert.deepEqual(overlay.replacements, [{ project: "tsfg.git", revision: nextProduct }]);
    assert.equal(
      JSON.parse(await readFile(path.join(candidateRoot, "resolved-manifest.json"), "utf8")).projects.length,
      2,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("candidate and gate seams reject overlays without an effective project revision change", async () => {
  const candidateSandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-noop-candidate-"));
  const gateSandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-noop-gate-"));
  try {
    const candidate = invoke([
      "candidate", "--repository", repositoryRoot, "--baseline-revision", bootstrapRevision,
      "--replacement", `tsfg.git=${bootstrapProductRevision}`, "--out", path.join(candidateSandbox, "evidence"),
    ]);
    assert.equal(candidate.status, 1);
    assert.match(candidate.stderr, /effective project revision change/i);

    const product = "1".repeat(40);
    const agent = "2".repeat(40);
    const base = await initializeRepository(gateSandbox, manifest(product, agent));
    await mkdir(path.join(gateSandbox, "snapshots"));
    await writeFile(path.join(gateSandbox, "snapshots", "tsfg-v0.1.0.xml"), manifest(product, agent));
    const head = commitAll(gateSandbox, "no-op candidate snapshot");
    const gate = invoke([
      "gate", "--repository", gateSandbox, "--base", base, "--head", head,
      "--out", path.join(gateSandbox, "evidence"),
    ], gateSandbox);
    assert.equal(gate.status, 1);
    assert.match(gate.stderr, /effective project revision change/i);
  } finally {
    await rm(candidateSandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(gateSandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manifest PR gate rejects snapshot modification, deletion, rename, and version identity reuse", async () => {
  const baseProduct = "1".repeat(40);
  const baseAgent = "2".repeat(40);
  const changedProduct = "3".repeat(40);
  for (const mutation of ["modify", "delete", "rename", "reuse"]) {
    const sandbox = await mkdtemp(path.join(tmpdir(), `tsfg-manifest-history-${mutation}-`));
    try {
      await initializeRepository(sandbox, manifest(baseProduct, baseAgent));
      await mkdir(path.join(sandbox, "snapshots"));
      const snapshot = path.join(sandbox, "snapshots", "tsfg-v0.1.0.xml");
      await writeFile(snapshot, manifest(baseProduct, baseAgent));
      let base = commitAll(sandbox, "publish snapshot");
      if (mutation === "reuse") {
        await rm(snapshot);
        base = commitAll(sandbox, "historically invalid deletion fixture");
        await writeFile(snapshot, manifest(changedProduct, baseAgent));
      } else if (mutation === "modify") {
        await writeFile(snapshot, manifest(changedProduct, baseAgent));
      } else if (mutation === "delete") {
        await rm(snapshot);
      } else {
        await mkdir(path.join(sandbox, "snapshots", "renamed"));
        await writeFile(path.join(sandbox, "snapshots", "renamed", "tsfg-v0.1.0.xml"), await readFile(snapshot));
        await rm(snapshot);
      }
      const head = commitAll(sandbox, mutation);
      const result = invoke([
        "gate", "--repository", sandbox,
        "--base", base,
        "--head", head,
        "--out", path.join(sandbox, "evidence"),
      ], sandbox);
      assert.equal(result.status, 1, `${mutation}: ${result.stderr}`);
      assert.match(result.stderr, /snapshot.*(?:immutable|identity)/i, mutation);
    } finally {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test("manifest PR gate keeps the Bootstrap Integration Snapshot immutable", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-bootstrap-history-"));
  try {
    const base = await initializeRepository(sandbox, manifest("1".repeat(40), "2".repeat(40)));
    await writeFile(
      path.join(sandbox, "bootstrap", "r00.xml"),
      manifest("3".repeat(40), "2".repeat(40)),
    );
    const head = commitAll(sandbox, "rewrite bootstrap");
    const result = invoke([
      "gate", "--repository", sandbox, "--base", base, "--head", head,
      "--out", path.join(sandbox, "evidence"),
    ], sandbox);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bootstrap Integration Snapshot.*immutable/i);
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("release tag policy rejects movement and deletion fixtures", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-tags-"));
  const beforePath = path.join(sandbox, "before.json");
  const afterPath = path.join(sandbox, "after.json");
  const output = path.join(sandbox, "tag-policy.json");
  const releaseOid = "1".repeat(40);
  try {
    await writeFile(beforePath, `${JSON.stringify({ "tsfg-v0.1.0": releaseOid })}\n`);
    for (const after of [{ "tsfg-v0.1.0": "2".repeat(40) }, {}]) {
      await writeFile(afterPath, `${JSON.stringify(after)}\n`);
      const rejected = invoke([
        "tag-policy", "--before", beforePath, "--after", afterPath, "--out", output,
      ]);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /release tag.*(?:move|delet)/i);
    }
    await writeFile(afterPath, `${JSON.stringify({ "tsfg-v0.1.0": releaseOid })}\n`);
    const accepted = invoke([
      "tag-policy", "--before", beforePath, "--after", afterPath, "--out", output,
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), {
      checkedReleaseTags: ["tsfg-v0.1.0"],
      schemaVersion: "1",
      status: "passed",
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manifest verdict requires every product and agent evidence lane before declaring Verified Candidate", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-verdict-"));
  const evidence = path.join(sandbox, "evidence");
  const productRevision = "3".repeat(40);
  const agentRevision = "2".repeat(40);
  const success = { schemaVersion: "1", status: "success" };
  try {
    const overlay = {
      baseline: { manifest: "bootstrap/r00.xml", repository: "https://github.com/xuelongling/manifests.git", revision: "1".repeat(40) },
      replacements: [{ project: "tsfg.git", revision: productRevision }], schemaVersion: "1",
    };
    const resolved = {
      baseline: overlay.baseline,
      projects: [
        { name: ".agents.git", path: ".agents", revision: agentRevision },
        { name: "tsfg.git", path: "tsfg", revision: productRevision },
      ], schemaVersion: "1",
    };
    const identity = digest(resolved).slice("sha256:".length);
    const candidate = {
      agentChanged: false,
      agentRevision,
      baselineProductRevision: "1".repeat(40),
      id: identity,
      manifest: "snapshots/tsfg-v0.1.0.xml",
      manifestRevision: "4".repeat(40),
      productChanged: true,
      productRevision,
    };
    await writeJson(path.join(evidence, "manifest-plan.json"), {
      candidates: [candidate], evidenceRetentionDays: "90", schemaVersion: "1",
    });
    const candidateRoot = path.join(evidence, "candidates", identity);
    await writeJson(path.join(candidateRoot, "candidate-overlay.json"), overlay);
    await writeJson(path.join(candidateRoot, "resolved-manifest.json"), resolved);
    await writeFile(path.join(candidateRoot, "resolved-manifest.xml"), manifest(productRevision, agentRevision));
    await writeJson(path.join(candidateRoot, "candidate-summary.json"), {
      overlayDigest: digest(overlay),
      resolvedManifestDigest: digest(resolved),
      resolvedManifestXmlSha256: byteDigest(manifest(productRevision, agentRevision)),
      schemaVersion: "1",
    });
    await writeJson(path.join(evidence, "agent", identity, "report.json"), {
      agentChanged: false,
      agentRevision,
      candidateId: identity,
      command: "corepack pnpm@11.25.0 verify",
      ...success,
    });
    await writeJson(path.join(evidence, "repository-gates", identity, "report.json"), {
      candidateId: identity,
      gates: { format: "passed", license: "passed", lock: "passed", policy: "passed" },
      productRevision,
      ...success,
    });
    await writeJson(path.join(evidence, "workspace", identity, "report.json"), workspaceReport(candidate, resolved));
    for (const target of ["linux-x86_64-gnu", "windows-x86_64-msvc"]) {
      await writeJson(path.join(evidence, "compatibility", identity, target, "report.json"), {
        command: "test",
        result: {
          contractSet: { canonical: "{}", id: byteDigest("{}") },
          compatibility: {
            artifacts: {
              baseline: { productOid: candidate.baselineProductRevision },
              candidate: { productOid: productRevision },
            },
            combinations: [
              { consumer: "baseline", producer: "baseline", status: "passed" },
              { consumer: "baseline", producer: "candidate", status: "passed" },
              { consumer: "candidate", producer: "baseline", status: "passed" },
              { consumer: "candidate", producer: "candidate", status: "passed" },
            ],
          },
          target,
        },
        ...success,
      });
      for (const profile of ["debug", "release"]) {
        const buildIdentityDigest = byteDigest(`${identity}/${target}/${profile}`);
        for (const producer of ["a", "b"]) {
          const root = path.join(evidence, "producers", identity, target, profile, producer);
          await writeJson(path.join(root, "workspace-report.json"), workspaceReport(candidate, resolved));
          for (const [command, file] of [["build", "build-report.json"], ["test", "test-report.json"]]) {
            await writeJson(path.join(root, file), {
              command,
              result: { buildIdentity: { digest: buildIdentityDigest }, profile, target },
              ...success,
            });
          }
          const archive = `tsfg-${target}-${profile}.archive`;
          await writeJson(path.join(root, "package-report.json"), {
            command: "package",
            result: { archive, buildIdentity: { digest: buildIdentityDigest, profile, target } },
            ...success,
          });
          await mkdir(path.join(root, "package"), { recursive: true });
          await writeFile(path.join(root, "package", archive), `${target}/${profile}\n`);
          await writeJson(path.join(root, "package", `${archive}.checksums.json`), { schemaVersion: "1" });
          await writeJson(path.join(root, "package", "producer-attestation.json"), {
            buildIdentityDigest,
            profile,
            producer,
            schemaVersion: "1",
            target,
          });
          await writeJson(path.join(root, "candidate-binding.json"), {
            buildIdentityDigest,
            candidateId: identity,
            productRevision,
            schemaVersion: "1",
          });
        }
        await writeJson(path.join(evidence, "reproducibility", identity, target, profile, "report.json"), {
          command: "repro-check", result: { buildExecuted: false, profile, producers: [{}, {}], target }, ...success,
        });
      }
    }
    const jobs = {
      "agent-ci": "success", "candidate-evidence": "success", compatibility: "success", "manifest-gate": "success",
      "product-build": "success", "repository-gates": "success", reproducibility: "success", "workspace-verification": "success",
    };
    const jobsPath = path.join(sandbox, "jobs.json");
    const output = path.join(sandbox, "verdict.json");
    await writeJson(jobsPath, jobs);
    const accepted = invoke([
      "verdict", "--evidence", evidence, "--job-results", jobsPath, "--out", output,
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
    const verdict = JSON.parse(await readFile(output, "utf8"));
    assert.equal(verdict.promotionState, "Verified Candidate");
    assert.equal(verdict.evidenceRetentionDays, "90");
    assert.equal(verdict.requiredEvidence.producers, "8/8");
    assert.equal(verdict.requiredEvidence.reproducibility, "4/4");
    assert.match(verdict.evidenceDigest, /^sha256:[0-9a-f]{64}$/);

    const compatibilityPath = path.join(evidence, "compatibility", identity, "linux-x86_64-gnu", "report.json");
    const foreignBaseline = JSON.parse(await readFile(compatibilityPath, "utf8"));
    foreignBaseline.result.compatibility.artifacts.baseline.productOid = "8".repeat(40);
    await writeJson(compatibilityPath, foreignBaseline);
    const foreignBaselineOutput = path.join(sandbox, "foreign-baseline.json");
    const foreignBaselineResult = invoke([
      "verdict", "--evidence", evidence, "--job-results", jobsPath, "--out", foreignBaselineOutput,
    ]);
    assert.equal(foreignBaselineResult.status, 1);
    assert.match(foreignBaselineResult.stderr, /candidate-bound compatibility matrix/i);
    await assert.rejects(readFile(foreignBaselineOutput));
    foreignBaseline.result.compatibility.artifacts.baseline.productOid = candidate.baselineProductRevision;
    await writeJson(compatibilityPath, foreignBaseline);

    const foreignWorkspace = workspaceReport(candidate, resolved);
    foreignWorkspace.result.projects.find((project) => project.id === "tsfg.git").head = "9".repeat(40);
    await writeJson(path.join(evidence, "workspace", identity, "report.json"), foreignWorkspace);
    const foreignOutput = path.join(sandbox, "foreign.json");
    const foreign = invoke([
      "verdict", "--evidence", evidence, "--job-results", jobsPath, "--out", foreignOutput,
    ]);
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /not bound to the resolved Candidate Overlay/i);
    await assert.rejects(readFile(foreignOutput));
    await writeJson(path.join(evidence, "workspace", identity, "report.json"), workspaceReport(candidate, resolved));

    const bindingPath = path.join(evidence, "producers", identity, "linux-x86_64-gnu", "debug", "a", "candidate-binding.json");
    await writeJson(bindingPath, {
      buildIdentityDigest: byteDigest(`${identity}/linux-x86_64-gnu/debug`),
      candidateId: "0".repeat(64),
      productRevision,
      schemaVersion: "1",
    });
    const foreignBindingOutput = path.join(sandbox, "foreign-binding.json");
    const foreignBinding = invoke([
      "verdict", "--evidence", evidence, "--job-results", jobsPath, "--out", foreignBindingOutput,
    ]);
    assert.equal(foreignBinding.status, 1);
    assert.match(foreignBinding.stderr, /not bound to the manifest candidate/i);
    await assert.rejects(readFile(foreignBindingOutput));

    await writeJson(jobsPath, { ...jobs, reproducibility: "cancelled" });
    const rejectedOutput = path.join(sandbox, "rejected.json");
    const rejected = invoke([
      "verdict", "--evidence", evidence, "--job-results", jobsPath, "--out", rejectedOutput,
    ]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /required job reproducibility did not succeed/);
    await assert.rejects(readFile(rejectedOutput));
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manifest verdict records a repository-only PR without claiming a verified candidate", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-no-candidate-"));
  const evidence = path.join(sandbox, "evidence");
  const jobsPath = path.join(sandbox, "jobs.json");
  const output = path.join(sandbox, "verdict.json");
  try {
    await writeJson(path.join(evidence, "manifest-plan.json"), {
      candidates: [], evidenceRetentionDays: "90", schemaVersion: "1",
    });
    await writeJson(jobsPath, {
      "agent-ci": "skipped", "candidate-evidence": "skipped", compatibility: "skipped",
      "manifest-gate": "success", "product-build": "skipped", "repository-gates": "skipped", reproducibility: "skipped",
      "workspace-verification": "skipped",
    });
    const result = invoke([
      "verdict", "--evidence", evidence, "--job-results", jobsPath, "--out", output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.status, "no-candidate");
    assert.equal(report.promotionState, undefined);
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("resolved manifests reject floating revisions, shallow clones, extra projects, copyfiles, and link injection", async () => {
  const product = "1".repeat(40);
  const agent = "2".repeat(40);
  const valid = manifest(product, agent);
  const variants = new Map([
    ["branch", valid.replace(`revision="${product}"`, 'revision="main"')],
    ["abbreviated oid", valid.replace(`revision="${product}"`, 'revision="1234567"')],
    ["clone depth", valid.replace('name="tsfg.git"', 'name="tsfg.git" clone-depth="1"')],
    ["extra project", manifest(product, agent, `<project name="llvm.git" path="llvm" remote="github-xuelongling" revision="${"3".repeat(40)}" upstream="refs/heads/main" />`)],
    ["copyfile", manifest(product, agent, '<copyfile src="payload" dest="payload" />')],
    ["product linkfile", valid.replace(
      `revision="${product}" upstream="refs/heads/main" />`,
      `revision="${product}" upstream="refs/heads/main"><linkfile src="payload" dest="payload" /></project>`,
    )],
    ["agent linkfile", valid.replace(
      "  </project>",
      '    <linkfile src="extra" dest="extra" />\n  </project>',
    )],
    ["nested project", valid.replace(
      `revision="${product}" upstream="refs/heads/main" />`,
      `revision="${product}" upstream="refs/heads/main"><project name="hidden.git" path="hidden" remote="github-xuelongling" revision="${"3".repeat(40)}" upstream="refs/heads/main" /></project>`,
    )],
  ]);
  for (const [name, candidateManifest] of variants) {
    const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-invalid-"));
    try {
      const base = await initializeRepository(sandbox, valid);
      await mkdir(path.join(sandbox, "snapshots"));
      await writeFile(path.join(sandbox, "snapshots", "tsfg-v0.1.0.xml"), candidateManifest);
      const head = commitAll(sandbox, name);
      const result = invoke([
        "gate", "--repository", sandbox, "--base", base, "--head", head,
        "--out", path.join(sandbox, "evidence"),
      ], sandbox);
      assert.equal(result.status, 1, `${name} unexpectedly passed`);
    } finally {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test("manifest PR gate rejects a shallow repository before trusting history", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-shallow-source-"));
  const clone = `${sandbox}-clone`;
  try {
    await initializeRepository(sandbox, manifest("1".repeat(40), "2".repeat(40)));
    const sourceUrl = `file:///${sandbox.replaceAll("\\", "/")}`;
    const cloned = spawnSync("git", ["clone", "--depth", "1", sourceUrl, clone], { encoding: "utf8" });
    assert.equal(cloned.status, 0, cloned.stderr);
    const head = runGit(clone, "rev-parse", "HEAD");
    const result = invoke([
      "gate", "--repository", clone, "--base", head, "--head", head,
      "--out", path.join(clone, "evidence"),
    ], clone);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /complete clone/i);
  } finally {
    await rm(clone, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("candidate baseline switches to a default that resolves to an immutable Stable snapshot", async () => {
  const product = "1".repeat(40);
  const agent = "2".repeat(40);
  for (const withSnapshot of [false, true]) {
    const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-stable-baseline-"));
    try {
      await initializeRepository(sandbox, manifest(product, agent));
      const stable = manifest(product, agent);
      await writeFile(path.join(sandbox, "default.xml"), stable);
      if (withSnapshot) {
        await mkdir(path.join(sandbox, "snapshots"));
        await writeFile(path.join(sandbox, "snapshots", "tsfg-v0.1.0.xml"), stable);
      }
      const baseline = commitAll(sandbox, "stable fixture");
      const output = path.join(sandbox, "candidate-evidence");
      const result = invoke([
        "candidate", "--repository", sandbox, "--baseline-revision", baseline,
        "--replacement", `tsfg.git=${"3".repeat(40)}`, "--out", output,
      ], sandbox);
      assert.equal(result.status, withSnapshot ? 0 : 1, result.stderr);
      if (withSnapshot) {
        assert.equal(
          JSON.parse(await readFile(path.join(output, "candidate-overlay.json"), "utf8")).baseline.manifest,
          "default.xml",
        );
      } else {
        assert.match(result.stderr, /default.*snapshot/i);
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test("manifest PR gate cannot create or drift the first Stable default in this milestone", async () => {
  const product = "1".repeat(40);
  const agent = "2".repeat(40);
  for (const mutation of ["create", "drift"]) {
    const sandbox = await mkdtemp(path.join(tmpdir(), `tsfg-manifest-default-${mutation}-`));
    try {
      await initializeRepository(sandbox, manifest(product, agent));
      if (mutation === "drift") {
        await mkdir(path.join(sandbox, "snapshots"));
        const stable = manifest(product, agent);
        await writeFile(path.join(sandbox, "snapshots", "tsfg-v0.1.0.xml"), stable);
        await writeFile(path.join(sandbox, "default.xml"), stable);
        commitAll(sandbox, "existing stable");
      }
      const base = runGit(sandbox, "rev-parse", "HEAD");
      await writeFile(path.join(sandbox, "default.xml"), manifest("3".repeat(40), agent));
      const head = commitAll(sandbox, `${mutation} default`);
      const result = invoke([
        "gate", "--repository", sandbox, "--base", base, "--head", head,
        "--out", path.join(sandbox, "evidence"),
      ], sandbox);
      assert.equal(result.status, 1, `${mutation} unexpectedly passed`);
      assert.match(result.stderr, /default\.xml.*(?:Stable|snapshot)/i);
    } finally {
      await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

test("candidate Stable baseline must be the repository's current default identity", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-current-stable-"));
  try {
    await initializeRepository(sandbox, manifest("1".repeat(40), "2".repeat(40)));
    await mkdir(path.join(sandbox, "snapshots"));
    const stable = manifest("1".repeat(40), "2".repeat(40));
    await writeFile(path.join(sandbox, "snapshots", "tsfg-v0.1.0.xml"), stable);
    await writeFile(path.join(sandbox, "default.xml"), stable);
    const historicalStable = commitAll(sandbox, "stable");
    await writeFile(path.join(sandbox, "README.md"), "newer manifest repository state\n");
    commitAll(sandbox, "advance current identity");
    runGit(sandbox, "checkout", "--detach", historicalStable);
    const result = invoke([
      "candidate", "--repository", sandbox, "--baseline-revision", historicalStable,
      "--replacement", `tsfg.git=${"3".repeat(40)}`, "--out", path.join(sandbox, "candidate"),
    ], sandbox);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /current Stable/i);
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("offline proof binds minimum Tier 1 VM evidence to one Verified Candidate", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-offline-proof-"));
  try {
    const fixture = await writeOfflineProofFixture(sandbox);
    const output = path.join(sandbox, "offline-proof.json");
    const result = invoke([
      "offline-proof",
      "--candidate-evidence", fixture.candidateEvidence,
      "--verified-verdict", fixture.verifiedVerdict,
      "--candidate-id", fixture.candidateId,
      "--proof-evidence", fixture.proofEvidence,
      "--out", output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(report.candidateIds, [fixture.candidateId]);
    assert.deepEqual(report.candidate, fixture.candidate);
    assert.deepEqual(report.builds.map(({ profile, target }) => ({ profile, target })), [
      { profile: "release", target: "linux-x86_64-gnu" },
      { profile: "release", target: "windows-x86_64-msvc" },
    ]);
    for (const build of report.builds) {
      assert.match(build.buildIdentityDigest, /^sha256:[0-9a-f]{64}$/);
      assert.match(build.toolchainClosureDigest, /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(report.proof, "Offline Proof");
    assert.equal(report.status, "success");
    assert.equal(report.requiredEvidence.hostedLinux, "2/2");
    assert.equal(report.requiredEvidence.linuxMinimumRuntime, "1/1");
    assert.equal(report.requiredEvidence.windowsIndependentVms, "2/2");
    assert.equal(report.requiredEvidence.windowsReplays, "2/2");
    assert.match(report.evidenceDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.promotionState, undefined);
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("offline proof rejects undeclared evidence fields instead of archiving ambient VM state", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-offline-proof-schema-"));
  try {
    const fixture = await writeOfflineProofFixture(sandbox);
    const windowsReportPath = path.join(
      fixture.proofEvidence, "windows", fixture.candidateId, "a", "release", "report.json",
    );
    const windowsReport = JSON.parse(await readFile(windowsReportPath, "utf8"));
    windowsReport.ambientEnvironment = { runnerLog: "must not be archived" };
    await writeJson(windowsReportPath, windowsReport);
    const output = path.join(sandbox, "offline-proof.json");
    const result = invoke([
      "offline-proof",
      "--candidate-evidence", fixture.candidateEvidence,
      "--verified-verdict", fixture.verifiedVerdict,
      "--candidate-id", fixture.candidateId,
      "--proof-evidence", fixture.proofEvidence,
      "--out", output,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /undeclared evidence field/i);
    await assert.rejects(readFile(output));
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("offline proof rejects a raw report that drifts from its Candidate Overlay identity", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-offline-proof-candidate-binding-"));
  try {
    const fixture = await writeOfflineProofFixture(sandbox);
    const linuxReportPath = path.join(
      fixture.proofEvidence, "linux-minimum", fixture.candidateId, "release", "report.json",
    );
    const linuxReport = JSON.parse(await readFile(linuxReportPath, "utf8"));
    linuxReport.candidate.candidateOverlayDigest = byteDigest("different Candidate Overlay");
    await writeJson(linuxReportPath, linuxReport);
    const output = path.join(sandbox, "offline-proof.json");
    const result = invoke([
      "offline-proof",
      "--candidate-evidence", fixture.candidateEvidence,
      "--verified-verdict", fixture.verifiedVerdict,
      "--candidate-id", fixture.candidateId,
      "--proof-evidence", fixture.proofEvidence,
      "--out", output,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exact Candidate Integration/i);
    await assert.rejects(readFile(output));
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("offline proof recomputes hosted canary source digests", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-offline-proof-canary-tamper-"));
  try {
    const fixture = await writeOfflineProofFixture(sandbox);
    const canaryPath = path.join(
      fixture.candidateEvidence, "hosted-offline", fixture.candidateId, "release", "a", "canary-before.json",
    );
    const canary = JSON.parse(await readFile(canaryPath, "utf8"));
    canary.canaries[0].status = "connected";
    await writeJson(canaryPath, canary);
    const verdict = JSON.parse(await readFile(fixture.verifiedVerdict, "utf8"));
    verdict.evidenceDigest = await treeDigest(fixture.candidateEvidence);
    await writeJson(fixture.verifiedVerdict, verdict);
    const output = path.join(sandbox, "offline-proof.json");
    const result = invoke([
      "offline-proof",
      "--candidate-evidence", fixture.candidateEvidence,
      "--verified-verdict", fixture.verifiedVerdict,
      "--candidate-id", fixture.candidateId,
      "--proof-evidence", fixture.proofEvidence,
      "--out", output,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /canary source is not bound/i);
    await assert.rejects(readFile(output));
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("offline proof rejects controller-attested source digests that drift from a VM command report", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-offline-proof-controller-sources-"));
  try {
    const fixture = await writeOfflineProofFixture(sandbox);
    const windowsReportPath = path.join(
      fixture.proofEvidence, "windows", fixture.candidateId, "a", "release", "report.json",
    );
    const report = JSON.parse(await readFile(windowsReportPath, "utf8"));
    report.sources.buildReportSha256 = byteDigest("different build report");
    report.controller.sourceReportsDigest = digest(report.sources);
    await writeJson(windowsReportPath, report);
    const output = path.join(sandbox, "offline-proof.json");
    const result = invoke([
      "offline-proof",
      "--candidate-evidence", fixture.candidateEvidence,
      "--verified-verdict", fixture.verifiedVerdict,
      "--candidate-id", fixture.candidateId,
      "--proof-evidence", fixture.proofEvidence,
      "--out", output,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source digests do not bind/i);
    await assert.rejects(readFile(output));
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("offline proof rejects Windows lanes that reuse another VM build output", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-offline-proof-reused-output-"));
  try {
    const fixture = await writeOfflineProofFixture(sandbox);
    const firstPath = path.join(fixture.proofEvidence, "windows", fixture.candidateId, "a", "release", "report.json");
    const secondPath = path.join(fixture.proofEvidence, "windows", fixture.candidateId, "b", "release", "report.json");
    const first = JSON.parse(await readFile(firstPath, "utf8"));
    const second = JSON.parse(await readFile(secondPath, "utf8"));
    second.buildOutputPathDigest = first.buildOutputPathDigest;
    await writeJson(secondPath, second);
    const output = path.join(sandbox, "offline-proof.json");
    const result = invoke([
      "offline-proof",
      "--candidate-evidence", fixture.candidateEvidence,
      "--verified-verdict", fixture.verifiedVerdict,
      "--candidate-id", fixture.candidateId,
      "--proof-evidence", fixture.proofEvidence,
      "--out", output,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /independent Windows VM build output/i);
    await assert.rejects(readFile(output));
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("offline proof rejects undeclared files in the controller evidence artifact", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "tsfg-manifest-offline-proof-extra-file-"));
  try {
    const fixture = await writeOfflineProofFixture(sandbox);
    await writeFile(path.join(fixture.proofEvidence, "controller.log"), "must not be archived\n");
    const output = path.join(sandbox, "offline-proof.json");
    const result = invoke([
      "offline-proof",
      "--candidate-evidence", fixture.candidateEvidence,
      "--verified-verdict", fixture.verifiedVerdict,
      "--candidate-id", fixture.candidateId,
      "--proof-evidence", fixture.proofEvidence,
      "--out", output,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /undeclared proof evidence file/i);
    await assert.rejects(readFile(output));
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
