// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../tools/manifest-ci.mjs", import.meta.url));
const candidateName = "candidates/tsfg-v0.2.0.xml";
function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function init(root) {
  await mkdir(root, { recursive: true });
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Source admission fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
}
function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
function invoke(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}
async function fixture(root) {
  const upstream = path.join(root, "source");
  await init(upstream);
  await writeFile(path.join(upstream, "LICENSE"), "Original MIT license and Copyright upstream\n");
  await writeFile(path.join(upstream, "NOTICE"), "Original upstream notice\n");
  const baseOid = commit(upstream, "upstream base");
  git(upstream, "checkout", "-b", "tsfg/intake");
  await writeFile(path.join(upstream, "parser.txt"), "fixture modified source\n");
  const forkOid = commit(upstream, "fork change");
  const files = await Promise.all(["LICENSE", "NOTICE", "parser.txt"].map(async (name) => ({
    contentKind: "text", path: name,
    sha256: `sha256:${createHash("sha256").update(await readFile(path.join(upstream, name))).digest("hex")}`,
  })));
  const admission = { schemaVersion: "1", sources: [{
    projectId: "Fixture.git", path: "fixture", remoteUrl: "https://github.com/xuelongling/Fixture.git",
    canonicalUrl: "https://github.com/upstream/Fixture.git", baseOid, forkOid, branch: "refs/heads/tsfg/intake",
    license: "MIT", files, legal: { license: "LICENSE", notice: "NOTICE", copyright: "LICENSE" },
  }] };
  const repository = path.join(root, "manifests");
  await init(repository);
  await mkdir(path.join(repository, "bootstrap"));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<manifest>
  <remote name="github-xuelongling" fetch="https://github.com/xuelongling/" />
  <project name="tsfg.git" path="tsfg" remote="github-xuelongling" revision="${baseOid}" upstream="refs/heads/main" />
  <project name=".agents.git" path=".agents" remote="github-xuelongling" revision="${baseOid}" upstream="refs/heads/main">
    <linkfile src="AGENTS.md" dest="AGENTS.md" />
    <linkfile src="codex/config.toml" dest=".codex/config.toml" />
    <linkfile src="codex/hooks.json" dest=".codex/hooks.json" />
  </project>
</manifest>\n`;
  await writeFile(path.join(repository, "bootstrap/r00.xml"), xml);
  const base = commit(repository, "legacy bootstrap fixture");
  await mkdir(path.join(repository, "candidates"));
  const candidateXml = xml.replace("</manifest>", `  <project name="Fixture.git" path="fixture" remote="github-xuelongling" revision="${forkOid}" upstream="refs/heads/tsfg/intake" />\n</manifest>`);
  await writeFile(path.join(repository, candidateName), candidateXml);
  await writeFile(path.join(repository, `${candidateName}.sources.json`), JSON.stringify(admission));
  const head = commit(repository, "versioned source combination fixture");
  return { admission, base, candidateXml, head, repository };
}

test("manifest gate admits a declared versioned source combination without turning additions into overlay replacements", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-source-admission-"));
  try {
    const input = await fixture(root);
    const output = path.join(root, "evidence");
    const result = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", input.head, "--out", output);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(await readFile(path.join(output, "manifest-plan.json"), "utf8"));
    assert.equal(plan.candidates.length, 1);
    const candidateRoot = path.join(output, "candidates", plan.candidates[0].id);
    const resolved = JSON.parse(await readFile(path.join(candidateRoot, "resolved-manifest.json"), "utf8"));
    assert.equal(resolved.schemaVersion, "2");
    assert.deepEqual(resolved.sourceAdmission, input.admission);
    assert.equal(resolved.projects.length, 3);
    assert.deepEqual(JSON.parse(await readFile(path.join(candidateRoot, "candidate-overlay.json"), "utf8")).replacements, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manifest gate rejects unrecognized source licenses", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-source-license-"));
  try {
    const input = await fixture(root);
    input.admission.sources[0].license = "Unreviewed-License";
    await writeFile(path.join(input.repository, `${candidateName}.sources.json`), JSON.stringify(input.admission));
    const head = commit(input.repository, "unknown source license");
    const result = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", head, "--out", path.join(root, "evidence"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /license/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("source additions require a versioned candidate path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-source-version-"));
  try {
    const input = await fixture(root);
    await writeFile(path.join(input.repository, "candidates/unversioned.xml"), input.candidateXml);
    const head = commit(input.repository, "unversioned addition");
    const result = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", head, "--out", path.join(root, "evidence"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /version|candidate path/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("source combinations reject undeclared repo project attributes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-source-attributes-"));
  try {
    const input = await fixture(root);
    await writeFile(path.join(input.repository, candidateName), input.candidateXml.replace('name="Fixture.git"', 'name="Fixture.git" force-path="true"'));
    const head = commit(input.repository, "undeclared project behavior");
    const result = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", head, "--out", path.join(root, "evidence"));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /attribute/i);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manifest gate rejects unsafe or incomplete source admission records", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-source-shape-"));
  try {
    const input = await fixture(root);
    const mutations = [
      (source) => { source.path = "../escape"; },
      (source) => { source.files[0].path = "NUL.txt"; },
      (source) => { source.files[0].sha256 = "short"; },
      (source) => { delete source.legal.notice; },
      (source) => { source.legal.license = "missing.txt"; },
      (source) => { source.remoteUrl = "https://example.invalid/Fixture.git"; },
      (source) => { source.baseOid = "main"; },
      (source) => { source.branch = "refs/tags/float"; },
      (source) => { source.files[0].contentKind = "unknown"; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const admission = structuredClone(input.admission);
      mutate(admission.sources[0]);
      await writeFile(path.join(input.repository, `${candidateName}.sources.json`), JSON.stringify(admission));
      const head = commit(input.repository, `invalid source record ${index}`);
      const result = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", head, "--out", path.join(root, `evidence-${index}`));
      assert.equal(result.status, 1, `mutation ${index}: ${result.stderr}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("manifest gate consumes candidate-bound source policy evidence without claiming source intake", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tsfg-source-report-"));
  try {
    const input = await fixture(root);
    const output = path.join(root, "plan");
    const planned = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", input.head, "--out", output);
    assert.equal(planned.status, 0, planned.stderr);
    const plan = JSON.parse(await readFile(path.join(output, "manifest-plan.json"), "utf8"));
    const resolved = JSON.parse(await readFile(path.join(output, "candidates", plan.candidates[0].id, "resolved-manifest.json"), "utf8"));
    const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
        : JSON.stringify(value);
    const report = {
      schemaVersion: "1", command: "verify-workspace", status: "success", result: {
        manifest: { repositoryUrl: "https://github.com/xuelongling/manifests.git", revision: input.head, selected: candidateName },
        projects: resolved.projects.map((project) => ({ id: project.name, path: project.path, head: project.revision, dirty: false, remote: `https://github.com/xuelongling/${project.name}` })),
        activation: [
          ["AGENTS.md", "AGENTS.md"], ["codex/config.toml", ".codex/config.toml"], ["codex/hooks.json", ".codex/hooks.json"],
        ].map(([source, destination]) => ({ source: `.agents/${source}`, destination, type: "symbolic-link", sha256: `sha256:${"a".repeat(64)}` })),
        policy: {
          upstreamForks: input.admission.sources,
          sourceAdmission: {
            schemaVersion: "1", digest: `sha256:${createHash("sha256").update(canonical(input.admission)).digest("hex")}`,
            sources: input.admission.sources, stages: { sourcePolicy: "passed", generation: "not-run", build: "not-run", interface: "not-run", jsIsolation: "not-run", reproducibility: "not-run" }, intakeComplete: false,
          },
        },
      },
    };
    const reportPath = path.join(root, "workspace-report.json");
    await writeFile(reportPath, JSON.stringify(report));
    const result = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", input.head, "--workspace-report", reportPath, "--out", path.join(root, "verified"));
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(path.join(root, "verified", "source-policy-verification.json"), "utf8"));
    assert.equal(evidence.intakeComplete, false);
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.stages.build, "not-run");
    const mutations = [
      (value) => { value.result.projects[0].remote = "https://example.invalid/wrong.git"; },
      (value) => { value.result.projects[0].dirty = true; },
      (value) => { value.result.activation[0].type = "copy"; },
      (value) => { value.result.activation.pop(); },
      (value) => { value.result.policy.sourceAdmission.stages.build = "passed"; },
      (value) => { delete value.result.policy.sourceAdmission; },
      (value) => { value.result.policy.sourceAdmission.digest = `sha256:${"0".repeat(64)}`; },
      (value) => { value.result.policy.upstreamForks = []; },
      (value) => { value.result.policy.sourceAdmission.sources = []; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const altered = structuredClone(report);
      mutate(altered);
      await writeFile(reportPath, JSON.stringify(altered));
      const rejected = invoke("gate", "--repository", input.repository, "--base", input.base, "--head", input.head, "--workspace-report", reportPath, "--out", path.join(root, `rejected-${index}`));
      assert.equal(rejected.status, 1, `report mutation ${index}: ${rejected.stderr}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
