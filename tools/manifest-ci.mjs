// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const manifestRepositoryUrl = "https://github.com/xuelongling/manifests.git";
const manifestRepositoryName = "xuelongling/manifests";
const releaseEnvironment = "protected-release-environment";
const releaseOwnerWorkflowPath = ".github/workflows/release-owner.yml";
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

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const retryable = error?.code === "EACCES" || error?.code === "EBUSY" || error?.code === "EPERM";
      if (!retryable || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
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
    await renameWithRetry(staging, destination);
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

function releaseFileTree(repository, revision, fileName) {
  const result = git(repository, ["ls-tree", "-r", revision, "--", "releases"]);
  const entries = new Map();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = /^(\d+)\s+blob\s+([0-9a-f]{40})\t(releases\/tsfg-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/(evidence|publication|state)\.json)$/.exec(line.replaceAll("\\", "/"));
    if (!match || `${match[5]}.json` !== fileName) continue;
    entries.set(match[4], { identity: `${match[1]} ${match[2]}`, path: match[3] });
  }
  return entries;
}

function enforceImmutableReleaseFiles(repository, base, head, fileName) {
  const before = releaseFileTree(repository, base, fileName);
  const after = releaseFileTree(repository, head, fileName);
  for (const [version, entry] of before) {
    if (after.get(version)?.identity !== entry.identity) {
      throw new ManifestCiError(`${fileName} is immutable and must not be modified, deleted, or renamed: ${entry.path}`);
    }
  }
  const history = git(repository, ["log", "--format=", "--name-only", base, "--", `releases/*/${fileName}`])
    .stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
  for (const entry of after.values()) {
    if (!before.has(/^releases\/tsfg-v(.+)\//.exec(entry.path)[1]) && history.includes(entry.path)) {
      throw new ManifestCiError(`release version identity must not be reused: ${entry.path}`);
    }
  }
  return { after, before };
}

function releaseStateAt(repository, revision, version, allowMissing = false) {
  const filePath = releasePaths(version).state;
  const source = gitFile(repository, revision, filePath, allowMissing);
  if (source === undefined) return undefined;
  const state = parseReleaseRecord(source, filePath);
  validateReleaseState(state, version, filePath);
  return { source, state };
}

function validatePublication(publication, version, label) {
  requireExactFields(publication, ["evidenceSha256", "productVersion", "publications", "schemaVersion", "status"], label);
  if (
    publication.schemaVersion !== "1" || publication.status !== "complete" || publication.productVersion !== version ||
    !Array.isArray(publication.publications) || publication.publications.length === 0
  ) throw new ManifestCiError(`${label} is incomplete`);
  requireDigest(publication.evidenceSha256, `${label} evidence digest`);
  for (const entry of publication.publications) {
    requireExactFields(entry, ["immutableId", "kind", "url"], `${label} publication`);
    if (!entry.immutableId || !entry.kind || !/^https:\/\//.test(entry.url)) throw new ManifestCiError(`${label} has an invalid publication`);
  }
}

function validateReleaseHistory(repository, base, head) {
  const releaseTreePaths = git(repository, ["ls-tree", "-r", "--name-only", head, "--", "releases"])
    .stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
  for (const filePath of releaseTreePaths) {
    if (!/^releases\/tsfg-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\/(?:evidence|publication|state)\.json$/.test(filePath)) {
      throw new ManifestCiError(`release source has an undeclared path: ${filePath}`);
    }
  }
  const evidenceTrees = enforceImmutableReleaseFiles(repository, base, head, "evidence.json");
  const publicationTrees = enforceImmutableReleaseFiles(repository, base, head, "publication.json");
  const beforeStates = releaseFileTree(repository, base, "state.json");
  const afterStates = releaseFileTree(repository, head, "state.json");
  for (const version of beforeStates.keys()) {
    if (!afterStates.has(version)) throw new ManifestCiError(`Promotion State must not be deleted or renamed: ${releasePaths(version).state}`);
  }
  const versions = [...new Set([...beforeStates.keys(), ...afterStates.keys()])]
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const transitions = [];
  for (const version of versions) {
    const before = releaseStateAt(repository, base, version, true);
    const after = releaseStateAt(repository, head, version, true);
    if (!after) continue;
    const evidenceSource = gitFile(repository, head, releasePaths(version).evidence, true);
    const snapshotXml = gitFile(repository, head, snapshotPath(version), true);
    if (evidenceSource === undefined || snapshotXml === undefined) {
      throw new ManifestCiError(`Promotion State for ${releaseName(version)} lacks immutable evidence or snapshot`);
    }
    const evidence = parseReleaseRecord(evidenceSource, releasePaths(version).evidence);
    validateReleaseEvidence(evidence, version, releasePaths(version).evidence);
    if (
      after.state.evidence.sha256 !== byteDigest(evidenceSource) || after.state.snapshot.sha256 !== byteDigest(snapshotXml) ||
      evidence.snapshot.sha256 !== byteDigest(snapshotXml) ||
      after.state.transaction.provisionalEvidenceDigest !== evidence.provisionalEvidence.contentAddress
    ) throw new ManifestCiError(`Promotion State for ${releaseName(version)} does not bind immutable evidence`);
    if (!before) {
      if (after.state.promotionState !== "Promotable") {
        throw new ManifestCiError(`new release ${releaseName(version)} must begin at Promotable`);
      }
      if (gitFile(repository, base, snapshotPath(version), true) === undefined) {
        throw new ManifestCiError("immutable version snapshot must be committed before Release Evidence");
      }
      continue;
    }
    if (before.source === after.source) continue;
    const transition = `${before.state.promotionState}->${after.state.promotionState}`;
    if (!["Promotable->Stable", "Stable->Superseded", "Stable->Withdrawn"].includes(transition)) {
      throw new ManifestCiError(`Promotion State cannot move ${transition}`);
    }
    transitions.push({ after: after.state, before: before.state, transition, version });
  }

  for (const [version, entry] of publicationTrees.after) {
    const source = gitFile(repository, head, entry.path);
    const publication = parseReleaseRecord(source, entry.path);
    validatePublication(publication, version, entry.path);
    const evidenceSource = gitFile(repository, head, releasePaths(version).evidence, true);
    if (evidenceSource === undefined || publication.evidenceSha256 !== byteDigest(evidenceSource)) {
      throw new ManifestCiError(`${entry.path} does not bind immutable Release Evidence`);
    }
    if (!publicationTrees.before.has(version)) {
      const baseState = releaseStateAt(repository, base, version, true);
      const baseDefault = gitFile(repository, base, "default.xml", true);
      if (
        baseState?.state.promotionState !== "Stable" || baseDefault === undefined ||
        currentReleaseVersion(repository, base, baseDefault) !== version
      ) throw new ManifestCiError("publication metadata may only be finalized after the Stable commit point");
    }
  }

  const baseDefault = gitFile(repository, base, "default.xml", true);
  const headDefault = gitFile(repository, head, "default.xml", true);
  if (headDefault !== undefined) requireDefaultSnapshot(repository, head, headDefault);
  if (baseDefault === headDefault) {
    if (transitions.length !== 0) throw new ManifestCiError("Promotion State transition requires the matching default-manifest commit point");
    return;
  }
  if (headDefault === undefined) throw new ManifestCiError("default.xml must not be deleted");
  const fromVersion = baseDefault === undefined ? undefined : currentReleaseVersion(repository, base, baseDefault);
  const toVersion = currentReleaseVersion(repository, head, headDefault);
  if (!toVersion) throw new ManifestCiError("default.xml must resolve exactly to an immutable versioned snapshot");
  const stable = transitions.find((entry) => entry.version === toVersion && entry.transition === "Promotable->Stable");
  if (stable) {
    const expected = fromVersion === undefined
      ? [stable]
      : [stable, transitions.find((entry) => entry.version === fromVersion && entry.transition === "Stable->Superseded")];
    if (expected.some((entry) => !entry) || transitions.length !== expected.length) {
      throw new ManifestCiError("Stable promotion must atomically supersede only the prior default release");
    }
    if (fromVersion !== undefined && stable.after.productVersion === fromVersion) {
      throw new ManifestCiError("Stable promotion must advance to a different release");
    }
    return;
  }
  const withdrawal = transitions.find((entry) => entry.version === fromVersion && entry.transition === "Stable->Withdrawn");
  const target = releaseStateAt(repository, head, toVersion, true);
  if (
    !withdrawal || transitions.length !== 1 || target?.state.promotionState !== "Superseded" ||
    withdrawal.after.withdrawal?.rollbackTargetVersion !== toVersion || !wasHistoricallyStable(repository, toVersion, base)
  ) throw new ManifestCiError("default drift is only allowed for a new Owner-approved rollback commit to an earlier Stable");
}

function resolvedIdentity(baseline, baselineProjects, manifestXml, manifestName, manifestRevision) {
  const projects = validateManifest(manifestXml, manifestName)
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const replacements = projects
    .filter((project) => baselineProjects.find((entry) => entry.name === project.name)?.revision !== project.revision)
    .map(({ name: project, revision }) => ({ project, revision }));
  if (replacements.length === 0) {
    throw new ManifestCiError("Candidate Overlay must contain at least one effective project revision change");
  }
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
      baselineProductRevision: baselineProjects.find((entry) => entry.name === "tsfg.git").revision,
      candidateOverlayDigest: summary.overlayDigest,
      id: summary.resolvedManifestDigest.slice("sha256:".length),
      manifest: manifestName,
      manifestRepository: baseline.repository,
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
  validateReleaseHistory(repository, base, head);
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
    if (manifestPath === "default.xml") continue;
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
  await renameWithRetry(temporary, destination);
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
    report.result?.compatibility?.artifacts?.baseline?.productOid !== candidatePlan.baselineProductRevision ||
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

function requireDigest(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new ManifestCiError(`${label} must be a complete SHA-256 digest`);
  return value;
}

function requireObject(value, label) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ManifestCiError(`${label} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new ManifestCiError(`${label} has missing or undeclared fields`);
  }
}

function requireVersion(value, label = "Product Version") {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) {
    throw new ManifestCiError(`${label} must be a release SemVer without a prerelease suffix`);
  }
  return value;
}

function releaseName(version) {
  return `tsfg-v${version}`;
}

function releasePaths(version) {
  const root = `releases/${releaseName(version)}`;
  return {
    evidence: `${root}/evidence.json`,
    publication: `${root}/publication.json`,
    root,
    state: `${root}/state.json`,
  };
}

function snapshotPath(version) {
  return `snapshots/${releaseName(version)}.xml`;
}

function requireHumanOwner(approval, label, expected = {}, additionalFields = []) {
  requireExactFields(approval, [
    "action", "actor", "decision", "role", "schemaVersion", "source",
    ...Object.keys(expected).filter((field) => field !== "action"),
    ...additionalFields,
  ], label);
  requireExactFields(approval.actor, ["login", "type"], `${label} actor`);
  if (
    approval.schemaVersion !== "1" || approval.action !== expected.action || approval.decision !== "approved" ||
    approval.role !== "Release Owner" || approval.source !== "protected-release-environment" ||
    approval.actor.type !== "User" || typeof approval.actor.login !== "string" || approval.actor.login === "" ||
    /\[bot\]$/i.test(approval.actor.login)
  ) {
    throw new ManifestCiError(`${label} must be an approval by a human Release Owner from the protected release environment`);
  }
  for (const [field, value] of Object.entries(expected)) {
    if (field !== "action" && approval[field] !== value) throw new ManifestCiError(`${label} does not bind ${field}`);
  }
  return approval.actor.login;
}

function requireAdditionalOwnerApprovals(approval, label) {
  if (!Array.isArray(approval.additionalApprovals)) throw new ManifestCiError(`${label} additional approvals must be an array`);
  const roles = new Set();
  for (const additional of approval.additionalApprovals) {
    requireExactFields(additional, ["actor", "decision", "role"], `${label} additional approval`);
    requireExactFields(additional.actor, ["login", "type"], `${label} additional approval actor`);
    if (
      !["Contracts Owner", "Integration Owner"].includes(additional.role) || roles.has(additional.role) ||
      additional.decision !== "approved" || additional.actor.type !== "User" || !additional.actor.login ||
      /\[bot\]$/i.test(additional.actor.login)
    ) throw new ManifestCiError(`${label} additional applicable Owner approvals must be unique human approvals`);
    roles.add(additional.role);
  }
}

function requireHumanActor(actor, label) {
  if (
    !actor || typeof actor !== "object" || Array.isArray(actor) || actor.type !== "User" ||
    typeof actor.login !== "string" || actor.login === "" || /\[bot\]$/i.test(actor.login)
  ) throw new ManifestCiError(`${label} must be a human GitHub user`);
  return { login: actor.login, type: actor.type };
}

function normalizedWorkflowPath(value) {
  if (typeof value !== "string") return undefined;
  const [filePath, ref] = value.split("@", 2);
  if (ref !== undefined && !["main", "refs/heads/main"].includes(ref)) return undefined;
  return filePath;
}

async function releaseOwnerContext(options) {
  const repository = path.resolve(required(options, "--repository"));
  const runPath = path.resolve(required(options, "--run"));
  const reviewsPath = path.resolve(required(options, "--reviews"));
  const runId = required(options, "--run-id");
  const operation = required(options, "--operation");
  const actorLogin = required(options, "--actor");
  const triggeringActorLogin = required(options, "--triggering-actor");
  const ref = required(options, "--ref");
  const sha = requireOid(required(options, "--sha"), "release workflow commit");
  if (![
    "record-release-evidence", "promote-stable", "finalize-release", "rollback",
  ].includes(operation)) throw new ManifestCiError("unsupported Release Owner operation");

  const runBytes = await readFile(runPath);
  const reviewsBytes = await readFile(reviewsPath);
  const run = parseReleaseRecord(runBytes.toString("utf8"), "Release Owner workflow run");
  const reviews = parseReleaseRecord(reviewsBytes.toString("utf8"), "Release Owner environment reviews");
  if (!Array.isArray(reviews)) throw new ManifestCiError("Release Owner environment reviews must be an array");
  const actor = requireHumanActor(run.actor, "Release Owner workflow actor");
  const triggeringActor = requireHumanActor(run.triggering_actor, "Release Owner workflow triggering actor");
  if (
    String(run.id) !== runId || run.event !== "workflow_dispatch" || run.head_branch !== "main" ||
    run.head_sha !== sha || normalizedWorkflowPath(run.path) !== releaseOwnerWorkflowPath ||
    run.repository?.full_name !== manifestRepositoryName || run.head_repository?.full_name !== manifestRepositoryName ||
    ref !== "refs/heads/main" || actor.login !== actorLogin || triggeringActor.login !== triggeringActorLogin ||
    actor.login !== triggeringActor.login
  ) throw new ManifestCiError("Release Owner operation must be a same-human workflow_dispatch from protected manifest main");
  const head = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
  if (head !== sha) throw new ManifestCiError("Release Owner workflow must execute the exact protected main commit");
  const workflowSource = gitFile(repository, sha, releaseOwnerWorkflowPath, true);
  if (
    workflowSource === undefined ||
    !/^\s{4}environment:\s*protected-release-environment\s*$/m.test(workflowSource)
  ) throw new ManifestCiError("trusted Release Owner workflow does not enter the protected release environment");

  const environmentReviews = [];
  for (const review of reviews) {
    const applies = Array.isArray(review?.environments) &&
      review.environments.some((environment) => environment?.name === releaseEnvironment);
    if (!applies) continue;
    if (review.state === "rejected") throw new ManifestCiError("protected release environment was rejected");
    if (review.state !== "approved") continue;
    const reviewer = requireHumanActor(review.user, "protected release environment reviewer");
    if (!environmentReviews.some((entry) => entry.login === reviewer.login)) environmentReviews.push(reviewer);
  }
  environmentReviews.sort((left, right) => Buffer.from(left.login).compare(Buffer.from(right.login)));
  await atomicWrite(path.resolve(required(options, "--out")), jsonBytes({
    actor,
    environment: releaseEnvironment,
    environmentReviews,
    operation,
    repository: manifestRepositoryName,
    runEvidenceSha256: byteDigest(runBytes),
    reviewEvidenceSha256: byteDigest(reviewsBytes),
    schemaVersion: "1",
    source: "github-actions",
    workflow: { commit: sha, path: releaseOwnerWorkflowPath, ref, runId },
  }));
}

async function readReleaseAuthorization(options, operation, repository) {
  const authorization = await readJson(
    path.resolve(required(options, "--authorization")), "Release Owner workflow authorization",
  );
  requireExactFields(authorization, [
    "actor", "environment", "environmentReviews", "operation", "repository", "reviewEvidenceSha256",
    "runEvidenceSha256", "schemaVersion", "source", "workflow",
  ], "Release Owner workflow authorization");
  requireExactFields(authorization.actor, ["login", "type"], "Release Owner workflow authorization actor");
  requireExactFields(authorization.workflow, ["commit", "path", "ref", "runId"], "Release Owner workflow authorization source");
  const actor = requireHumanActor(authorization.actor, "Release Owner workflow authorization actor");
  if (
    authorization.schemaVersion !== "1" || authorization.source !== "github-actions" ||
    authorization.environment !== releaseEnvironment || authorization.repository !== manifestRepositoryName ||
    authorization.operation !== operation || authorization.workflow.path !== releaseOwnerWorkflowPath ||
    authorization.workflow.ref !== "refs/heads/main" || !/^\d+$/.test(authorization.workflow.runId) ||
    !completeOid.test(authorization.workflow.commit) || !Array.isArray(authorization.environmentReviews)
  ) throw new ManifestCiError(`invalid Release Owner workflow authorization for ${operation}`);
  requireDigest(authorization.runEvidenceSha256, "Release Owner run evidence digest");
  requireDigest(authorization.reviewEvidenceSha256, "Release Owner review evidence digest");
  for (const reviewer of authorization.environmentReviews) {
    requireExactFields(reviewer, ["login", "type"], "Release Owner environment reviewer");
    requireHumanActor(reviewer, "Release Owner environment reviewer");
  }
  if (git(repository, ["rev-parse", "HEAD"]).stdout.trim() !== authorization.workflow.commit) {
    throw new ManifestCiError("Release Owner workflow authorization does not bind the current protected main commit");
  }
  return { actor: actor.login, authorization };
}

function requireCleanRepository(repository) {
  if (git(repository, ["status", "--porcelain", "--untracked-files=all"]).stdout !== "") {
    throw new ManifestCiError("release transaction requires a clean Manifest Repository worktree");
  }
}

async function requireAbsentVersionIdentity(repository, paths) {
  for (const filePath of Object.values(paths).filter((entry) => entry !== paths.root)) {
    if (git(repository, ["log", "--all", "--format=%H", "--", filePath]).stdout.trim() !== "") {
      throw new ManifestCiError(`release version identity must not be reused: ${filePath}`);
    }
  }
}

async function readProvisionalBundle(bundleRoot) {
  const names = [
    "offline-proof.json", "owner-approval.json", "product-tag.json", "release-materials.json",
    "verified-candidate.json", "version-readiness.json",
  ];
  const actual = (await readdir(bundleRoot, { withFileTypes: true }))
    .map((entry) => entry.isFile() ? entry.name : `${entry.name}/`)
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const expected = [...names, "bundle.json"].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new ManifestCiError("provisional evidence bundle has missing or undeclared files");
  }
  const entries = await Promise.all(names.map(async (name) => ({
    path: name,
    sha256: byteDigest(await readFile(path.join(bundleRoot, name))),
  })));
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const bundle = await readJson(path.join(bundleRoot, "bundle.json"), "provisional evidence bundle manifest");
  requireExactFields(bundle, ["contentAddress", "entries", "schemaVersion"], "provisional evidence bundle manifest");
  if (
    bundle.schemaVersion !== "1" || canonicalize(bundle.entries) !== canonicalize(entries) ||
    bundle.contentAddress !== digest({ entries, schemaVersion: "1" })
  ) throw new ManifestCiError("provisional evidence bundle content address is invalid");
  return {
    bundle,
    offlineProof: await readJson(path.join(bundleRoot, "offline-proof.json"), "Offline Proof"),
    ownerApproval: await readJson(path.join(bundleRoot, "owner-approval.json"), "Release Owner approval"),
    productTag: await readJson(path.join(bundleRoot, "product-tag.json"), "product tag evidence"),
    releaseMaterials: await readJson(path.join(bundleRoot, "release-materials.json"), "release materials"),
    verifiedCandidate: await readJson(path.join(bundleRoot, "verified-candidate.json"), "Verified Candidate verdict"),
    versionReadiness: await readJson(path.join(bundleRoot, "version-readiness.json"), "Product Version readiness"),
  };
}

function validatePromotionBundle(input, version) {
  const {
    bundle, offlineProof, ownerApproval, productTag, releaseMaterials, verifiedCandidate, versionReadiness,
  } = input;
  requireExactFields(verifiedCandidate, [
    "candidateIds", "evidenceDigest", "evidenceRetentionDays", "promotionState", "requiredEvidence", "schemaVersion",
  ], "Verified Candidate verdict");
  if (
    verifiedCandidate.schemaVersion !== "1" || verifiedCandidate.promotionState !== "Verified Candidate" ||
    verifiedCandidate.evidenceRetentionDays !== "90" || !Array.isArray(verifiedCandidate.candidateIds) ||
    verifiedCandidate.candidateIds.length !== 1
  ) throw new ManifestCiError("all required CI must produce one complete Verified Candidate verdict");
  requireDigest(verifiedCandidate.evidenceDigest, "Verified Candidate evidence digest");
  requireObject(verifiedCandidate.requiredEvidence, "Verified Candidate required evidence");
  const candidateId = verifiedCandidate.candidateIds[0];
  if (!/^[0-9a-f]{64}$/.test(candidateId)) throw new ManifestCiError("Verified Candidate id must be a complete content address");

  requireExactFields(offlineProof, [
    "builds", "candidate", "candidateIds", "candidateRun", "controllerRun", "evidenceDigest", "proof",
    "requiredEvidence", "schemaVersion", "status",
  ], "Offline Proof");
  if (
    offlineProof.schemaVersion !== "1" || offlineProof.status !== "success" || offlineProof.proof !== "Offline Proof" ||
    canonicalize(offlineProof.candidateIds) !== canonicalize([candidateId])
  ) throw new ManifestCiError("successful Offline Proof for the exact Verified Candidate is required");
  requireDigest(offlineProof.evidenceDigest, "Offline Proof evidence digest");
  const candidate = offlineProof.candidate;
  requireExactFields(candidate, [
    "agentRevision", "candidateOverlayDigest", "id", "manifest", "manifestRepository", "manifestRevision",
    "productRevision", "resolvedManifestDigest",
  ], "Offline Proof candidate");
  if (
    candidate.id !== candidateId || candidate.resolvedManifestDigest !== `sha256:${candidateId}` ||
    candidate.manifestRepository !== manifestRepositoryUrl || candidate.manifest !== snapshotPath(version)
  ) throw new ManifestCiError("Offline Proof does not bind the versioned candidate snapshot");
  requireOid(candidate.agentRevision, "candidate agent revision");
  requireOid(candidate.manifestRevision, "candidate manifest revision");
  requireOid(candidate.productRevision, "candidate product revision");
  requireDigest(candidate.candidateOverlayDigest, "Candidate Overlay digest");

  requireExactFields(versionReadiness, ["candidateId", "productVersion", "schemaVersion", "status"], "Product Version readiness");
  if (
    versionReadiness.schemaVersion !== "1" || versionReadiness.status !== "ready" ||
    versionReadiness.productVersion !== version || versionReadiness.candidateId !== candidateId
  ) throw new ManifestCiError("Product Version is not ready for the exact candidate");

  requireHumanOwner(ownerApproval, "Release Owner approval", {
    action: "promote-stable", candidateId, productVersion: version,
  }, ["additionalApprovals"]);
  requireAdditionalOwnerApprovals(ownerApproval, "Release Owner approval");

  requireExactFields(productTag, ["name", "repository", "schemaVersion", "status", "targetRevision"], "product tag evidence");
  if (
    productTag.schemaVersion !== "1" || productTag.status !== "fixed" || productTag.name !== releaseName(version) ||
    productTag.repository !== "https://github.com/xuelongling/tsfg.git" || productTag.targetRevision !== candidate.productRevision
  ) throw new ManifestCiError("the immutable product tag must already bind the candidate product revision");

  requireExactFields(releaseMaterials, ["artifacts", "candidateId", "releaseStatus", "schemaVersion", "status"], "release materials");
  if (
    releaseMaterials.schemaVersion !== "1" || releaseMaterials.status !== "fixed" ||
    releaseMaterials.releaseStatus !== "non-stable" || releaseMaterials.candidateId !== candidateId ||
    !Array.isArray(releaseMaterials.artifacts) || releaseMaterials.artifacts.length !== 2
  ) throw new ManifestCiError("complete fixed non-Stable release materials are required");
  const expectedTargets = ["linux-x86_64-gnu", "windows-x86_64-msvc"];
  const targets = [];
  for (const artifact of releaseMaterials.artifacts) {
    requireExactFields(artifact, [
      "archiveSha256", "artifactManifestSha256", "buildIdentityDigest", "checksumsSha256", "target",
    ], "release material");
    targets.push(artifact.target);
    for (const field of ["archiveSha256", "artifactManifestSha256", "buildIdentityDigest", "checksumsSha256"]) {
      requireDigest(artifact[field], `release material ${field}`);
    }
  }
  targets.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalize(targets) !== canonicalize(expectedTargets)) {
    throw new ManifestCiError("release materials must cover both Tier 1 targets exactly once");
  }
  return { bundle, candidate, candidateId, offlineProof, ownerApproval, productTag, releaseMaterials, verifiedCandidate, versionReadiness };
}

function parseReleaseRecord(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ManifestCiError(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return value;
}

function validateReleaseEvidence(evidence, version, label) {
  requireExactFields(evidence, [
    "candidate", "ownerApproval", "productTag", "productVersion", "provisionalEvidence", "recordedState",
    "releaseMaterials", "schemaVersion", "snapshot", "sourceEvidence",
  ], label);
  if (evidence.schemaVersion !== "1" || evidence.productVersion !== version || evidence.recordedState !== "Promotable") {
    throw new ManifestCiError(`${label} must be the Promotable evidence for ${releaseName(version)}`);
  }
  requireExactFields(evidence.snapshot, ["path", "sha256"], `${label} snapshot`);
  requireExactFields(evidence.provisionalEvidence, ["contentAddress", "entries"], `${label} provisional evidence`);
  requireExactFields(evidence.sourceEvidence, ["offlineProofSha256", "verifiedCandidateSha256", "versionReadinessSha256"], `${label} source evidence`);
  if (evidence.snapshot.path !== snapshotPath(version)) throw new ManifestCiError(`${label} points to the wrong snapshot`);
  requireDigest(evidence.snapshot.sha256, `${label} snapshot digest`);
  requireDigest(evidence.provisionalEvidence.contentAddress, `${label} provisional evidence content address`);
  for (const digestValue of Object.values(evidence.sourceEvidence)) requireDigest(digestValue, `${label} source evidence digest`);
  const candidate = evidence.candidate;
  requireExactFields(candidate, [
    "agentRevision", "candidateOverlayDigest", "id", "manifest", "manifestRepository", "manifestRevision",
    "productRevision", "resolvedManifestDigest",
  ], `${label} candidate`);
  if (
    !/^[0-9a-f]{64}$/.test(candidate.id) || candidate.resolvedManifestDigest !== `sha256:${candidate.id}` ||
    candidate.manifestRepository !== manifestRepositoryUrl || candidate.manifest !== snapshotPath(version)
  ) throw new ManifestCiError(`${label} candidate identity is invalid`);
  requireOid(candidate.agentRevision, `${label} agent revision`);
  requireOid(candidate.manifestRevision, `${label} manifest revision`);
  requireOid(candidate.productRevision, `${label} product revision`);
  requireDigest(candidate.candidateOverlayDigest, `${label} Candidate Overlay digest`);
  requireHumanOwner(evidence.ownerApproval, `${label} Release Owner approval`, {
    action: "promote-stable", candidateId: candidate.id, productVersion: version,
  }, ["additionalApprovals"]);
  requireAdditionalOwnerApprovals(evidence.ownerApproval, `${label} Release Owner approval`);
  requireExactFields(evidence.productTag, ["name", "repository", "schemaVersion", "status", "targetRevision"], `${label} product tag`);
  if (
    evidence.productTag.schemaVersion !== "1" || evidence.productTag.status !== "fixed" ||
    evidence.productTag.name !== releaseName(version) || evidence.productTag.repository !== "https://github.com/xuelongling/tsfg.git" ||
    evidence.productTag.targetRevision !== candidate.productRevision
  ) throw new ManifestCiError(`${label} product tag identity is invalid`);
  requireExactFields(evidence.releaseMaterials, ["artifacts", "candidateId", "releaseStatus", "schemaVersion", "status"], `${label} release materials`);
  if (
    evidence.releaseMaterials.schemaVersion !== "1" || evidence.releaseMaterials.status !== "fixed" ||
    evidence.releaseMaterials.releaseStatus !== "non-stable" || evidence.releaseMaterials.candidateId !== candidate.id ||
    !Array.isArray(evidence.releaseMaterials.artifacts) || evidence.releaseMaterials.artifacts.length !== 2
  ) throw new ManifestCiError(`${label} release materials are incomplete`);
  const artifactTargets = [];
  for (const artifact of evidence.releaseMaterials.artifacts) {
    requireExactFields(artifact, [
      "archiveSha256", "artifactManifestSha256", "buildIdentityDigest", "checksumsSha256", "target",
    ], `${label} release material`);
    artifactTargets.push(artifact.target);
    for (const field of ["archiveSha256", "artifactManifestSha256", "buildIdentityDigest", "checksumsSha256"]) {
      requireDigest(artifact[field], `${label} release material ${field}`);
    }
  }
  artifactTargets.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalize(artifactTargets) !== canonicalize(["linux-x86_64-gnu", "windows-x86_64-msvc"])) {
    throw new ManifestCiError(`${label} release materials do not cover both Tier 1 targets`);
  }
  if (!Array.isArray(evidence.provisionalEvidence.entries)) throw new ManifestCiError(`${label} provisional evidence entries are invalid`);
  const expectedEntryNames = [
    "offline-proof.json", "owner-approval.json", "product-tag.json", "release-materials.json",
    "verified-candidate.json", "version-readiness.json",
  ];
  const entries = evidence.provisionalEvidence.entries;
  for (const entry of entries) {
    requireExactFields(entry, ["path", "sha256"], `${label} provisional evidence entry`);
    requireDigest(entry.sha256, `${label} provisional evidence entry digest`);
  }
  if (
    canonicalize(entries.map((entry) => entry.path)) !== canonicalize(expectedEntryNames) ||
    evidence.provisionalEvidence.contentAddress !== digest({ entries, schemaVersion: "1" }) ||
    evidence.sourceEvidence.offlineProofSha256 !== entries.find((entry) => entry.path === "offline-proof.json")?.sha256 ||
    evidence.sourceEvidence.verifiedCandidateSha256 !== entries.find((entry) => entry.path === "verified-candidate.json")?.sha256 ||
    evidence.sourceEvidence.versionReadinessSha256 !== entries.find((entry) => entry.path === "version-readiness.json")?.sha256
  ) throw new ManifestCiError(`${label} provisional evidence content address is invalid`);
}

function validateReleaseState(state, version, label) {
  const common = ["evidence", "productVersion", "promotionState", "schemaVersion", "snapshot", "transaction"];
  const additions = state?.promotionState === "Stable" ? ["stable"]
    : state?.promotionState === "Superseded" ? ["stable", "supersededBy"]
      : state?.promotionState === "Withdrawn" ? ["stable", "withdrawal"] : [];
  requireExactFields(state, [...common, ...additions], label);
  if (
    state.schemaVersion !== "1" || state.productVersion !== version ||
    !["Promotable", "Stable", "Superseded", "Withdrawn"].includes(state.promotionState)
  ) throw new ManifestCiError(`${label} has an invalid Promotion State`);
  requireExactFields(state.evidence, ["path", "sha256"], `${label} evidence`);
  requireExactFields(state.snapshot, ["path", "sha256"], `${label} snapshot`);
  requireExactFields(state.transaction, ["provisionalEvidenceDigest"], `${label} transaction`);
  if (state.evidence.path !== releasePaths(version).evidence || state.snapshot.path !== snapshotPath(version)) {
    throw new ManifestCiError(`${label} does not bind its versioned evidence and snapshot`);
  }
  requireDigest(state.evidence.sha256, `${label} evidence digest`);
  requireDigest(state.snapshot.sha256, `${label} snapshot digest`);
  requireDigest(state.transaction.provisionalEvidenceDigest, `${label} provisional evidence digest`);
  if (state.promotionState !== "Promotable") {
    requireExactFields(state.stable, ["acceptedBy", "source"], `${label} Stable acceptance`);
    if (state.stable.source !== "protected-release-environment" || !state.stable.acceptedBy) {
      throw new ManifestCiError(`${label} lacks a protected Release Owner Stable acceptance`);
    }
  }
  if (state.promotionState === "Superseded") requireVersion(state.supersededBy, `${label} superseding version`);
  if (state.promotionState === "Withdrawn") {
    requireExactFields(state.withdrawal, ["approvedBy", "reason", "rollbackTargetVersion"], `${label} withdrawal`);
    requireVersion(state.withdrawal.rollbackTargetVersion, `${label} rollback target version`);
    if (!state.withdrawal.approvedBy || !state.withdrawal.reason) throw new ManifestCiError(`${label} has incomplete withdrawal evidence`);
  }
}

function trackedFileMatches(repository, revision, filePath) {
  const committed = gitFile(repository, revision, filePath, true);
  return committed !== undefined ? committed : undefined;
}

async function recordReleaseEvidence(options) {
  const repository = path.resolve(required(options, "--repository"));
  const version = requireVersion(required(options, "--version"));
  const bundleRoot = path.resolve(required(options, "--bundle"));
  const authorization = await readReleaseAuthorization(options, "record-release-evidence", repository);
  requireCleanRepository(repository);
  const paths = releasePaths(version);
  await requireAbsentVersionIdentity(repository, paths);
  const input = validatePromotionBundle(await readProvisionalBundle(bundleRoot), version);
  if (input.ownerApproval.actor.login !== authorization.actor) {
    throw new ManifestCiError("Release Evidence owner must match the authenticated Release Owner workflow actor");
  }
  const head = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
  if (git(repository, ["merge-base", "--is-ancestor", input.candidate.manifestRevision, head], true).status !== 0) {
    throw new ManifestCiError("candidate snapshot commit must already be an ancestor of the evidence commit");
  }
  const snapshotXml = gitFile(repository, head, snapshotPath(version), true);
  if (snapshotXml === undefined || gitFile(repository, input.candidate.manifestRevision, snapshotPath(version), true) !== snapshotXml) {
    throw new ManifestCiError("immutable version snapshot must be committed before Release Evidence");
  }
  const projects = validateManifest(snapshotXml, snapshotPath(version));
  if (
    projects.find((entry) => entry.name === "tsfg.git")?.revision !== input.candidate.productRevision ||
    projects.find((entry) => entry.name === ".agents.git")?.revision !== input.candidate.agentRevision
  ) throw new ManifestCiError("version snapshot does not bind the proven candidate project revisions");
  const bundleEntries = input.bundle.entries;
  const evidence = {
    candidate: input.candidate,
    ownerApproval: input.ownerApproval,
    productTag: input.productTag,
    productVersion: version,
    provisionalEvidence: { contentAddress: input.bundle.contentAddress, entries: bundleEntries },
    recordedState: "Promotable",
    releaseMaterials: input.releaseMaterials,
    schemaVersion: "1",
    snapshot: { path: snapshotPath(version), sha256: byteDigest(snapshotXml) },
    sourceEvidence: {
      offlineProofSha256: bundleEntries.find((entry) => entry.path === "offline-proof.json").sha256,
      verifiedCandidateSha256: bundleEntries.find((entry) => entry.path === "verified-candidate.json").sha256,
      versionReadinessSha256: bundleEntries.find((entry) => entry.path === "version-readiness.json").sha256,
    },
  };
  const evidenceBytes = jsonBytes(evidence);
  const state = {
    evidence: { path: paths.evidence, sha256: byteDigest(evidenceBytes) },
    productVersion: version,
    promotionState: "Promotable",
    schemaVersion: "1",
    snapshot: evidence.snapshot,
    transaction: { provisionalEvidenceDigest: input.bundle.contentAddress },
  };
  await mkdir(path.join(repository, paths.root), { recursive: true });
  await atomicWrite(path.join(repository, paths.evidence), evidenceBytes);
  await atomicWrite(path.join(repository, paths.state), jsonBytes(state));
}

function currentReleaseVersion(repository, revision, defaultXml) {
  const snapshot = manifestPaths(repository, revision)
    .find((entry) => entry.startsWith("snapshots/") && gitFile(repository, revision, entry) === defaultXml);
  return snapshot ? /^snapshots\/tsfg-v(.+)\.xml$/.exec(snapshot)?.[1] : undefined;
}

function committedRelease(repository, version) {
  const head = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
  const paths = releasePaths(version);
  const evidenceSource = trackedFileMatches(repository, head, paths.evidence);
  const stateSource = trackedFileMatches(repository, head, paths.state);
  if (evidenceSource === undefined || stateSource === undefined) {
    throw new ManifestCiError("versioned Release Evidence and Promotion State must be committed before Stable");
  }
  const evidence = parseReleaseRecord(evidenceSource, paths.evidence);
  const state = parseReleaseRecord(stateSource, paths.state);
  validateReleaseEvidence(evidence, version, paths.evidence);
  validateReleaseState(state, version, paths.state);
  if (
    state.evidence.sha256 !== byteDigest(evidenceSource) ||
    state.snapshot.sha256 !== evidence.snapshot.sha256 ||
    state.transaction.provisionalEvidenceDigest !== evidence.provisionalEvidence.contentAddress
  ) throw new ManifestCiError("Promotion State does not bind the immutable Release Evidence");
  return { evidence, evidenceSource, head, paths, state, stateSource };
}

async function promoteStable(options) {
  const repository = path.resolve(required(options, "--repository"));
  const version = requireVersion(required(options, "--version"));
  const { actor } = await readReleaseAuthorization(options, "promote-stable", repository);
  requireCleanRepository(repository);
  const release = committedRelease(repository, version);
  if (release.state.promotionState !== "Promotable") throw new ManifestCiError("only a Promotable release can become Stable");
  const approvedActor = requireHumanOwner(release.evidence.ownerApproval, "Release Owner approval", {
    action: "promote-stable", candidateId: release.evidence.candidate.id, productVersion: version,
  }, ["additionalApprovals"]);
  requireAdditionalOwnerApprovals(release.evidence.ownerApproval, "Release Owner approval");
  if (actor !== approvedActor || /\[bot\]$/i.test(actor)) {
    throw new ManifestCiError("only the approved human Release Owner may perform Stable promotion");
  }
  const snapshotXml = gitFile(repository, release.head, snapshotPath(version));
  if (byteDigest(snapshotXml) !== release.state.snapshot.sha256) throw new ManifestCiError("Stable snapshot bytes drifted from Release Evidence");
  const currentDefault = gitFile(repository, release.head, "default.xml", true);
  if (currentDefault !== undefined) {
    const currentVersion = currentReleaseVersion(repository, release.head, currentDefault);
    if (!currentVersion || currentVersion === version) throw new ManifestCiError("current default does not identify a different Stable release");
    const current = committedRelease(repository, currentVersion);
    if (current.state.promotionState !== "Stable") throw new ManifestCiError("current default release is not Stable");
    await atomicWrite(path.join(repository, current.paths.state), jsonBytes({
      ...current.state, promotionState: "Superseded", supersededBy: version,
    }));
  }
  await atomicWrite(path.join(repository, release.paths.state), jsonBytes({
    ...release.state,
    promotionState: "Stable",
    stable: { acceptedBy: actor, source: "protected-release-environment" },
  }));
  await atomicWrite(path.join(repository, "default.xml"), Buffer.from(snapshotXml));
}

async function finalizeRelease(options) {
  const repository = path.resolve(required(options, "--repository"));
  const version = requireVersion(required(options, "--version"));
  const metadata = await readJson(path.resolve(required(options, "--metadata")), "post-Stable publication metadata");
  await readReleaseAuthorization(options, "finalize-release", repository);
  requireCleanRepository(repository);
  const release = committedRelease(repository, version);
  if (release.state.promotionState !== "Stable") throw new ManifestCiError("post-Stable metadata requires the current Stable release");
  const defaultXml = gitFile(repository, release.head, "default.xml", true);
  if (defaultXml === undefined || currentReleaseVersion(repository, release.head, defaultXml) !== version) {
    throw new ManifestCiError("post-Stable metadata cannot target a non-default release");
  }
  requireExactFields(metadata, ["productVersion", "publications", "schemaVersion", "status"], "post-Stable publication metadata");
  if (
    metadata.schemaVersion !== "1" || metadata.status !== "complete" || metadata.productVersion !== version ||
    !Array.isArray(metadata.publications) || metadata.publications.length === 0
  ) throw new ManifestCiError("post-Stable publication metadata is incomplete");
  for (const publication of metadata.publications) {
    requireExactFields(publication, ["immutableId", "kind", "url"], "publication");
    if (!publication.immutableId || !publication.kind || !/^https:\/\//.test(publication.url)) {
      throw new ManifestCiError("publication metadata requires an immutable identity and HTTPS URL");
    }
  }
  const output = {
    evidenceSha256: byteDigest(release.evidenceSource),
    ...metadata,
  };
  const outputBytes = jsonBytes(output);
  const existing = gitFile(repository, release.head, release.paths.publication, true);
  if (existing !== undefined) {
    if (existing !== outputBytes.toString("utf8")) throw new ManifestCiError("post-Stable metadata is immutable after its first finalization");
    return;
  }
  await atomicWrite(path.join(repository, release.paths.publication), outputBytes);
}

function wasHistoricallyStable(repository, version, revision) {
  const statePath = releasePaths(version).state;
  const commits = git(repository, ["log", "--format=%H", revision, "--", statePath]).stdout.split(/\r?\n/).filter(Boolean);
  return commits.some((commit) => {
    const source = gitFile(repository, commit, statePath, true);
    if (source === undefined) return false;
    try { return JSON.parse(source).promotionState === "Stable"; } catch { return false; }
  });
}

async function rollbackRelease(options) {
  const repository = path.resolve(required(options, "--repository"));
  const approval = await readJson(path.resolve(required(options, "--approval")), "rollback approval");
  const authorization = await readReleaseAuthorization(options, "rollback", repository);
  requireCleanRepository(repository);
  requireExactFields(approval, [
    "action", "actor", "decision", "fromVersion", "reason", "role", "schemaVersion", "source", "toVersion",
  ], "rollback approval");
  const fromVersion = requireVersion(approval.fromVersion, "rollback source version");
  const toVersion = requireVersion(approval.toVersion, "rollback target version");
  if (fromVersion === toVersion || !approval.reason) throw new ManifestCiError("rollback requires distinct releases and a reason");
  const actor = requireHumanOwner(approval, "rollback approval", { action: "rollback", fromVersion, reason: approval.reason, toVersion });
  if (actor !== authorization.actor) {
    throw new ManifestCiError("rollback approver must match the authenticated Release Owner workflow actor");
  }
  const current = committedRelease(repository, fromVersion);
  const target = committedRelease(repository, toVersion);
  const defaultXml = gitFile(repository, current.head, "default.xml", true);
  if (
    current.state.promotionState !== "Stable" || defaultXml === undefined ||
    currentReleaseVersion(repository, current.head, defaultXml) !== fromVersion
  ) throw new ManifestCiError("rollback source must be the current Stable default");
  if (target.state.promotionState !== "Superseded" || !wasHistoricallyStable(repository, toVersion, current.head)) {
    throw new ManifestCiError("rollback target must be an earlier immutable Stable release");
  }
  const targetSnapshot = gitFile(repository, current.head, target.state.snapshot.path);
  if (byteDigest(targetSnapshot) !== target.state.snapshot.sha256) throw new ManifestCiError("rollback target snapshot drifted from its evidence");
  await atomicWrite(path.join(repository, current.paths.state), jsonBytes({
    ...current.state,
    promotionState: "Withdrawn",
    withdrawal: { approvedBy: actor, reason: approval.reason, rollbackTargetVersion: toVersion },
  }));
  await atomicWrite(path.join(repository, "default.xml"), Buffer.from(targetSnapshot));
}

function requireFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestCiError(`${label} must be a structured evidence object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new ManifestCiError(`${label} contains a missing or undeclared evidence field`);
  }
}

function candidateReference(candidatePlan, overlay, summary) {
  requireFields(overlay, ["baseline", "replacements", "schemaVersion"], "Candidate Overlay");
  requireFields(overlay.baseline, ["manifest", "repository", "revision"], "Candidate Overlay baseline");
  requireFields(summary, [
    "overlayDigest", "resolvedManifestDigest", "resolvedManifestXmlSha256", "schemaVersion",
  ], "candidate summary");
  if (
    overlay.schemaVersion !== "1" || summary.schemaVersion !== "1" ||
    overlay.baseline.repository !== manifestRepositoryUrl ||
    summary.overlayDigest !== digest(overlay) ||
    summary.resolvedManifestDigest !== `sha256:${candidatePlan.id}` ||
    candidatePlan.candidateOverlayDigest !== summary.overlayDigest ||
    candidatePlan.manifestRepository !== overlay.baseline.repository
  ) throw new ManifestCiError("candidate summary does not bind the exact Candidate Overlay and resolved manifest");
  return {
    agentRevision: candidatePlan.agentRevision,
    candidateOverlayDigest: summary.overlayDigest,
    id: candidatePlan.id,
    manifest: candidatePlan.manifest,
    manifestRepository: overlay.baseline.repository,
    manifestRevision: candidatePlan.manifestRevision,
    productRevision: candidatePlan.productRevision,
    resolvedManifestDigest: `sha256:${candidatePlan.id}`,
  };
}

function validateResolvedCandidateIdentity(candidateId, candidatePlan, overlay, resolved, resolvedXml, summary) {
  const candidate = candidateReference(candidatePlan, overlay, summary);
  requireFields(resolved, ["baseline", "projects", "schemaVersion"], "resolved manifest");
  const resolvedProjects = validateManifest(resolvedXml.toString("utf8"), "resolved manifest XML")
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  if (
    resolved.schemaVersion !== "1" || summary.resolvedManifestDigest !== digest(resolved) ||
    summary.resolvedManifestXmlSha256 !== byteDigest(resolvedXml) ||
    summary.resolvedManifestDigest.slice("sha256:".length) !== candidateId ||
    canonicalize(resolved.baseline) !== canonicalize(overlay.baseline) ||
    canonicalize(resolved.projects) !== canonicalize(resolvedProjects) ||
    resolvedProjects.find((project) => project.name === "tsfg.git")?.revision !== candidatePlan.productRevision ||
    resolvedProjects.find((project) => project.name === ".agents.git")?.revision !== candidatePlan.agentRevision
  ) throw new ManifestCiError("candidate evidence does not bind the resolved manifest identity");
  return candidate;
}

function requireCandidateReference(actual, expected, label) {
  requireFields(actual, [
    "agentRevision", "candidateOverlayDigest", "id", "manifest", "manifestRepository", "manifestRevision",
    "productRevision", "resolvedManifestDigest",
  ], `${label} candidate`);
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new ManifestCiError(`${label} is not bound to the exact Candidate Integration`);
  }
}

function requireCanaries(canaries, label) {
  requireFields(canaries, ["after", "before"], `${label} canaries`);
  const expected = ["1.1.1.1:443", "8.8.8.8:443"];
  for (const phase of ["before", "after"]) {
    for (const entry of canaries?.[phase] ?? []) {
      requireFields(entry, ["endpoint", "status"], `${label} ${phase} canary`);
    }
    if (
      !Array.isArray(canaries?.[phase]) || canaries[phase].length !== expected.length ||
      expected.some((endpoint, index) =>
        canaries[phase][index]?.endpoint !== endpoint || canaries[phase][index]?.status !== "blocked")
    ) throw new ManifestCiError(`${label} does not prove blocked ${phase} network canaries`);
  }
}

function requireLinuxIsolation(report, label) {
  requireFields(report.isolation, ["boundary", "loopbackOnly", "status"], `${label} isolation`);
  requireCanaries(report.canaries, label);
  if (
    report.isolation?.boundary !== "linux-network-namespace" ||
    report.isolation?.loopbackOnly !== true ||
    report.isolation?.status !== "isolated"
  ) throw new ManifestCiError(`${label} does not prove loopback-only Linux network isolation`);
}

async function expectedCandidateBuild(candidateRoot, candidateId, target, profile) {
  let expected;
  let archiveSha256;
  for (const producer of ["a", "b"]) {
    const root = path.join(candidateRoot, "producers", candidateId, target, profile, producer);
    const report = await readJson(path.join(root, "package-report.json"), `${target}/${profile}/${producer} hosted package`);
    requireSuccess(report, `${target}/${profile}/${producer} hosted package`, "package");
    const identity = report.result?.buildIdentity;
    const archive = report.result?.archive;
    if (
      identity?.target !== target || identity?.profile !== profile ||
      !/^sha256:[0-9a-f]{64}$/.test(identity?.digest) ||
      !/^sha256:[0-9a-f]{64}$/.test(identity?.toolchainClosureDigest) ||
      typeof archive !== "string" || archive === "" || archive.includes("/") || archive.includes("\\")
    ) throw new ManifestCiError(`${target}/${profile}/${producer} hosted package identity is invalid`);
    const actualArchiveSha256 = byteDigest(await readFile(path.join(root, "package", archive)));
    const current = {
      buildIdentityDigest: identity.digest,
      toolchainClosureDigest: identity.toolchainClosureDigest,
    };
    if (expected && canonicalize(expected) !== canonicalize(current)) {
      throw new ManifestCiError(`${target}/${profile} hosted producers disagree on Build Identity`);
    }
    if (archiveSha256 && archiveSha256 !== actualArchiveSha256) {
      throw new ManifestCiError(`${target}/${profile} hosted producers disagree on package bytes`);
    }
    expected = current;
    archiveSha256 = actualArchiveSha256;
  }
  return { ...expected, archiveSha256 };
}

function requireCommonProof(report, candidate, target, profile, expected, label) {
  if (
    report?.schemaVersion !== "1" || report.status !== "success" ||
    report.target !== target || report.profile !== profile ||
    report.buildIdentityDigest !== expected.buildIdentityDigest ||
    report.toolchainClosureDigest !== expected.toolchainClosureDigest ||
    report.archiveSha256 !== expected.archiveSha256
  ) throw new ManifestCiError(`${label} does not match the verified Candidate Build Identity and package`);
  requireCandidateReference(report.candidate, candidate, label);
}

const linuxProofSourceFiles = {
  controllerAttestationSha256: "controller-attestation.json",
  isolationAttestationSha256: "isolation-attestation.json",
  osAttestationSha256: "os-attestation.json",
  packageReportSha256: "package-report.json",
  runtimeReportSha256: "runtime-report.json",
};

const windowsProofSourceFiles = {
  buildReportSha256: "build-report.json",
  cacheVerificationReportSha256: "cache-verification-report.json",
  controllerAttestationSha256: "controller-attestation.json",
  environmentAttestationSha256: "environment-attestation.json",
  packageReportSha256: "package-report.json",
  runtimeReportSha256: "runtime-report.json",
  testReportSha256: "test-report.json",
  virtualNetworkAttestationSha256: "virtual-network-attestation.json",
  workspaceReportSha256: "workspace-report.json",
};

async function requireRetainedSourceReports(root, sources, sourceFiles, label) {
  requireFields(sources, Object.keys(sourceFiles), `${label} sources`);
  for (const [field, fileName] of Object.entries(sourceFiles)) {
    const expected = sources[field];
    requireDigest(expected, `${label} ${field}`);
    const actual = byteDigest(await readFile(path.join(root, "sources", fileName)));
    if (actual !== expected) {
      throw new ManifestCiError(`${label} retained source report digest does not match ${fileName}`);
    }
  }
}

async function loadVerifiedCandidate(options) {
  const repository = path.resolve(required(options, "--repository"));
  const candidateRoot = path.resolve(required(options, "--candidate-evidence"));
  const candidateId = required(options, "--candidate-id");
  if (!/^[0-9a-f]{64}$/.test(candidateId)) throw new ManifestCiError("candidate id must be a complete content address");
  const candidateRunId = required(options, "--candidate-run-id");
  if (!/^[1-9][0-9]*$/.test(candidateRunId)) throw new ManifestCiError("candidate run id must be a positive decimal identifier");
  const candidateRunPath = path.resolve(required(options, "--candidate-run"));
  const candidateRunBytes = await readFile(candidateRunPath);
  const candidateRun = await readJson(candidateRunPath, "Manifest PR run provenance");
  const verdict = await readJson(path.resolve(required(options, "--verified-verdict")), "Verified Candidate verdict");
  const candidateEvidenceEntries = await Promise.all((await evidenceFiles(candidateRoot)).map(async (relativePath) => ({
    path: relativePath,
    sha256: byteDigest(await readFile(path.join(candidateRoot, ...relativePath.split("/")))),
  })));
  const candidateEvidenceDigest = digest({ entries: candidateEvidenceEntries, schemaVersion: "1" });
  if (
    verdict?.schemaVersion !== "1" || verdict.promotionState !== "Verified Candidate" ||
    verdict.evidenceDigest !== candidateEvidenceDigest || !Array.isArray(verdict.candidateIds) ||
    !verdict.candidateIds.includes(candidateId)
  ) throw new ManifestCiError("Offline Proof requires an unchanged Verified Candidate evidence bundle");
  const plan = await readJson(path.join(candidateRoot, "manifest-plan.json"), "manifest plan");
  const candidatePlan = plan?.candidates?.find((entry) => entry?.id === candidateId);
  if (!candidatePlan) throw new ManifestCiError("candidate id is not present in the verified manifest plan");
  for (const [value, label] of [
    [candidatePlan.manifestRevision, "candidate manifest revision"],
    [candidatePlan.productRevision, "candidate product revision"],
    [candidatePlan.agentRevision, "candidate agent revision"],
  ]) requireOid(value, label);
  const candidateIdentityRoot = path.join(candidateRoot, "candidates", candidateId);
  const overlay = await readJson(path.join(candidateIdentityRoot, "candidate-overlay.json"), "Candidate Overlay");
  const summary = await readJson(path.join(candidateIdentityRoot, "candidate-summary.json"), "candidate summary");
  const resolved = await readJson(path.join(candidateIdentityRoot, "resolved-manifest.json"), "resolved manifest");
  const resolvedXml = await readFile(path.join(candidateIdentityRoot, "resolved-manifest.xml"));
  const candidate = validateResolvedCandidateIdentity(
    candidateId, candidatePlan, overlay, resolved, resolvedXml, summary,
  );
  if (git(repository, ["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false") {
    throw new ManifestCiError("Candidate provenance requires a complete Manifest Repository clone");
  }
  const sourceManifestXml = gitFile(repository, candidatePlan.manifestRevision, candidatePlan.manifest, true);
  if (
    !/^snapshots\/tsfg-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.xml$/.test(candidatePlan.manifest) ||
    sourceManifestXml === undefined || !Buffer.from(sourceManifestXml).equals(resolvedXml)
  ) {
    throw new ManifestCiError("resolved Candidate bytes do not match the manifest revision");
  }
  const pullRequests = candidateRun?.pull_requests;
  const pullRequest = Array.isArray(pullRequests) && pullRequests.length === 1 ? pullRequests[0] : undefined;
  if (
    String(candidateRun?.id) !== candidateRunId || candidateRun?.status !== "completed" ||
    candidateRun?.conclusion !== "success" || candidateRun?.event !== "pull_request" ||
    !completeOid.test(candidateRun?.head_sha) || pullRequest?.head?.sha !== candidatePlan.manifestRevision ||
    !completeOid.test(pullRequest?.base?.sha) || pullRequest?.base?.ref !== "main" ||
    !Number.isSafeInteger(candidateRun?.repository?.id) || candidateRun.repository.id < 1 ||
    pullRequest?.base?.repo?.id !== candidateRun.repository.id ||
    !Number.isSafeInteger(pullRequest?.number) || pullRequest.number < 1 ||
    candidateRun?.path !== ".github/workflows/manifest-pr.yml" ||
    candidateRun?.repository?.full_name !== "xuelongling/manifests"
  ) throw new ManifestCiError("Verified Candidate must come from the trusted Manifest PR workflow");
  for (const controlPath of [
    ".github/workflows/manifest-pr.yml",
    "tools/manifest-ci.mjs",
    "tools/network-canary.mjs",
  ]) {
    const trustedBytes = gitFile(repository, pullRequest.base.sha, controlPath, true);
    const candidateBytes = gitFile(repository, pullRequest.head.sha, controlPath, true);
    if (trustedBytes === undefined || candidateBytes === undefined || trustedBytes !== candidateBytes) {
      throw new ManifestCiError(`Candidate changed trusted hosted proof control: ${controlPath}`);
    }
  }
  return {
    candidate, candidateEvidenceDigest, candidateId, candidatePlan, candidateRoot,
    candidateRun, candidateRunBytes, candidateRunId,
  };
}

async function candidateProofInput(options) {
  const verified = await loadVerifiedCandidate(options);
  await atomicWrite(path.resolve(required(options, "--out")), jsonBytes({
    candidate: verified.candidate,
    candidateEvidenceDigest: verified.candidateEvidenceDigest,
    candidateRun: {
      repository: verified.candidateRun.repository.full_name,
      runId: verified.candidateRunId,
      workflow: verified.candidateRun.path,
      workflowCommit: verified.candidateRun.head_sha,
    },
    proofInput: "Verified Candidate",
    schemaVersion: "1",
    status: "success",
  }));
}

async function offlineProof(options) {
  const {
    candidate, candidateEvidenceDigest, candidateId, candidateRoot,
    candidateRun, candidateRunBytes, candidateRunId,
  } = await loadVerifiedCandidate(options);
  const proofRoot = path.resolve(required(options, "--proof-evidence"));
  const controllerRunId = required(options, "--controller-run-id");
  if (!/^[1-9][0-9]*$/.test(controllerRunId)) throw new ManifestCiError("controller run id must be a positive decimal identifier");
  const controllerRunPath = path.resolve(required(options, "--controller-run"));
  const controllerRunBytes = await readFile(controllerRunPath);
  const controllerRun = await readJson(controllerRunPath, "Tier 1 VM controller run provenance");
  if (
    String(controllerRun?.id) !== controllerRunId || controllerRun?.status !== "completed" ||
    controllerRun?.conclusion !== "success" || controllerRun?.event !== "workflow_dispatch" ||
    controllerRun?.head_branch !== "main" || !completeOid.test(controllerRun?.head_sha) ||
    controllerRun?.path !== ".github/workflows/tier1-vm-controller.yml" ||
    controllerRun?.repository?.full_name !== "xuelongling/manifests"
  ) throw new ManifestCiError("Offline Proof requires the trusted Tier 1 VM controller workflow on manifest main");
  const profile = "release";
  const expectedProofFiles = [
    `linux-minimum/${candidateId}/${profile}/report.json`,
    ...Object.values(linuxProofSourceFiles).map(
      (fileName) => `linux-minimum/${candidateId}/${profile}/sources/${fileName}`,
    ),
    ...["a", "b"].flatMap((vm) => [
      `windows/${candidateId}/${vm}/${profile}/report.json`,
      ...Object.values(windowsProofSourceFiles).map(
        (fileName) => `windows/${candidateId}/${vm}/${profile}/sources/${fileName}`,
      ),
    ]),
  ];
  const proofFiles = await evidenceFiles(proofRoot);
  if (
    proofFiles.length !== expectedProofFiles.length ||
    proofFiles.some((relativePath) => !expectedProofFiles.includes(relativePath))
  ) throw new ManifestCiError("controller artifact contains a missing or undeclared proof evidence file");
  let hostedLinux = 0;
  let linuxMinimumRuntime = 0;
  let windowsReplays = 0;
  const builds = [];
  const vmEvidence = new Map();
  const windowsBuildOutputs = new Set();
  {
    const linuxExpected = await expectedCandidateBuild(candidateRoot, candidateId, "linux-x86_64-gnu", profile);
    builds.push({
      buildIdentityDigest: linuxExpected.buildIdentityDigest,
      profile,
      target: "linux-x86_64-gnu",
      toolchainClosureDigest: linuxExpected.toolchainClosureDigest,
    });
    for (const producer of ["a", "b"]) {
      const label = `hosted Linux ${profile}/${producer}`;
      const hostedRoot = path.join(candidateRoot, "hosted-offline", candidateId, profile, producer);
      const report = await readJson(
        path.join(hostedRoot, "report.json"),
        label,
      );
      requireFields(report, [
        "buildIdentityDigest", "candidate", "canaries", "isolation", "producer", "profile", "schemaVersion",
        "sources", "status", "target", "toolchainClosureDigest",
      ], label);
      requireFields(report.sources, [
        "canaryAfterSha256", "canaryBeforeSha256", "packageReportSha256",
      ], `${label} sources`);
      if (
        report?.schemaVersion !== "1" || report.status !== "success" || report.target !== "linux-x86_64-gnu" ||
        report.profile !== profile || report.producer !== producer ||
        report.buildIdentityDigest !== linuxExpected.buildIdentityDigest ||
        report.toolchainClosureDigest !== linuxExpected.toolchainClosureDigest
      ) throw new ManifestCiError(`${label} is not bound to its hosted Candidate build`);
      requireCandidateReference(report.candidate, candidate, label);
      requireLinuxIsolation(report, label);
      for (const phase of ["before", "after"]) {
        const sourcePath = path.join(hostedRoot, `canary-${phase}.json`);
        const source = await readJson(sourcePath, `${label} ${phase} canary source`);
        requireFields(source, ["canaries", "schemaVersion", "status"], `${label} ${phase} canary source`);
        if (
          source.schemaVersion !== "1" || source.status !== "success" ||
          canonicalize(source.canaries) !== canonicalize(report.canaries[phase]) ||
          report.sources[`canary${phase[0].toUpperCase()}${phase.slice(1)}Sha256`] !== byteDigest(await readFile(sourcePath))
        ) throw new ManifestCiError(`${label} ${phase} canary source is not bound to the hosted report`);
      }
      const packageReportPath = path.join(
        candidateRoot, "producers", candidateId, "linux-x86_64-gnu", profile, producer, "package-report.json",
      );
      if (report.sources.packageReportSha256 !== byteDigest(await readFile(packageReportPath))) {
        throw new ManifestCiError(`${label} package source is not bound to the hosted report`);
      }
      for (const [value, name] of [
        [report.sources.canaryBeforeSha256, "before canary report"],
        [report.sources.canaryAfterSha256, "after canary report"],
        [report.sources.packageReportSha256, "package report"],
      ]) requireDigest(value, `${label} ${name}`);
      hostedLinux += 1;
    }
    const linuxLabel = `minimum Linux ${profile}`;
    const linux = await readJson(
      path.join(proofRoot, "linux-minimum", candidateId, profile, "report.json"),
      linuxLabel,
    );
    requireFields(linux, [
      "archiveSha256", "buildIdentityDigest", "candidate", "canaries", "controller", "environment", "isolation",
      "profile", "runtimeSmoke", "schemaVersion", "sources", "status", "target", "toolchainClosureDigest",
    ], linuxLabel);
    requireFields(linux.controller, [
      "attestationSha256", "executionChannel", "sourceReportsDigest", "status",
    ], `${linuxLabel} controller`);
    requireFields(linux.environment, [
      "architecture", "attestationSha256", "distribution", "distributionVersion", "glibcVersion", "kernelRelease",
    ], `${linuxLabel} environment`);
    requireFields(linux.runtimeSmoke, ["cpp", "reportSha256", "status", "zig"], `${linuxLabel} runtime smoke`);
    await requireRetainedSourceReports(
      path.join(proofRoot, "linux-minimum", candidateId, profile),
      linux.sources,
      linuxProofSourceFiles,
      linuxLabel,
    );
    requireCommonProof(linux, candidate, "linux-x86_64-gnu", profile, linuxExpected, linuxLabel);
    requireLinuxIsolation(linux, linuxLabel);
    if (
      linux.environment?.distribution !== "Debian GNU/Linux" ||
      linux.environment?.distributionVersion !== "12.15" || linux.environment?.glibcVersion !== "2.36" ||
      !/^6\.1(?:\.|-)/.test(linux.environment?.kernelRelease) || linux.environment?.architecture !== "x86_64" ||
      linux.runtimeSmoke?.status !== "passed" ||
      linux.runtimeSmoke?.cpp !== "passed" || linux.runtimeSmoke?.zig !== "passed" ||
      linux.controller?.executionChannel !== "out-of-band" || linux.controller?.status !== "attested" ||
      linux.controller?.sourceReportsDigest !== digest(linux.sources)
    ) throw new ManifestCiError(`${linuxLabel} does not prove the exact minimum baseline runtime smoke`);
    for (const [value, name] of [
      [linux.environment.attestationSha256, "OS attestation"],
      [linux.controller.attestationSha256, "controller attestation"],
      [linux.controller.sourceReportsDigest, "controller source reports"],
      [linux.runtimeSmoke.reportSha256, "runtime report"],
      [linux.sources.isolationAttestationSha256, "isolation attestation"],
      [linux.sources.osAttestationSha256, "source OS attestation"],
      [linux.sources.packageReportSha256, "package report"],
      [linux.sources.runtimeReportSha256, "source runtime report"],
    ]) requireDigest(value, `${linuxLabel} ${name}`);
    if (
      linux.sources.osAttestationSha256 !== linux.environment.attestationSha256 ||
      linux.sources.runtimeReportSha256 !== linux.runtimeSmoke.reportSha256 ||
      linux.sources.controllerAttestationSha256 !== linux.controller.attestationSha256
    ) throw new ManifestCiError(`${linuxLabel} source digests do not bind its attestations and runtime report`);
    linuxMinimumRuntime += 1;

    const windowsExpected = await expectedCandidateBuild(candidateRoot, candidateId, "windows-x86_64-msvc", profile);
    builds.push({
      buildIdentityDigest: windowsExpected.buildIdentityDigest,
      profile,
      target: "windows-x86_64-msvc",
      toolchainClosureDigest: windowsExpected.toolchainClosureDigest,
    });
    for (const vm of ["a", "b"]) {
      const label = `Windows VM ${vm}/${profile}`;
      const report = await readJson(path.join(proofRoot, "windows", candidateId, vm, profile, "report.json"), label);
      requireFields(report, [
        "archiveSha256", "buildIdentityDigest", "buildOutputPathDigest", "cache", "candidate", "canaries", "commands",
        "controller", "environment", "processIsolation", "profile", "schemaVersion", "status", "target", "toolchainClosureDigest",
        "sources", "virtualNetwork", "vm", "vmIdentityDigest", "workspacePathDigest",
      ], label);
      requireFields(report.environment, [
        "architecture", "attestationSha256", "buildNumber", "displayVersion", "product",
      ], `${label} environment`);
      requireFields(report.virtualNetwork, [
        "attestationSha256", "configuredBy", "externalAdapters", "status",
      ], `${label} virtual network`);
      requireFields(report.processIsolation, ["mode", "scope", "status"], `${label} process isolation`);
      requireFields(report.controller, [
        "attestationSha256", "executionChannel", "networkAuthority", "sourceReportsDigest", "status",
      ], `${label} controller`);
      await requireRetainedSourceReports(
        path.join(proofRoot, "windows", candidateId, vm, profile),
        report.sources,
        windowsProofSourceFiles,
        label,
      );
      requireFields(report.cache, [
        "addressing", "cacheKey", "injectedArtifactSha256", "objectVerification", "pathDigest",
        "toolchainClosureDigest", "unexpectedObjects", "verificationReportSha256",
      ], `${label} cache`);
      requireFields(report.commands, [
        "build", "package", "runtimeSmoke", "test", "workspaceVerification",
      ], `${label} commands`);
      requireFields(report.commands.build, [
        "buildExecuted", "buildIdentityDigest", "processIsolation", "reportSha256", "status",
      ], `${label} build`);
      requireFields(report.commands.package, [
        "buildIdentityDigest", "processIsolation", "reportSha256", "source", "status",
      ], `${label} package`);
      requireFields(report.commands.runtimeSmoke, [
        "cpp", "processIsolation", "reportSha256", "source", "status", "zig",
      ], `${label} runtime smoke`);
      requireFields(report.commands.test, [
        "buildIdentityDigest", "processIsolation", "reportSha256", "status",
      ], `${label} test`);
      requireFields(report.commands.workspaceVerification, [
        "processIsolation", "reportSha256", "status",
      ], `${label} workspace verification`);
      requireCommonProof(report, candidate, "windows-x86_64-msvc", profile, windowsExpected, label);
      requireCanaries(report.canaries, label);
      if (
        report.vm !== vm || report.environment?.product !== "Windows 11" ||
        report.environment?.displayVersion !== "24H2" || report.environment?.buildNumber !== "26100" ||
        report.environment?.architecture !== "AMD64" ||
        report.controller?.executionChannel !== "out-of-band" ||
        report.controller?.networkAuthority !== "host-hypervisor" || report.controller?.status !== "attested" ||
        report.controller?.sourceReportsDigest !== digest(report.sources) ||
        report.virtualNetwork?.configuredBy !== "hypervisor" ||
        report.virtualNetwork?.externalAdapters !== "disconnected" || report.virtualNetwork?.status !== "disconnected" ||
        report.processIsolation?.mode !== "wfp-dynamic-app-id" ||
        report.processIsolation?.scope !== "locked-process-set" || report.processIsolation?.status !== "blocked"
      ) throw new ManifestCiError(`${label} does not prove Windows 11 24H2 virtual-network and process isolation`);
      for (const [name, command] of Object.entries(report.commands ?? {})) {
        if (command?.status !== "passed") throw new ManifestCiError(`${label} command ${name} did not pass`);
      }
      if (
        report.commands?.workspaceVerification?.status !== "passed" ||
        report.commands.workspaceVerification.processIsolation !== "blocked" ||
        report.commands?.build?.status !== "passed" || report.commands.build.buildExecuted !== true ||
        report.commands.build.processIsolation !== "blocked" ||
        report.commands.build.buildIdentityDigest !== windowsExpected.buildIdentityDigest ||
        report.commands?.test?.status !== "passed" || report.commands.test.processIsolation !== "blocked" ||
        report.commands.test.buildIdentityDigest !== windowsExpected.buildIdentityDigest ||
        report.commands?.package?.status !== "passed" || report.commands.package.source !== "local-build" ||
        report.commands.package.processIsolation !== "blocked" ||
        report.commands.package.buildIdentityDigest !== windowsExpected.buildIdentityDigest ||
        report.commands?.runtimeSmoke?.status !== "passed" || report.commands.runtimeSmoke.source !== "local-package" ||
        report.commands.runtimeSmoke.processIsolation !== "blocked" ||
        report.commands.runtimeSmoke.cpp !== "passed" || report.commands.runtimeSmoke.zig !== "passed" ||
        report.cache?.addressing !== "sha256" || report.cache?.objectVerification !== "complete" ||
        report.cache?.toolchainClosureDigest !== windowsExpected.toolchainClosureDigest ||
        report.cache?.cacheKey !== `windows-x86_64-msvc/sha256/${windowsExpected.toolchainClosureDigest.slice("sha256:".length)}` ||
        report.cache?.unexpectedObjects !== "rejected"
      ) throw new ManifestCiError(`${label} does not contain an independent complete cache-verified replay`);
      if (
        report.sources.buildReportSha256 !== report.commands.build.reportSha256 ||
        report.sources.cacheVerificationReportSha256 !== report.cache.verificationReportSha256 ||
        report.sources.environmentAttestationSha256 !== report.environment.attestationSha256 ||
        report.sources.packageReportSha256 !== report.commands.package.reportSha256 ||
        report.sources.runtimeReportSha256 !== report.commands.runtimeSmoke.reportSha256 ||
        report.sources.testReportSha256 !== report.commands.test.reportSha256 ||
        report.sources.virtualNetworkAttestationSha256 !== report.virtualNetwork.attestationSha256 ||
        report.sources.workspaceReportSha256 !== report.commands.workspaceVerification.reportSha256
        || report.sources.controllerAttestationSha256 !== report.controller.attestationSha256
      ) throw new ManifestCiError(`${label} source digests do not bind its command and environment reports`);
      for (const [value, name] of [
        [report.vmIdentityDigest, "VM identity"],
        [report.workspacePathDigest, "workspace path"],
        [report.buildOutputPathDigest, "build output path"],
        [report.cache?.pathDigest, "cache path"],
        [report.cache?.injectedArtifactSha256, "injected cache"],
        [report.cache?.verificationReportSha256, "cache verification report"],
        [report.controller?.attestationSha256, "controller attestation"],
        [report.controller?.sourceReportsDigest, "controller source reports"],
        [report.environment?.attestationSha256, "OS attestation"],
        [report.virtualNetwork?.attestationSha256, "virtual network attestation"],
        [report.commands?.workspaceVerification?.reportSha256, "workspace report"],
        [report.commands?.build?.reportSha256, "build report"],
        [report.commands?.test?.reportSha256, "test report"],
        [report.commands?.package?.reportSha256, "package report"],
        [report.commands?.runtimeSmoke?.reportSha256, "runtime report"],
      ]) requireDigest(value, `${label} ${name}`);
      if (windowsBuildOutputs.has(report.buildOutputPathDigest)) {
        throw new ManifestCiError(`${label} does not use an independent Windows VM build output`);
      }
      windowsBuildOutputs.add(report.buildOutputPathDigest);
      const previous = vmEvidence.get(vm);
      const current = {
        cacheArtifact: report.cache.injectedArtifactSha256,
        cachePath: report.cache.pathDigest,
        identity: report.vmIdentityDigest,
        workspace: report.workspacePathDigest,
      };
      if (previous && canonicalize(previous) !== canonicalize(current)) {
        throw new ManifestCiError(`${label} changes VM, workspace, or injected cache identity between profiles`);
      }
      vmEvidence.set(vm, current);
      windowsReplays += 1;
    }
  }
  const first = vmEvidence.get("a");
  const second = vmEvidence.get("b");
  if (
    first.identity === second.identity || first.workspace === second.workspace || first.cachePath === second.cachePath ||
    first.cacheArtifact !== second.cacheArtifact
  ) throw new ManifestCiError("Windows Offline Proof requires two independent VMs and roots with the same injected cache identity");
  const proofEntries = await Promise.all(proofFiles.map(async (relativePath) => ({
    path: relativePath,
    sha256: byteDigest(await readFile(path.join(proofRoot, ...relativePath.split("/")))),
  })));
  const targetOrder = new Map([["linux-x86_64-gnu", 0], ["windows-x86_64-msvc", 1]]);
  builds.sort((left, right) =>
    targetOrder.get(left.target) - targetOrder.get(right.target));
  await atomicWrite(path.resolve(required(options, "--out")), jsonBytes({
    builds,
    candidate,
    candidateIds: [candidateId],
    candidateRun: {
      repository: candidateRun.repository.full_name,
      runId: candidateRunId,
      workflow: candidateRun.path,
      workflowCommit: candidateRun.head_sha,
    },
    controllerRun: {
      repository: controllerRun.repository.full_name,
      runId: controllerRunId,
      workflow: controllerRun.path,
      workflowCommit: controllerRun.head_sha,
    },
    evidenceDigest: digest({
      candidateEvidenceDigest,
      candidateRunSha256: byteDigest(candidateRunBytes),
      controllerRunSha256: byteDigest(controllerRunBytes),
      entries: proofEntries,
      schemaVersion: "1",
    }),
    proof: "Offline Proof",
    requiredEvidence: {
      hostedLinux: `${hostedLinux}/2`,
      linuxMinimumRuntime: `${linuxMinimumRuntime}/1`,
      windowsIndependentVms: `${vmEvidence.size}/2`,
      windowsReplays: `${windowsReplays}/2`,
    },
    schemaVersion: "1",
    status: "success",
  }));
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
    validateResolvedCandidateIdentity(id, candidatePlan, overlay, resolved, resolvedXml, summary);
    requireOid(candidatePlan.manifestRevision, "candidate manifest revision");
    requireOid(candidatePlan.baselineProductRevision, "baseline product revision");
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
    candidateIds: plan.candidates.map((candidatePlan) => candidatePlan.id),
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
    const remoteMain = git(repository, ["rev-parse", "refs/remotes/origin/main"], true);
    const trustedMain = remoteMain.status === 0
      ? remoteMain.stdout.trim()
      : git(repository, ["rev-parse", "refs/heads/main"]).stdout.trim();
    if (trustedMain !== baselineRevision) {
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
  const effectiveReplacements = replacements.filter((replacement) =>
    projects.find((project) => project.name === replacement.project)?.revision !== replacement.revision);
  if (effectiveReplacements.length === 0) {
    throw new ManifestCiError("Candidate Overlay must contain at least one effective project revision change");
  }
  effectiveReplacements.sort((left, right) => Buffer.from(left.project).compare(Buffer.from(right.project)));

  const baseline = { manifest: manifestName, repository: manifestRepositoryUrl, revision: baselineRevision };
  const overlay = { baseline, replacements: effectiveReplacements, schemaVersion: "1" };
  const resolvedProjects = projects
    .map((project) => ({
      ...project,
      revision: effectiveReplacements.find((replacement) => replacement.project === project.name)?.revision ?? project.revision,
    }))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const resolved = { baseline, projects: resolvedProjects, schemaVersion: "1" };
  const replacementByProject = new Map(effectiveReplacements.map((entry) => [entry.project, entry.revision]));
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
  } else if (command === "candidate-proof-input") {
    await candidateProofInput(parseOptions(arguments_, new Set([
      "--repository", "--candidate-evidence", "--verified-verdict", "--candidate-id", "--candidate-run", "--candidate-run-id", "--out",
    ])));
  } else if (command === "offline-proof") {
    await offlineProof(parseOptions(arguments_, new Set([
      "--repository", "--candidate-evidence", "--verified-verdict", "--candidate-id", "--candidate-run", "--candidate-run-id",
      "--controller-run", "--controller-run-id", "--proof-evidence", "--out",
    ])));
  } else if (command === "release-owner-context") {
    await releaseOwnerContext(parseOptions(arguments_, new Set([
      "--repository", "--run", "--reviews", "--run-id", "--operation", "--actor", "--triggering-actor",
      "--ref", "--sha", "--out",
    ])));
  } else if (command === "record-release-evidence") {
    await recordReleaseEvidence(parseOptions(arguments_, new Set(["--repository", "--version", "--bundle", "--authorization"])));
  } else if (command === "promote-stable") {
    await promoteStable(parseOptions(arguments_, new Set(["--repository", "--version", "--authorization"])));
  } else if (command === "finalize-release") {
    await finalizeRelease(parseOptions(arguments_, new Set(["--repository", "--version", "--metadata", "--authorization"])));
  } else if (command === "rollback") {
    await rollbackRelease(parseOptions(arguments_, new Set(["--repository", "--approval", "--authorization"])));
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
