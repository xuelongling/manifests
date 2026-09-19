// SPDX-License-Identifier: MIT

const identityKeys = ["projectId", "forkOid", "path", "sha256", "role", "consumer"];
const note = value => typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const fail = () => { throw new Error("upgrade risk records or explicit fixture authorization are invalid"); };

/** Independently check fixture receipts against manifest-approved files; never execute product code. */
export function requireRiskRecords(result, name, admission, digest, canonicalize) {
  const review = result.replay?.plan?.risks, reported = result.risks?.[name];
  const snapshot = result.replay?.plan?.[name], integration = result.rollback ?? result.integrations?.[name];
  if (review?.schemaVersion !== "1" || review.evidenceKind !== "fixture" || !Array.isArray(review.records) ||
      !Array.isArray(review.approvals) || !Array.isArray(reported?.records) ||
      reported.records.length !== review.records.length || !Array.isArray(snapshot?.declaration?.sources)) fail();
  const files = [];
  for (const source of snapshot.declaration.sources) {
    const approved = admission?.sources.find(item => item.projectId === source.projectId);
    if (!approved || source.forkOid !== approved.forkOid || source.baseOid !== approved.baseOid || !Array.isArray(source.entries)) fail();
    for (const entry of source.entries) {
      const mapping = approved.files.find(item => item.path === entry.path);
      if (!mapping?.sha256 || !["build-only", "compiler-payload", "game-runtime"].includes(entry.role) ||
          !note(entry.consumer) || (/typescript/i.test(source.projectId) && entry.role === "game-runtime")) fail();
      files.push({ projectId: source.projectId, forkOid: source.forkOid, path: entry.path,
        sha256: mapping.sha256, role: entry.role, consumer: entry.consumer, license: approved.license });
    }
  }
  const seen = new Set();
  for (const [index, record] of review.records.entries()) {
    const receipt = reported.records[index];
    if (!receipt || !record || !note(record.id) || !record.id.startsWith("fixture:") || record.evidenceKind !== "fixture" ||
        !note(record.basis) || !note(record.owner) || !note(record.reviewPoint) || !date(record.deadline) ||
        !["exploitable", "trust-integrity", "unknown", "not-applicable", "exception-required"].includes(record.impact) ||
        !["reachable", "unreachable", "unknown"].includes(record.reachability) ||
        !identityKeys.every(key => note(record.subject?.[key])) || !/^[0-9a-f]{40}$/.test(record.subject.forkOid) ||
        !/^sha256:[0-9a-f]{64}$/.test(record.subject.sha256)) fail();
    const key = canonicalize({ id: record.id, subject: record.subject });
    if (seen.has(key)) fail();
    seen.add(key);
    const { decision, approval, license, ...original } = receipt;
    if (canonicalize(original) !== canonicalize(record)) fail();
    const knownFile = files.find(file => ["projectId", "forkOid", "path"].every(key => file[key] === record.subject[key]));
    if (knownFile && knownFile.sha256 !== record.subject.sha256) fail();
    const file = files.find(file => identityKeys.every(key => file[key] === record.subject[key]));
    if (!file) {
      if (decision !== "unaffected-identity" || license !== null || approval !== null) fail();
      continue;
    }
    if (license !== file.license) fail();
    if (record.impact === "not-applicable" && record.reachability === "unreachable") {
      if (decision !== "not-applicable" || approval !== null) fail();
      continue;
    }
    if (record.impact !== "exception-required" || record.reachability === "unknown" || decision !== "exception-approved" ||
        approval?.evidenceKind !== "fixture" || approval.authority !== "explicit-user" || approval.decision !== "approved" ||
        !note(approval.actor) || !approval.actor.startsWith("fixture:") ||
        !note(approval.reference) || !approval.reference.startsWith("fixture:") ||
        approval.riskId !== record.id || approval.riskSha256 !== digest(record) ||
        approval.reviewInputsSha256 !== result.reviewInputs[name] ||
        approval.manifestRevision !== integration.revision || approval.manifest !== integration.manifest ||
        !date(approval.expiresOn) || approval.expiresOn < new Date().toISOString().slice(0, 10) ||
        !identityKeys.every(key => approval.subject?.[key] === record.subject[key]) ||
        !review.approvals.some(input => canonicalize(input) === canonicalize(approval))) fail();
  }
}
