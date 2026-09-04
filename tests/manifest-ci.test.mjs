// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestCi = path.join(repositoryRoot, "tools", "manifest-ci.mjs");
const bootstrapRevision = "d94f4e6bff9aa980b18b0df94e133559e4b61240";
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
    assert.equal(plan.schemaVersion, "1");
    assert.equal(plan.evidenceRetentionDays, "90");
    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(plan.candidates[0], {
      agentChanged: false,
      agentRevision: baseAgent,
      id: plan.candidates[0].id,
      manifest: "snapshots/tsfg-v0.1.0.xml",
      manifestRevision: head,
      productChanged: true,
      productRevision: nextProduct,
    });
    assert.match(plan.candidates[0].id, /^[0-9a-f]{16}$/);
    const candidateRoot = path.join(output, "candidates", plan.candidates[0].id);
    const overlay = JSON.parse(await readFile(path.join(candidateRoot, "candidate-overlay.json"), "utf8"));
    assert.deepEqual(overlay.replacements, [{ project: "tsfg.git", revision: nextProduct }]);
    assert.equal(
      JSON.parse(await readFile(path.join(candidateRoot, "resolved-manifest.json"), "utf8")).projects.length,
      2,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    const identity = digest(resolved).slice("sha256:".length, "sha256:".length + 16);
    const candidate = {
      agentChanged: false,
      agentRevision,
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
    await writeJson(path.join(evidence, "agent", identity, "report.json"), success);
    await writeJson(path.join(evidence, "workspace", identity, "report.json"), { command: "verify-workspace", ...success });
    for (const target of ["linux-x86_64-gnu", "windows-x86_64-msvc"]) {
      await writeJson(path.join(evidence, "compatibility", identity, target, "report.json"), { command: "test", ...success });
      for (const profile of ["debug", "release"]) {
        for (const producer of ["a", "b"]) {
          const root = path.join(evidence, "producers", identity, target, profile, producer);
          await writeJson(path.join(root, "build-report.json"), { command: "build", ...success });
          await writeJson(path.join(root, "test-report.json"), { command: "test", ...success });
          await writeJson(path.join(root, "package-report.json"), { command: "package", ...success });
        }
        await writeJson(path.join(evidence, "reproducibility", identity, target, profile, "report.json"), {
          command: "repro-check", result: { buildExecuted: false }, ...success,
        });
      }
    }
    const jobs = {
      "agent-ci": "success", "candidate-evidence": "success", compatibility: "success", "manifest-gate": "success",
      "product-build": "success", reproducibility: "success", "workspace-verification": "success",
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
      "manifest-gate": "success", "product-build": "skipped", reproducibility: "skipped",
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
