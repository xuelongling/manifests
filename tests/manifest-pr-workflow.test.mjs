// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repositoryRoot, ".github", "workflows", "manifest-pr.yml");

async function workflow() {
  return readFile(workflowPath, "utf8");
}

function job(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:|(?![\\s\\S]))`, "m"));
  assert.ok(match, `missing ${name} job`);
  return match[0];
}

test("manifest candidates run only in an unprivileged pull-request workflow", async () => {
  const source = await workflow();
  assert.match(source, /^on:\n  pull_request:\s*$/m);
  assert.match(source, /^permissions:\n  contents: read\s*$/m);
  assert.doesNotMatch(source, /pull_request_target|\bsecrets\b/i);
  assert.doesNotMatch(source, /(?:ubuntu|windows)-latest/);
  assert.match(source, /ubuntu-24\.04/);
  assert.match(source, /windows-2025/);

  const actionReferences = [...source.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.ok(actionReferences.length > 0, "workflow must pin every action dependency");
  for (const reference of actionReferences) {
    assert.match(reference, /^[^@\s]+@[0-9a-f]{40}$/, reference);
  }

  const checkoutSteps = source.match(/- uses: actions\/checkout@[0-9a-f]{40}[\s\S]*?(?=\n\s*- (?:uses:|name:)|\n\S|$)/g) ?? [];
  assert.ok(checkoutSteps.length > 0, "workflow must check out candidate inputs");
  for (const checkout of checkoutSteps) {
    assert.match(checkout, /fetch-depth: 0/);
    assert.match(checkout, /persist-credentials: false/);
  }
});

test("repository gate compares the pull-request history and publishes its candidate plan", async () => {
  const source = await workflow();
  const gate = job(source, "repository-gate");
  assert.doesNotMatch(gate, /^\s*if:/m, "repository gate must also run when no manifest changed");
  assert.match(gate, /pwsh -NoProfile -File tests\/run\.ps1/);
  assert.match(
    gate,
    /node tools\/manifest-ci\.mjs gate --repository \. --base "\$\{\{ github\.event\.pull_request\.base\.sha \}\}" --head "\$\{\{ github\.event\.pull_request\.head\.sha \}\}" --out \.ci\/manifest-gate/,
  );
  assert.match(gate, /manifest-plan\.json/);
  assert.match(gate, /has-candidates=.*GITHUB_OUTPUT/s);
  assert.match(gate, /candidates=.*GITHUB_OUTPUT/s);
  assert.match(gate, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(gate, /path: \.ci\/manifest-gate\//);
  assert.match(gate, /retention-days: 90/);
});

test("every resolved candidate records Agent Infrastructure verification evidence", async () => {
  const source = await workflow();
  const agent = job(source, "agent-evidence");
  assert.match(agent, /needs: \[repository-gate\]/);
  assert.match(agent, /if: needs\.repository-gate\.outputs\.has-candidates == 'true'/);
  assert.match(agent, /candidate: \$\{\{ fromJSON\(needs\.repository-gate\.outputs\.candidates\) \}\}/);
  assert.match(agent, /repository: xuelongling\/\.agents/);
  assert.match(agent, /ref: \$\{\{ matrix\.candidate\.agentRevision \}\}/);
  assert.match(agent, /corepack pnpm@11\.25\.0 install --frozen-lockfile/);
  assert.match(agent, /corepack pnpm@11\.25\.0 verify/);
  assert.match(agent, /agent\/\$\{\{ matrix\.candidate\.id \}\}\/report\.json/);
  assert.match(agent, /retention-days: 90/);
});

test("every resolved product runs repository gates and publishes candidate-bound evidence", async () => {
  const source = await workflow();
  const gates = job(source, "repository-gates");
  assert.match(gates, /needs: \[repository-gate\]/);
  assert.match(gates, /candidate: \$\{\{ fromJSON\(needs\.repository-gate\.outputs\.candidates\) \}\}/);
  assert.match(gates, /repository: xuelongling\/tsfg/);
  assert.match(gates, /ref: \$\{\{ matrix\.candidate\.productRevision \}\}/);
  assert.match(gates, /corepack pnpm@11\.25\.0 install --frozen-lockfile/);
  assert.match(gates, /git diff --check/);
  assert.match(gates, /workspace-policy-cli\.test\.mjs/);
  assert.match(gates, /toolchain-lock\.test\.mjs/);
  assert.match(gates, /typescript\/bin\/tsc --noEmit/);
  assert.match(gates, /repository-gates\/\$\{\{ matrix\.candidate\.id \}\}\/report\.json/);
  assert.match(gates, /candidateId:process\.env\.TSFG_CANDIDATE_ID/);
  assert.match(gates, /productRevision:process\.env\.TSFG_PRODUCT_REVISION/);
  assert.match(gates, /retention-days: 90/);

  assert.match(job(source, "product-build"), /needs: \[[^\]]*repository-gates[^\]]*\]/);
  assert.match(job(source, "candidate-evidence"), /needs: \[[^\]]*repository-gates[^\]]*\]/);
  assert.match(job(source, "manifest-verdict"), /needs: \[[^\]]*repository-gates[^\]]*\]/);
  assert.match(job(source, "manifest-verdict"), /"repository-gates"/);
});

test("every candidate is materialized and built by two isolated producers across the Tier 1 matrix", async () => {
  const source = await workflow();
  const build = job(source, "product-build");
  assert.match(build, /needs: \[repository-gate, agent-evidence, repository-gates, workspace-verification\]/);
  assert.match(build, /candidate: \$\{\{ fromJSON\(needs\.repository-gate\.outputs\.candidates\) \}\}/);
  assert.match(build, /target: \[linux-x86_64-gnu, windows-x86_64-msvc\]/);
  assert.match(build, /profile: \[debug, release\]/);
  assert.match(build, /producer: \[a, b\]/);
  assert.match(build, /ubuntu-24\.04/);
  assert.match(build, /windows-2025/);
  assert.match(build, /manifest-\$\{\{ matrix\.candidate\.id \}\}-\$\{\{ matrix\.producer \}\}\/workspace/);
  assert.match(build, /git branch --force tsfg-ci-candidate "\$\{\{ matrix\.candidate\.manifestRevision \}\}"/);
  assert.match(build, /repo\.py" init -u "\$manifest_source" -b "tsfg-ci-candidate" -m "\$\{\{ matrix\.candidate\.manifest \}\}" --repo-rev=v2\.65 --worktree/);
  assert.match(build, /repo\.py" sync --verify/);
  assert.match(build, /manifests\.git" config branch\.default\.merge "\$\{\{ matrix\.candidate\.manifestRevision \}\}"/);
  assert.match(build, /git -C "\$workspace\/\.repo\/manifests" remote set-url origin "\$TSFG_MANIFEST_URL"/);
  assert.doesNotMatch(build, /materialize-agent-workspace\.ts|materialized-identity\.json/);
  assert.match(build, /--manifest-revision ["']?\$\{\{ matrix\.candidate\.manifestRevision \}\}/);
  assert.match(build, /tsfg-build(?:\.cmd)?" verify-workspace/);
  assert.match(build, /tsfg-build(?:\.cmd)?" build --target "?\$\{\{ matrix\.target \}\}"? --profile "?\$\{\{ matrix\.profile \}\}"?/);
  assert.match(build, /tsfg-build(?:\.cmd)?" test --target "?\$\{\{ matrix\.target \}\}"? --profile "?\$\{\{ matrix\.profile \}\}"?/);
  assert.match(build, /tsfg-build(?:\.cmd)?" package --target "?\$\{\{ matrix\.target \}\}"? --profile "?\$\{\{ matrix\.profile \}\}"?/);
  assert.match(build, /producers\/\$\{\{ matrix\.candidate\.id \}\}\/\$\{\{ matrix\.target \}\}\/\$\{\{ matrix\.profile \}\}\/\$\{\{ matrix\.producer \}\}/);
  assert.match(build, /retention-days: 90/);
});

test("every candidate has a standalone resolved Workspace Verification report", async () => {
  const source = await workflow();
  const verification = job(source, "workspace-verification");
  assert.match(verification, /candidate: \$\{\{ fromJSON\(needs\.repository-gate\.outputs\.candidates\) \}\}/);
  assert.match(verification, /repo\.py" init[\s\S]*matrix\.candidate\.manifestRevision[\s\S]*matrix\.candidate\.manifest/);
  assert.match(verification, /repo\.py" sync --verify/);
  assert.match(verification, /remote set-url origin "\$TSFG_MANIFEST_URL"/);
  assert.match(verification, /tsfg-build" verify-workspace/);
  assert.match(verification, /workspace\/\$\{\{ matrix\.candidate\.id \}\}\/report\.json/);
  assert.match(verification, /retention-days: 90/);
});

test("compatibility uses candidate-bound artifacts in all four combinations on both platforms", async () => {
  const source = await workflow();
  const compatibility = job(source, "compatibility");
  assert.match(compatibility, /candidate: \$\{\{ fromJSON\(needs\.repository-gate\.outputs\.candidates\) \}\}/);
  assert.match(compatibility, /target: \[linux-x86_64-gnu, windows-x86_64-msvc\]/);
  assert.match(compatibility, /repository: xuelongling\/tsfg/);
  assert.match(compatibility, /ref: \$\{\{ matrix\.candidate\.productRevision \}\}/);
  assert.match(compatibility, /TSFG_BASELINE_PRODUCT_REVISION: \$\{\{ matrix\.candidate\.baselineProductRevision \}\}/);
  assert.match(compatibility, /baseline\.product\.commitOid=process\.env\.TSFG_BASELINE_PRODUCT_REVISION/);
  for (const combination of [
    "baseline/baseline",
    "candidate/baseline",
    "baseline/candidate",
    "candidate/candidate",
  ]) assert.match(compatibility, new RegExp(combination.replace("/", "\\/")));
  assert.match(compatibility, /tsfg-build(?:\.cmd)?["']? test --target ["']?\$\{\{ matrix\.target \}\}["']?/);
  assert.match(compatibility, /--compatibility-baseline/);
  assert.match(compatibility, /--compatibility-candidate/);
  assert.match(compatibility, /compatibility\/\$\{\{ matrix\.candidate\.id \}\}\/\$\{\{ matrix\.target \}\}\/report\.json/);
  assert.match(compatibility, /retention-days: 90/);
  assert.match(compatibility, /on Linux\n\s+if: runner\.os == 'Linux'[\s\S]*sudo unshare --mount --net/);
  assert.match(compatibility, /on Windows\n\s+if: runner\.os == 'Windows'\n\s+shell: pwsh[\s\S]*tsfg-build\.cmd test/);
  assert.match(compatibility, /tsfg-build(?:\.cmd)? prefetch/);
  assert.match(compatibility, /manifest-compat-tool-cache\/\$\{\{ matrix\.target \}\}/);
  assert.doesNotMatch(compatibility, /manifest-compatibility-\$\{\{ matrix\.candidate\.id \}\}\/tool-cache/);
});

test("reproducibility comparators are build-free and compare producer a with producer b", async () => {
  const source = await workflow();
  const repro = job(source, "reproducibility");
  assert.match(repro, /needs: \[repository-gate, product-build\]/);
  assert.match(repro, /candidate: \$\{\{ fromJSON\(needs\.repository-gate\.outputs\.candidates\) \}\}/);
  assert.match(repro, /target: \[linux-x86_64-gnu, windows-x86_64-msvc\]/);
  assert.match(repro, /profile: \[debug, release\]/);
  assert.match(repro, /pattern: manifest-producer-\$\{\{ matrix\.candidate\.id \}\}-\$\{\{ matrix\.target \}\}-\$\{\{ matrix\.profile \}\}-\*-/);
  assert.match(repro, /tsfg-build(?:\.cmd)?" repro-check --target/);
  assert.match(repro, /--producer-a[\s\S]*\/a\/package/);
  assert.match(repro, /--producer-b[\s\S]*\/b\/package/);
  assert.doesNotMatch(repro, /tsfg-build(?:\.cmd)?" build /);
  assert.match(repro, /reproducibility\/\$\{\{ matrix\.candidate\.id \}\}\/\$\{\{ matrix\.target \}\}\/\$\{\{ matrix\.profile \}\}\/report\.json/);
  assert.match(repro, /retention-days: 90/);
});

test("Linux candidate phases enter the loopback-only namespace required by the build seam", async () => {
  const source = await workflow();
  for (const name of ["workspace-verification", "product-build", "compatibility", "reproducibility"]) {
    const selectedJob = job(source, name);
    assert.match(selectedJob, /sudo sysctl -q kernel\.apparmor_restrict_unprivileged_userns=0/, name);
    assert.match(selectedJob, /sudo unshare --mount --net bash -ceu/, name);
    assert.doesNotMatch(selectedJob, /unshare --user/, name);
    assert.match(selectedJob, /mount -t sysfs -o ro,nosuid,nodev,noexec sysfs \/sys/, name);
    assert.match(selectedJob, /ip link set lo up/, name);
    assert.match(selectedJob, /exec setpriv --reuid "\$SUDO_UID" --regid "\$SUDO_GID" --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs -- "\$@"/, name);
  }

  const build = job(source, "product-build");
  for (const command of ["verify-workspace", "build", "test", "package"]) {
    assert.match(
      build,
      new RegExp(
        `offline /usr/bin/env "TSFG_CACHE_DIR=\\$TSFG_CACHE_DIR" "TSFG_BOOTSTRAP_GIT=\\$TSFG_BOOTSTRAP_GIT" "TSFG_BOOTSTRAP_GIT_SHA256=\\$TSFG_BOOTSTRAP_GIT_SHA256" "\\$workspace/tsfg/eng/tsfg-build" ${command}`,
      ),
    );
  }
  assert.match(
    job(source, "compatibility"),
    /offline \/usr\/bin\/env "TSFG_CACHE_DIR=\$TSFG_CACHE_DIR" "TSFG_BOOTSTRAP_GIT=\$TSFG_BOOTSTRAP_GIT" "TSFG_BOOTSTRAP_GIT_SHA256=\$TSFG_BOOTSTRAP_GIT_SHA256" "\$GITHUB_WORKSPACE\/\.ci\/product\/eng\/tsfg-build" test/,
  );
  assert.match(
    job(source, "reproducibility"),
    /offline \/usr\/bin\/env "TSFG_CACHE_DIR=\$TSFG_CACHE_DIR" "TSFG_BOOTSTRAP_GIT=\$TSFG_BOOTSTRAP_GIT" "TSFG_BOOTSTRAP_GIT_SHA256=\$TSFG_BOOTSTRAP_GIT_SHA256" "\.ci\/product\/eng\/tsfg-build" repro-check/,
  );
});

test("Linux launcher phases preserve the authenticated Bootstrap Trust Root Git", async () => {
  const source = await workflow();
  for (const jobName of ["workspace-verification", "product-build", "compatibility", "reproducibility"]) {
    const linuxJob = job(source, jobName);
    assert.match(linuxJob, /export TSFG_BOOTSTRAP_GIT="\$\(command -v git\)"/);
    assert.match(linuxJob, /export TSFG_BOOTSTRAP_GIT_SHA256="\$\(sha256sum "\$TSFG_BOOTSTRAP_GIT" \| cut -d ' ' -f 1\)"/);
    assert.match(linuxJob, /sudo unshare --mount --net bash -ceu/);
    assert.match(
      linuxJob,
      /offline \/usr\/bin\/env "TSFG_CACHE_DIR=\$TSFG_CACHE_DIR" "TSFG_BOOTSTRAP_GIT=\$TSFG_BOOTSTRAP_GIT" "TSFG_BOOTSTRAP_GIT_SHA256=\$TSFG_BOOTSTRAP_GIT_SHA256"/,
    );
  }
});

test("Linux candidate builds publish candidate-bound canaries from before and after the offline chain", async () => {
  const source = await workflow();
  const build = job(source, "product-build");
  const before = build.indexOf('network-canary.mjs" --out "$canary_root/before.json"');
  const buildCommand = build.indexOf('"$workspace/tsfg/eng/tsfg-build" build');
  const packageCommand = build.indexOf('"$workspace/tsfg/eng/tsfg-build" package');
  const after = build.indexOf('network-canary.mjs" --out "$canary_root/after.json"');
  assert.ok(before >= 0 && before < buildCommand, "the first real canary must run before build");
  assert.ok(after > packageCommand, "the second real canary must run after package");
  assert.match(build, /offline "\$\(command -v node\)" "\$GITHUB_WORKSPACE\/tools\/network-canary\.mjs"/);
  assert.match(build, /hosted-offline\/\$\{\{ matrix\.candidate\.id \}\}\/\$\{\{ matrix\.profile \}\}\/\$\{\{ matrix\.producer \}\}/);
  assert.match(build, /join\(process\.env\.TSFG_HOSTED_ROOT,'report\.json'\)/);
  assert.match(build, /resolvedManifestDigest:'sha256:'\+process\.env\.TSFG_CANDIDATE_ID/);
  assert.match(build, /package-report\.json/);
  assert.match(build, /toolchainClosureDigest:packageReport\.result\.buildIdentity\.toolchainClosureDigest/);
  assert.match(build, /candidateOverlayDigest:process\.env\.TSFG_CANDIDATE_OVERLAY_DIGEST/);
  assert.match(build, /manifestRepository:process\.env\.TSFG_MANIFEST_REPOSITORY/);
  assert.match(build, /canaryAfterSha256:sha256\(afterBytes\)/);
  assert.match(build, /canaryBeforeSha256:sha256\(beforeBytes\)/);
  assert.match(build, /packageReportSha256:sha256\(packageBytes\)/);
});

test("candidate evidence archives every manifest identity and resolved product proof for 90 days", async () => {
  const source = await workflow();
  const gate = job(source, "repository-gate");
  for (const name of [
    "candidate-overlay.json",
    "candidate-summary.json",
    "resolved-manifest.json",
    "resolved-manifest.xml",
  ]) assert.match(gate, new RegExp(name.replace(".", "\\.")));

  const evidence = job(source, "candidate-evidence");
  assert.match(evidence, /if: always\(\) && needs\.repository-gate\.outputs\.has-candidates == 'true'/);
  assert.match(evidence, /pattern: manifest-\*-\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  for (const root of ["agent", "workspace", "producers", "compatibility", "reproducibility"]) {
    assert.match(source, new RegExp(`\\.ci/evidence/${root}/`));
  }
  assert.match(evidence, /name: manifest-candidate-evidence-\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(evidence, /retention-days: 90/);
});

test("the final verdict fails closed over all required job results and evidence", async () => {
  const source = await workflow();
  const verdict = job(source, "manifest-verdict");
  assert.match(verdict, /if: \$\{\{ always\(\) \}\}/);
  for (const result of [
    "manifest-gate",
    "agent-ci",
    "workspace-verification",
    "product-build",
    "compatibility",
    "reproducibility",
    "candidate-evidence",
  ]) assert.match(verdict, new RegExp(`"${result}"`));
  assert.match(
    verdict,
    /node tools\/manifest-ci\.mjs verdict --evidence \.ci\/evidence --job-results \.ci\/job-results\.json --out \.ci\/manifest-verdict\.json/,
  );
  assert.match(verdict, /retention-days: 90/);
});
