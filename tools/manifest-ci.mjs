// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const manifestRepositoryUrl = "https://github.com/xuelongling/manifests.git";
const bootstrapRevision = "d94f4e6bff9aa980b18b0df94e133559e4b61240";
const completeOid = /^[0-9a-f]{40}$/;

class ManifestCiError extends Error {}

function parseOptions(arguments_, allowed, repeatable = new Set()) {
  const options = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!allowed.has(name) || !value || (!repeatable.has(name) && options.has(name))) {
      throw new ManifestCiError(`invalid option: ${name ?? "<missing>"}`);
    }
    if (repeatable.has(name)) options.set(name, [...(options.get(name) ?? []), value]);
    else options.set(name, value);
  }
  return options;
}

function required(options, name) {
  const value = options.get(name);
  if (!value) throw new ManifestCiError(`missing required option: ${name}`);
  return value;
}

function requireOid(value, label) {
  if (!completeOid.test(value)) throw new ManifestCiError(`${label} must be a complete lowercase commit OID`);
  return value;
}

function git(repository, arguments_, allowFailure = false) {
  const result = spawnSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    throw new ManifestCiError((result.stderr || result.stdout || "git command failed").trim());
  }
  return result;
}

function gitFile(repository, revision, filePath, allowMissing = false) {
  const result = git(repository, ["show", `${revision}:${filePath}`], allowMissing);
  if (result.status !== 0) return undefined;
  return result.stdout;
}

function parseAttributes(source, label) {
  const values = new Map();
  let rest = source;
  while (rest.length > 0) {
    if (rest.trim() === "") break;
    const match = /^\s+([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/.exec(rest);
    if (!match) throw new ManifestCiError(`${label} contains invalid XML attributes`);
    if (values.has(match[1])) throw new ManifestCiError(`${label} contains a duplicate ${match[1]} attribute`);
    values.set(match[1], match[2]);
    rest = rest.slice(match[0].length);
  }
  return values;
}

function parseManifestElements(xml, label) {
  const nodes = [];
  const stack = [];
  const token = /<[^>]*>|[^<]+/g;
  let cursor = 0;
  for (const match of xml.matchAll(token)) {
    if (match.index !== cursor) throw new ManifestCiError(`${label} is not well-formed XML`);
    cursor += match[0].length;
    const value = match[0];
    if (!value.startsWith("<")) {
      if (value.trim() !== "") throw new ManifestCiError(`${label} contains unexpected XML text`);
      continue;
    }
    if (/^<\?xml\s+version="1\.0"\s+encoding="UTF-8"\?>$/.test(value) && nodes.length === 0 && stack.length === 0) continue;
    if (/^<\//.test(value)) {
      const closing = /^<\/([A-Za-z][A-Za-z0-9_-]*)\s*>$/.exec(value);
      if (!closing || stack.at(-1)?.name !== closing[1]) throw new ManifestCiError(`${label} has mismatched XML elements`);
      stack.pop();
      continue;
    }
    const opening = /^<([A-Za-z][A-Za-z0-9_-]*)([\s\S]*?)(\/?)>$/.exec(value);
    if (!opening) throw new ManifestCiError(`${label} contains unsupported XML syntax`);
    const node = {
      attributes: parseAttributes(opening[2], `${label} ${opening[1]}`),
      children: [],
      name: opening[1],
      rawOpening: value,
      selfClosing: opening[3] === "/",
    };
    if (stack.length === 0) nodes.push(node);
    else stack.at(-1).children.push(node);
    if (!node.selfClosing) stack.push(node);
  }
  if (cursor !== xml.length || stack.length !== 0 || nodes.length !== 1 || nodes[0].name !== "manifest") {
    throw new ManifestCiError(`${label} must contain one complete manifest root`);
  }
  return nodes[0];
}

function projectsFromManifest(root) {
  const projects = [];
  for (const node of root.children.filter((entry) => entry.name === "project")) {
    const values = node.attributes;
    const name = values.get("name");
    const projectPath = values.get("path");
    const revision = values.get("revision");
    if (!name || !projectPath || !revision) {
      throw new ManifestCiError("every manifest project requires name, path, and revision");
    }
    requireOid(revision, `${name} revision`);
    projects.push({ name, path: projectPath, revision });
  }
  if (projects.length === 0) throw new ManifestCiError("manifest contains no projects");
  return projects;
}

function validateManifest(xml, label) {
  const root = parseManifestElements(xml, label);
  const permittedRootChildren = new Set(["remote", "project"]);
  const unsupported = root.children.find((entry) => !permittedRootChildren.has(entry.name));
  if (unsupported) throw new ManifestCiError(`${label} contains forbidden ${unsupported.name}`);
  const remoteNodes = root.children.filter((entry) => entry.name === "remote");
  if (remoteNodes.length !== 1 || !remoteNodes[0].selfClosing || remoteNodes[0].children.length !== 0) {
    throw new ManifestCiError(`${label} must declare exactly one self-closing remote`);
  }
  const remote = remoteNodes[0].attributes;
  if (remote.get("name") !== "github-xuelongling" || remote.get("fetch") !== "https://github.com/xuelongling/") {
    throw new ManifestCiError(`${label} must use the canonical xuelongling remote`);
  }
  const projectNodes = root.children.filter((entry) => entry.name === "project");
  const projects = projectsFromManifest(root);
  const expected = new Map([
    ["tsfg.git", "tsfg"],
    [".agents.git", ".agents"],
  ]);
  if (projects.length !== expected.size) throw new ManifestCiError(`${label} contains an extra or missing R00 project`);
  const names = new Set();
  const paths = new Set();
  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    const values = projectNodes[index].attributes;
    if (names.has(project.name) || paths.has(project.path)) throw new ManifestCiError(`${label} project names and paths must be unique`);
    names.add(project.name);
    paths.add(project.path);
    if (expected.get(project.name) !== project.path) throw new ManifestCiError(`${label} contains an extra or non-canonical R00 project`);
    if (values.get("remote") !== "github-xuelongling" || values.get("upstream") !== "refs/heads/main") {
      throw new ManifestCiError(`${label} project ${project.name} must use the canonical remote and main fetch hint`);
    }
    if (values.has("clone-depth")) throw new ManifestCiError(`${label} must not request a shallow clone`);
    if (projectNodes[index].children.some((entry) => entry.name !== "linkfile" || !entry.selfClosing || entry.children.length !== 0)) {
      throw new ManifestCiError(`${label} project ${project.name} contains a forbidden nested element`);
    }
    const links = projectNodes[index].children.map((entry) => entry.attributes);
    if (project.name === "tsfg.git" && links.length !== 0) {
      throw new ManifestCiError(`${label} only permits linkfile entries on .agents.git`);
    }
    if (project.name === ".agents.git") {
      const actual = links.map((link) => `${link.get("src")}|${link.get("dest")}`).sort();
      const requiredLinks = [
        "AGENTS.md|AGENTS.md",
        "codex/config.toml|.codex/config.toml",
        "codex/hooks.json|.codex/hooks.json",
      ].sort();
      if (canonicalize(actual) !== canonicalize(requiredLinks)) {
        throw new ManifestCiError(`${label} does not declare the exact Agent Activation Surface`);
      }
    }
  }
  return projects;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new ManifestCiError("manifest evidence contains a non-I-JSON value");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function byteDigest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

async function publishDirectory(destination, files) {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(destination)}.${randomUUID()}.tmp`);
  await mkdir(staging);
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const filePath = path.join(staging, ...name.split("/"));
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes, { flag: "wx" });
    }
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function manifestPaths(repository, revision) {
  const result = git(repository, ["ls-tree", "-r", "--name-only", revision]);
  return result.stdout.split(/\r?\n/).filter((entry) =>
    entry === "bootstrap/r00.xml" || entry === "default.xml" || /^snapshots\/tsfg-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.xml$/.test(entry));
}

function requireDefaultSnapshot(repository, revision, defaultXml) {
  const resolvesToSnapshot = manifestPaths(repository, revision)
    .filter((entry) => entry.startsWith("snapshots/"))
    .some((entry) => gitFile(repository, revision, entry) === defaultXml);
  if (!resolvesToSnapshot) {
    throw new ManifestCiError("default.xml must resolve exactly to an immutable versioned snapshot");
  }
}

function changedManifestPaths(repository, base, head) {
  const result = git(repository, ["diff", "--name-only", `${base}..${head}`]);
  return result.stdout.split(/\r?\n/).filter((entry) =>
    entry === "bootstrap/r00.xml" || entry === "default.xml" || entry.startsWith("snapshots/"));
}

function snapshotTree(repository, revision) {
  const result = git(repository, ["ls-tree", "-r", revision, "--", "snapshots"]);
  const entries = new Map();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = /^(\d+)\s+blob\s+([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!match) throw new ManifestCiError("cannot inspect snapshot history");
    entries.set(match[3].replaceAll("\\", "/"), `${match[1]} ${match[2]}`);
  }
  return entries;
}

function enforceSnapshotHistory(repository, base, head) {
  const before = snapshotTree(repository, base);
  const after = snapshotTree(repository, head);
  for (const [snapshotPath, identity] of before) {
    if (after.get(snapshotPath) !== identity) {
      throw new ManifestCiError(`snapshot is immutable and must not be modified, deleted, or renamed: ${snapshotPath}`);
    }
  }
  const history = git(repository, ["log", "--format=", "--name-only", base, "--", "snapshots"])
    .stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
  const historicalPaths = new Set(history);
  for (const snapshotPath of after.keys()) {
    if (!before.has(snapshotPath) && historicalPaths.has(snapshotPath)) {
      throw new ManifestCiError(`snapshot version identity must not be reused: ${snapshotPath}`);
    }
  }
}

function enforceBootstrapHistory(repository, base, head) {
  const before = git(repository, ["rev-parse", `${base}:bootstrap/r00.xml`], true);
  if (before.status === 0) {
    const after = git(repository, ["rev-parse", `${head}:bootstrap/r00.xml`], true);
    if (after.status !== 0 || after.stdout.trim() !== before.stdout.trim()) {
      throw new ManifestCiError("the Bootstrap Integration Snapshot is immutable");
    }
  }
}

function resolvedIdentity(baseline, baselineProjects, manifestXml, manifestName, manifestRevision) {
  const projects = validateManifest(manifestXml, manifestName)
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const replacements = projects
    .filter((project) => baselineProjects.find((entry) => entry.name === project.name)?.revision !== project.revision)
    .map(({ name: project, revision }) => ({ project, revision }));
  const overlay = { baseline, replacements, schemaVersion: "1" };
  const resolved = { baseline, projects, schemaVersion: "1" };
  const summary = {
    overlayDigest: digest(overlay),
    resolvedManifestDigest: digest(resolved),
    resolvedManifestXmlSha256: byteDigest(manifestXml),
    schemaVersion: "1",
  };
  return {
    files: {
      "candidate-overlay.json": jsonBytes(overlay),
      "candidate-summary.json": jsonBytes(summary),
      "resolved-manifest.json": jsonBytes(resolved),
      "resolved-manifest.xml": Buffer.from(manifestXml),
    },
    plan: {
      agentChanged: replacements.some((entry) => entry.project === ".agents.git"),
      agentRevision: projects.find((entry) => entry.name === ".agents.git").revision,
      id: summary.resolvedManifestDigest.slice("sha256:".length),
      manifest: manifestName,
      manifestRevision,
      productChanged: replacements.some((entry) => entry.project === "tsfg.git"),
      productRevision: projects.find((entry) => entry.name === "tsfg.git").revision,
    },
  };
}

async function gate(options) {
  const repository = path.resolve(required(options, "--repository"));
  const base = requireOid(required(options, "--base"), "base revision");
  const head = requireOid(required(options, "--head"), "head revision");
  const output = path.resolve(required(options, "--out"));
  if (git(repository, ["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false") {
    throw new ManifestCiError("Manifest Repository must be a complete clone");
  }
  if (git(repository, ["merge-base", base, head]).stdout.trim() !== base) {
    throw new ManifestCiError("base revision must be an ancestor of head revision");
  }
  enforceBootstrapHistory(repository, base, head);
  enforceSnapshotHistory(repository, base, head);
  const treePaths = git(repository, ["ls-tree", "-r", "--name-only", head]).stdout.split(/\r?\n/).filter(Boolean);
  for (const snapshotPath of treePaths.filter((entry) => entry.startsWith("snapshots/"))) {
    if (!/^snapshots\/tsfg-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.xml$/.test(snapshotPath)) {
      throw new ManifestCiError(`snapshot version identity has an invalid path: ${snapshotPath}`);
    }
  }
  for (const manifestPath of manifestPaths(repository, head)) {
    validateManifest(gitFile(repository, head, manifestPath), manifestPath);
  }

  const hasPublishedBootstrap = git(repository, ["cat-file", "-e", `${bootstrapRevision}^{commit}`], true).status === 0;
  const defaultXml = gitFile(repository, base, "default.xml", true);
  const headDefaultXml = gitFile(repository, head, "default.xml", true);
  if (defaultXml === undefined && headDefaultXml !== undefined) {
    throw new ManifestCiError("default.xml first Stable promotion is outside this milestone");
  }
  if (defaultXml !== undefined) {
    if (headDefaultXml === undefined) throw new ManifestCiError("default.xml must continue to resolve to the current Stable snapshot");
    requireDefaultSnapshot(repository, base, defaultXml);
    requireDefaultSnapshot(repository, head, headDefaultXml);
  }
  const baselineRevision = defaultXml === undefined && hasPublishedBootstrap ? bootstrapRevision : base;
  const baselineManifest = defaultXml === undefined ? "bootstrap/r00.xml" : "default.xml";
  const baselineXml = gitFile(repository, baselineRevision, baselineManifest);
  const baselineProjects = validateManifest(baselineXml, baselineManifest);
  const baseline = {
    manifest: baselineManifest,
    repository: manifestRepositoryUrl,
    revision: baselineRevision,
  };
  const files = {};
  const candidates = [];
  for (const manifestPath of changedManifestPaths(repository, base, head)) {
    const xml = gitFile(repository, head, manifestPath, true);
    if (xml === undefined) continue;
    const identity = resolvedIdentity(baseline, baselineProjects, xml, manifestPath, head);
    candidates.push(identity.plan);
    for (const [name, bytes] of Object.entries(identity.files)) {
      files[`candidates/${identity.plan.id}/${name}`] = bytes;
    }
  }
  candidates.sort((left, right) => Buffer.from(left.manifest).compare(Buffer.from(right.manifest)));
  files["manifest-plan.json"] = jsonBytes({
    candidates,
    evidenceRetentionDays: "90",
    schemaVersion: "1",
  });
  await publishDirectory(output, files);
}

async function readTagMap(filePath, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    throw new ManifestCiError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ManifestCiError(`${label} must be an object`);
  for (const [tag, revision] of Object.entries(value)) {
    if (!/^tsfg-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new ManifestCiError(`invalid release tag: ${tag}`);
    requireOid(revision, `${tag} revision`);
  }
  return value;
}

async function atomicWrite(destination, bytes) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, destination);
}

async function tagPolicy(options) {
  const before = await readTagMap(required(options, "--before"), "before tag map");
  const after = await readTagMap(required(options, "--after"), "after tag map");
  for (const [tag, revision] of Object.entries(before)) {
    if (!(tag in after)) throw new ManifestCiError(`release tag deletion is forbidden: ${tag}`);
    if (after[tag] !== revision) throw new ManifestCiError(`release tag movement is forbidden: ${tag}`);
  }
  const output = path.resolve(required(options, "--out"));
  await atomicWrite(output, jsonBytes({
    checkedReleaseTags: Object.keys(before).sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    schemaVersion: "1",
    status: "passed",
  }));
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new ManifestCiError(`${label} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireSuccess(report, label, command) {
  if (report?.schemaVersion !== "1" || report.status !== "success") {
    throw new ManifestCiError(`${label} is not a successful version 1 report`);
  }
  if (command && report.command !== command) throw new ManifestCiError(`${label} does not report ${command}`);
}

function requireResolvedWorkspace(report, resolved, candidatePlan, label) {
  requireSuccess(report, label, "verify-workspace");
  const byId = (left, right) => Buffer.from(left.id).compare(Buffer.from(right.id));
  const expectedProjects = resolved.projects.map(({ name, path: projectPath, revision }) => ({
    dirty: false,
    head: revision,
    id: name,
    path: projectPath,
  })).sort(byId);
  const actualProjects = report.result?.projects?.map(({ dirty, head, id, path: projectPath }) => ({
    dirty,
    head,
    id,
    path: projectPath,
  })).sort(byId);
  const actualManifest = report.result?.manifest;
  if (
    !Array.isArray(actualProjects) || canonicalize(actualProjects) !== canonicalize(expectedProjects) ||
    actualManifest?.repositoryUrl !== resolved.baseline.repository ||
    actualManifest?.revision !== candidatePlan.manifestRevision ||
    actualManifest?.selected !== candidatePlan.manifest
  ) {
    throw new ManifestCiError(`${label} is not bound to the resolved Candidate Overlay`);
  }
  return report;
}

function requireCompatibility(report, candidatePlan, target, label) {
  requireSuccess(report, label, "test");
  const expected = [
    ["baseline", "baseline"],
    ["candidate", "baseline"],
    ["baseline", "candidate"],
    ["candidate", "candidate"],
  ];
  const combinations = report.result?.compatibility?.combinations;
  if (
    report.result?.target !== target ||
    report.result?.compatibility?.artifacts?.candidate?.productOid !== candidatePlan.productRevision ||
    report.result?.contractSet?.canonical !== "{}" ||
    report.result?.contractSet?.id !== byteDigest("{}") ||
    !Array.isArray(combinations) ||
    expected.some(([producer, consumer], index) =>
      combinations[index]?.producer !== producer ||
      combinations[index]?.consumer !== consumer ||
      combinations[index]?.status !== "passed")
  ) {
    throw new ManifestCiError(`${label} does not contain the complete candidate-bound compatibility matrix`);
  }
}

async function evidenceFiles(root, current = "") {
  const directory = path.join(root, ...current.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await evidenceFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new ManifestCiError(`evidence entry must be a regular file: ${relative}`);
  }
  return files;
}

async function verdict(options) {
  const root = path.resolve(required(options, "--evidence"));
  const jobs = await readJson(path.resolve(required(options, "--job-results")), "required job results");
  const output = path.resolve(required(options, "--out"));
  const plan = await readJson(path.join(root, "manifest-plan.json"), "manifest plan");
  if (plan?.schemaVersion !== "1" || plan.evidenceRetentionDays !== "90" || !Array.isArray(plan.candidates)) {
    throw new ManifestCiError("manifest plan is invalid");
  }
  const requiredJobs = [
    "manifest-gate", "agent-ci", "workspace-verification", "product-build",
    "repository-gates", "compatibility", "reproducibility", "candidate-evidence",
  ];
  if (plan.candidates.length === 0) {
    if (jobs?.["manifest-gate"] !== "success") throw new ManifestCiError("required job manifest-gate did not succeed");
    for (const job of requiredJobs.filter((entry) => entry !== "manifest-gate")) {
      if (jobs?.[job] !== "skipped") throw new ManifestCiError(`job ${job} must be skipped when no manifest candidate exists`);
    }
    await atomicWrite(output, jsonBytes({ evidenceRetentionDays: "90", schemaVersion: "1", status: "no-candidate" }));
    return;
  }
  for (const job of requiredJobs) {
    if (jobs?.[job] !== "success") {
      throw new ManifestCiError(`required job ${job} did not succeed (observed ${jobs?.[job] ?? "missing"})`);
    }
  }
  let producers = 0;
  let reproducibility = 0;
  for (const candidatePlan of plan.candidates) {
    const id = candidatePlan?.id;
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ManifestCiError("manifest candidate has an invalid content address");
    const identityRoot = path.join(root, "candidates", id);
    const overlay = await readJson(path.join(identityRoot, "candidate-overlay.json"), `${id} Candidate Overlay`);
    const resolved = await readJson(path.join(identityRoot, "resolved-manifest.json"), `${id} resolved manifest`);
    const summary = await readJson(path.join(identityRoot, "candidate-summary.json"), `${id} candidate summary`);
    const resolvedXml = await readFile(path.join(identityRoot, "resolved-manifest.xml"));
    if (
      summary?.schemaVersion !== "1" || summary.overlayDigest !== digest(overlay) ||
      summary.resolvedManifestDigest !== digest(resolved) || summary.resolvedManifestXmlSha256 !== byteDigest(resolvedXml) ||
      summary.resolvedManifestDigest.slice("sha256:".length) !== id
    ) {
      throw new ManifestCiError(`${id} candidate summary does not bind the overlay and resolved manifest`);
    }
    const resolvedProjects = validateManifest(resolvedXml.toString("utf8"), `${id} resolved manifest XML`)
      .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    if (
      resolved?.schemaVersion !== "1" || overlay?.schemaVersion !== "1" ||
      canonicalize(resolved.baseline) !== canonicalize(overlay.baseline) ||
      canonicalize(resolved.projects) !== canonicalize(resolvedProjects) ||
      candidatePlan.manifestRevision !== requireOid(candidatePlan.manifestRevision, "candidate manifest revision") ||
      resolvedProjects.find((project) => project.name === "tsfg.git")?.revision !== candidatePlan.productRevision ||
      resolvedProjects.find((project) => project.name === ".agents.git")?.revision !== candidatePlan.agentRevision
    ) {
      throw new ManifestCiError(`${id} plan is not bound to its resolved manifest identity`);
    }
    const agent = await readJson(path.join(root, "agent", id, "report.json"), `${id} agent evidence`);
    requireSuccess(agent, `${id} agent evidence`);
    if (
      agent.candidateId !== id || agent.agentRevision !== candidatePlan.agentRevision ||
      agent.agentChanged !== candidatePlan.agentChanged || agent.command !== "corepack pnpm@11.25.0 verify"
    ) {
      throw new ManifestCiError(`${id} agent evidence is not bound to the manifest candidate`);
    }
    const repositoryGates = await readJson(
      path.join(root, "repository-gates", id, "report.json"),
      `${id} product repository gates`,
    );
    requireSuccess(repositoryGates, `${id} product repository gates`);
    if (repositoryGates.candidateId !== id || repositoryGates.productRevision !== candidatePlan.productRevision) {
      throw new ManifestCiError(`${id} product repository gates are not bound to the manifest candidate`);
    }
    for (const gate of ["format", "policy", "license", "lock"]) {
      if (repositoryGates.gates?.[gate] !== "passed") throw new ManifestCiError(`${id} product ${gate} gate is missing or failed`);
    }
    requireResolvedWorkspace(
      await readJson(path.join(root, "workspace", id, "report.json"), `${id} workspace evidence`),
      resolved,
      candidatePlan,
      `${id} workspace evidence`,
    );
    for (const target of ["linux-x86_64-gnu", "windows-x86_64-msvc"]) {
      requireCompatibility(
        await readJson(path.join(root, "compatibility", id, target, "report.json"), `${id}/${target} compatibility`),
        candidatePlan,
        target,
        `${id}/${target} compatibility`,
      );
      for (const profile of ["debug", "release"]) {
        let producerIdentity;
        for (const producer of ["a", "b"]) {
          const producerRoot = path.join(root, "producers", id, target, profile, producer);
          requireResolvedWorkspace(
            await readJson(path.join(producerRoot, "workspace-report.json"), `${id}/${target}/${profile}/${producer} workspace`),
            resolved,
            candidatePlan,
            `${id}/${target}/${profile}/${producer} workspace`,
          );
          const build = await readJson(path.join(producerRoot, "build-report.json"), `${id}/${target}/${profile}/${producer} build`);
          const testReport = await readJson(path.join(producerRoot, "test-report.json"), `${id}/${target}/${profile}/${producer} test`);
          const packageReport = await readJson(path.join(producerRoot, "package-report.json"), `${id}/${target}/${profile}/${producer} package`);
          requireSuccess(build, `${id}/${target}/${profile}/${producer} build`, "build");
          requireSuccess(testReport, `${id}/${target}/${profile}/${producer} test`, "test");
          requireSuccess(packageReport, `${id}/${target}/${profile}/${producer} package`, "package");
          const identityDigest = packageReport.result?.buildIdentity?.digest;
          if (
            build.result?.target !== target || build.result?.profile !== profile ||
            packageReport.result?.buildIdentity?.target !== target || packageReport.result?.buildIdentity?.profile !== profile ||
            build.result?.buildIdentity?.digest !== identityDigest || testReport.result?.buildIdentity?.digest !== identityDigest ||
            (producerIdentity && producerIdentity !== identityDigest)
          ) {
            throw new ManifestCiError(`${id}/${target}/${profile}/${producer} reports disagree on Build Identity`);
          }
          producerIdentity = identityDigest;
          const archive = packageReport.result?.archive;
          if (typeof archive !== "string" || archive === "" || archive.includes("/") || archive.includes("\\")) {
            throw new ManifestCiError(`${id}/${target}/${profile}/${producer} package report has an invalid archive name`);
          }
          for (const member of [archive, `${archive}.checksums.json`, "producer-attestation.json"]) {
            const metadata = await stat(path.join(producerRoot, "package", member)).catch(() => undefined);
            if (!metadata?.isFile()) throw new ManifestCiError(`${id}/${target}/${profile}/${producer} is missing ${member}`);
          }
          const attestation = await readJson(
            path.join(producerRoot, "package", "producer-attestation.json"),
            `${id}/${target}/${profile}/${producer} producer attestation`,
          );
          if (
            attestation.schemaVersion !== "1" || attestation.target !== target || attestation.profile !== profile ||
            attestation.buildIdentityDigest !== identityDigest
          ) {
            throw new ManifestCiError(`${id}/${target}/${profile}/${producer} producer attestation is inconsistent`);
          }
          const binding = await readJson(path.join(producerRoot, "candidate-binding.json"), `${id}/${target}/${profile}/${producer} candidate binding`);
          if (
            binding.schemaVersion !== "1" || binding.candidateId !== id ||
            binding.productRevision !== candidatePlan.productRevision || binding.buildIdentityDigest !== identityDigest
          ) {
            throw new ManifestCiError(`${id}/${target}/${profile}/${producer} build evidence is not bound to the manifest candidate`);
          }
          producers += 1;
        }
        const repro = await readJson(
          path.join(root, "reproducibility", id, target, profile, "report.json"),
          `${id}/${target}/${profile} reproducibility`,
        );
        requireSuccess(repro, `${id}/${target}/${profile} reproducibility`, "repro-check");
        if (
          repro.result?.buildExecuted !== false || repro.result?.target !== target ||
          repro.result?.profile !== profile || repro.result?.producers?.length !== 2
        ) throw new ManifestCiError("reproducibility comparator evidence is incomplete or executed a build");
        reproducibility += 1;
      }
    }
  }
  const entries = await Promise.all((await evidenceFiles(root)).map(async (relativePath) => ({
    path: relativePath,
    sha256: `sha256:${createHash("sha256").update(await readFile(path.join(root, ...relativePath.split("/")))).digest("hex")}`,
  })));
  await atomicWrite(output, jsonBytes({
    evidenceDigest: digest({ entries, schemaVersion: "1" }),
    evidenceRetentionDays: "90",
    promotionState: "Verified Candidate",
    requiredEvidence: {
      manifests: `${plan.candidates.length}/${plan.candidates.length}`,
      producers: `${producers}/${plan.candidates.length * 8}`,
      reproducibility: `${reproducibility}/${plan.candidates.length * 4}`,
    },
    schemaVersion: "1",
  }));
}

async function candidate(options) {
  const repository = path.resolve(required(options, "--repository"));
  const baselineRevision = requireOid(required(options, "--baseline-revision"), "baseline revision");
  const output = path.resolve(required(options, "--out"));
  const defaultXml = gitFile(repository, baselineRevision, "default.xml", true);
  let manifestName;
  let manifestXml;
  if (defaultXml !== undefined) {
    if (git(repository, ["rev-parse", "HEAD"]).stdout.trim() !== baselineRevision) {
      throw new ManifestCiError("after the first Stable, the baseline must be the repository's current Stable identity");
    }
    requireDefaultSnapshot(repository, baselineRevision, defaultXml);
    manifestName = "default.xml";
    manifestXml = defaultXml;
  } else {
    if (baselineRevision !== bootstrapRevision) {
      throw new ManifestCiError("before the first Stable, the baseline must be the published Bootstrap Integration Snapshot");
    }
    manifestName = "bootstrap/r00.xml";
    manifestXml = gitFile(repository, baselineRevision, manifestName);
  }

  const projects = validateManifest(manifestXml, manifestName);
  const replacements = (options.get("--replacement") ?? []).map((replacement) => {
    const separator = replacement.indexOf("=");
    if (separator <= 0) throw new ManifestCiError("replacement must be project=complete-oid");
    return {
      project: replacement.slice(0, separator),
      revision: requireOid(replacement.slice(separator + 1), "replacement revision"),
    };
  });
  if (replacements.length === 0) throw new ManifestCiError("at least one replacement is required");
  const seen = new Set();
  for (const replacement of replacements) {
    if (seen.has(replacement.project)) throw new ManifestCiError(`duplicate replacement: ${replacement.project}`);
    seen.add(replacement.project);
    if (!projects.some((project) => project.name === replacement.project)) {
      throw new ManifestCiError(`replacement project is not in the fixed baseline: ${replacement.project}`);
    }
  }
  replacements.sort((left, right) => Buffer.from(left.project).compare(Buffer.from(right.project)));

  const baseline = { manifest: manifestName, repository: manifestRepositoryUrl, revision: baselineRevision };
  const overlay = { baseline, replacements, schemaVersion: "1" };
  const resolvedProjects = projects
    .map((project) => ({
      ...project,
      revision: replacements.find((replacement) => replacement.project === project.name)?.revision ?? project.revision,
    }))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const resolved = { baseline, projects: resolvedProjects, schemaVersion: "1" };
  const replacementByProject = new Map(replacements.map((entry) => [entry.project, entry.revision]));
  let resolvedXml = manifestXml;
  resolvedXml = resolvedXml.replace(/<project\b[^>]*>/g, (projectOpening) => {
    const opening = /^<project([\s\S]*?)(\/?)>$/.exec(projectOpening);
    const revision = replacementByProject.get(parseAttributes(opening[1], "project").get("name"));
    return revision ? projectOpening.replace(/\brevision="[^"]*"/, `revision="${revision}"`) : projectOpening;
  });
  const summary = {
    overlayDigest: digest(overlay),
    resolvedManifestDigest: digest(resolved),
    resolvedManifestXmlSha256: byteDigest(resolvedXml),
    schemaVersion: "1",
  };
  await publishDirectory(output, {
    "candidate-overlay.json": jsonBytes(overlay),
    "candidate-summary.json": jsonBytes(summary),
    "resolved-manifest.json": jsonBytes(resolved),
    "resolved-manifest.xml": Buffer.from(resolvedXml),
  });
}

async function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "candidate") {
    const allowed = new Set(["--repository", "--baseline-revision", "--replacement", "--out"]);
    await candidate(parseOptions(arguments_, allowed, new Set(["--replacement"])));
  } else if (command === "gate") {
    await gate(parseOptions(arguments_, new Set(["--repository", "--base", "--head", "--out"])));
  } else if (command === "tag-policy") {
    await tagPolicy(parseOptions(arguments_, new Set(["--before", "--after", "--out"])));
  } else if (command === "verdict") {
    await verdict(parseOptions(arguments_, new Set(["--evidence", "--job-results", "--out"])));
  } else {
    throw new ManifestCiError(`unsupported command: ${command ?? "<missing>"}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
