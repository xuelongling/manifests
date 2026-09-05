<!-- SPDX-License-Identifier: MIT -->

# tsfg Manifest Repository

This repository versions Google `repo` orchestration metadata for tsfg. Git,
Python, and the Google `repo` launcher form the Bootstrap Trust Root used before
the reproducible build boundary.

## Pinned Google repo release

The Windows bootstrap uses the official immutable launcher for Google `repo`
release 2.65:

- URL: `https://storage.googleapis.com/git-repo-downloads/repo-2.65`
- Size: 45,880 bytes
- SHA-256: `1211b57b57e4122a9c546295a59b37d24068f1164d0e87bef096d5323c413e4f`
- Full repo source revision: `--repo-rev=v2.65`

The downloaded bytes match the `repo` launcher stored by Google at the signed
`v2.65` source tag. Do not substitute the mutable `.../repo` download URL, a
moving `stable` branch, or a different digest.

## Manual Windows installation

Prerequisites are Git for Windows, a `python` command that runs Python 3, HTTPS
access to the pinned URL above, and a writable per-user tools directory. Run the
following PowerShell from this reviewed Manifest Repository checkout. These are
manual commands; the repository deliberately provides no installer script.

First confirm the prerequisites before creating a launcher:

```powershell
$ErrorActionPreference = "Stop"

$pythonVersion = (& python --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $pythonVersion.StartsWith("Python 3.")) {
    throw "Python 3 is required on PATH; no launcher was installed."
}

$wrapperSource = (Resolve-Path -LiteralPath ".\repo.cmd").Path
$repoUrl = "https://storage.googleapis.com/git-repo-downloads/repo-2.65"
$repoSha256 = "1211b57b57e4122a9c546295a59b37d24068f1164d0e87bef096d5323c413e4f"
$toolDir = Join-Path $env:LOCALAPPDATA "tsfg\repo\v2.65"
$launcherStage = Join-Path $toolDir "repo.py.download"
$wrapperStage = Join-Path $toolDir "repo.cmd.download"
$launcherPath = Join-Path $toolDir "repo.py"
$wrapperPath = Join-Path $toolDir "repo.cmd"
```

Download to a staging name, verify the pinned digest, stage the reviewed
wrapper, and only then publish the two files in the same directory:

```powershell
try {
    New-Item -ItemType Directory -Path $toolDir -Force | Out-Null

    $writeProbe = Join-Path $toolDir (".write-probe-" + [guid]::NewGuid().ToString("N"))
    Set-Content -LiteralPath $writeProbe -Value "probe" -Encoding ascii
    Remove-Item -LiteralPath $writeProbe -Force

    Remove-Item -LiteralPath $launcherStage, $wrapperStage -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $repoUrl -OutFile $launcherStage

    $actualSha256 = (Get-FileHash -LiteralPath $launcherStage -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $repoSha256) {
        throw "repo.py SHA-256 mismatch: expected $repoSha256, got $actualSha256"
    }

    Copy-Item -LiteralPath $wrapperSource -Destination $wrapperStage -Force
    Move-Item -LiteralPath $wrapperStage -Destination $wrapperPath -Force
    Move-Item -LiteralPath $launcherStage -Destination $launcherPath -Force
}
catch {
    Remove-Item -LiteralPath $launcherStage, $wrapperStage -Force -ErrorAction SilentlyContinue
    throw
}
```

The final rename occurs within one directory. A failed download or digest check
therefore leaves no new `repo.py`; a write-permission failure stops before the
download; and all staging files are removed on failure. If a prior verified
installation exists, a failed replacement leaves its final `repo.py` untouched.

## Verify and record the installation

Query the installed launcher through the wrapper, independently re-hash the
final file, and record the result together with the reviewed documentation
commit:

```powershell
$versionOutput = (& $wrapperPath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $versionOutput -notmatch "repo launcher\s+version 2\.65\b") {
    throw "Unexpected launcher version output: $versionOutput"
}

$actualInstalledSha256 = (Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualInstalledSha256 -ne $repoSha256) {
    throw "Installed repo.py SHA-256 mismatch: expected $repoSha256, got $actualInstalledSha256"
}

$manifestDocsCommit = (& git rev-parse HEAD).Trim()
$recordPath = Join-Path $toolDir "bootstrap-trust-root.txt"
@(
    "launcher_version=2.65"
    "launcher_sha256=$actualInstalledSha256"
    "repo_source_revision=v2.65"
    "manifest_docs_commit=$manifestDocsCommit"
) | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM

Get-Content -LiteralPath $recordPath
```

The command output must include `repo launcher version 2.65`, and the recorded
digest must equal
`1211b57b57e4122a9c546295a59b37d24068f1164d0e87bef096d5323c413e4f`.

## Wrapper safety defaults

Invoke the installed `repo.cmd`; do not invoke `repo.py` directly. `repo.cmd init`
is the public initialization command. For `init`,
the wrapper appends `--worktree` unless the caller already supplied it. This is
the required Windows checkout mode:

```powershell
$workspace = "C:\work\tsfg-workspace"
New-Item -ItemType Directory -Path $workspace | Out-Null
Set-Location -LiteralPath $workspace

& $wrapperPath init `
    -u https://github.com/xuelongling/manifests.git `
    -b d94f4e6bff9aa980b18b0df94e133559e4b61240 `
    -m bootstrap/r00.xml `
    --repo-rev=v2.65
```

The canonical Manifest Repository URL, complete commit OID, and selected
`bootstrap/r00.xml` above jointly identify the R00 Bootstrap Integration
Snapshot. The commit locks the exact `tsfg` and `.agents` project OIDs; their
`upstream="refs/heads/main"` attributes are fetch hints only. Do not replace the
manifest commit or project revisions with `main`, another branch tip, or an
abbreviated OID. R00 deliberately uses complete clones and includes no approved
Upstream Fork.

For `repo.cmd sync`, the wrapper appends `--verify` unless it is already present:

```powershell
& $wrapperPath sync
```

Run synchronization from the fresh Repo Workspace root used for `init`. On
success, the only manifest projects are `tsfg/` and `.agents/` at their canonical
workspace paths. The manifest also creates the Agent Activation Surface as real
links at `AGENTS.md`, `.codex/config.toml`, and `.codex/hooks.json`; managed skills
remain discoverable at `.agents/skills/`. Start Codex from this trusted root.

Materialization fails if Windows cannot create symbolic links, if an activation
destination conflicts, or if a link cannot resolve to the matching managed file
inside `.agents/`. There is no copy fallback: replacing an activation link with
ordinary file content is not a valid workspace. Remove the incomplete workspace,
correct the Windows link capability or conflicting entry, and replay the complete
bootstrap identity in a fresh directory.

There is intentionally no `default.xml` before the first Stable Integration.
The bootstrap identity is independently replayable but does not claim to be a
Stable Integration.

Maintainers can replay the same public `init`/`sync` seam on a link-capable
Linux host and verify the resulting repository state with the versioned
integration test:

```sh
TSFG_REPO_LAUNCHER=/path/to/verified/repo-2.65 \
  bash tests/bootstrap-materialization.integration.tests.sh
```

For an already materialized evidence workspace, pass `--workspace <path>` to
rerun the state assertions without performing another network sync. This test
does not replace the later `tsfg-build verify-workspace` command.

The wrapper refuses `--no-verify`, `--no-repo-verify`, and every unique long-option
abbreviation that repo would accept for either switch, with exit code 2 before
the launcher runs. The `repo sync --verify` option only selects non-interactive
post-sync-hook verification. R00 defines no post-sync hook, so this option is not
project OID verification and is never a substitute for the separate Workspace Verification
command required after materialization. In particular, `repo sync --verify` is not
project OID verification and does not verify the Agent Activation Surface.

## Failure outcomes

| Failure | Required result |
| --- | --- |
| Download or TLS failure | PowerShell reports the network error, removes `repo.py.download`, and publishes no new `repo.py`. |
| SHA-256 mismatch | The command reports both expected and actual digests, removes the staged bytes, and publishes no new `repo.py`. |
| Python 3 missing | The prerequisite check or `repo.cmd` exits with a clear Python 3 error before the launcher runs. |
| User tools directory not writable | Directory creation or the write probe fails before download, so no new `repo.py` exists. |

Never rename or copy an unverified partial download to `repo.py`. A `repo.cmd`
without its verified adjacent launcher fails explicitly and must not be treated
as an installed Bootstrap Trust Root.

## Candidate and pull-request validation

Integration Owners create transient Candidate Overlay evidence with the public
manifest CI command. The baseline argument is always a complete Manifest
Repository commit OID; before the first Stable it must be the published
Bootstrap Integration Snapshot above, and after that it must contain a
`default.xml` byte-identical to an immutable versioned snapshot and be the
repository's current checked-out Stable identity.

```powershell
node tools/manifest-ci.mjs candidate `
    --repository . `
    --baseline-revision d94f4e6bff9aa980b18b0df94e133559e4b61240 `
    --replacement tsfg.git=<complete-candidate-oid> `
    --out $env:RUNNER_TEMP\candidate
```

The output directory contains `candidate-overlay.json`, the fully resolved JSON
and XML manifests, and `candidate-summary.json` with complete canonical SHA-256
digests. It is CI evidence, not Manifest Repository source. Ordinary Candidate
evidence is retained for 90 days; a failed Candidate is never committed as a
versioned snapshot.

The Manifest PR workflow runs `manifest-ci.mjs gate` against the trusted PR base
and candidate head. This independently compares Git history for bootstrap and
versioned snapshot immutability, validates the complete R00 project and Agent
Activation Surface shape, and emits the resolved candidates consumed by the
product and agent matrices. Candidate directories use the complete resolved
manifest digest, and the final verdict checks that policy, workspace,
compatibility, build, package, attestation, and reproducibility reports all
bind to that exact resolved candidate. `manifest-ci.mjs tag-policy` compares
trusted tag ref maps and rejects release tag movement or deletion fixtures;
repository ruleset protection remains a separate required control.

## Minimum Tier 1 Offline Proof

Hosted pull-request runners establish `Verified Candidate`; they do not prove
the minimum supported operating systems. Each Linux candidate producer runs a
TCP canary against `1.1.1.1:443` and `8.8.8.8:443` inside its loopback-only
network namespace before build and after package. Both observations, the exact
Candidate Integration, Build Identity, and Toolchain Closure are recorded under
`hosted-offline/` in the ordinary 90-day candidate evidence artifact. The raw
before/after canary reports are retained beside each hosted report, and the
validator recomputes their digests and the producing package-report digest.
Every report binds the Manifest Repository URL, selected manifest name and
revision, Candidate Overlay digest, resolved-manifest digest, and product and
Agent OIDs.

The `Tier 1 Offline Proof` workflow is a fail-closed evidence consumer. It does
not claim to provision unavailable infrastructure. A trusted VM controller must
first run from `.github/workflows/tier1-vm-controller.yml` on protected
`xuelongling/manifests` `main` and publish a proof artifact containing:

- Debian 12.15, glibc 2.36, 6.1-series kernel runtime smoke for the exact
  `release` profile;
- two different Windows 11 24H2 guests, each with distinct workspace, cache,
  and build-output roots;
- independently executed Workspace Verification, build, test, package, and
  package runtime smoke in both Windows guests for the exact `release` profile;
- a completely reverified `windows-x86_64-msvc/sha256/<closure>` cache injected
  before isolation;
- out-of-band controller attestations that the hypervisor disconnected every
  external guest adapter, plus blocked pre/post canaries and per-command WFP
  process isolation;
- the exact OS, isolation, cache verification, command, package, runtime, and
  controller attestation source reports, with complete SHA-256 references.
  Controller-private ambient logs remain excluded; the validator accepts only
  the declared source filenames, recomputes every report digest, and binds the
  canonical source-reference set to its controller attestation.

Only the closed JSON report schema is accepted; extra files or fields are
rejected so controller logs, environment dumps, and credentials cannot be
silently archived as proof. The consumer fetches both the Candidate and
controller runs directly from the GitHub Actions API. Candidate evidence must
come from the successful Manifest PR workflow at the exact manifest commit;
controller evidence must come from a successful `workflow_dispatch` of the
trusted workflow from protected `main`. A caller-selected run from any other
workflow or branch fails. Dispatch the workflow with the prior Candidate
run ID, its complete 64-hex candidate ID, and the trusted controller run ID;
the proof artifact name is derived from that candidate ID rather than supplied
by the caller. Both trusted workflows fetch the run's pull-request head ref
without executing it, then require the resolved manifest bytes to equal the
selected snapshot in that exact commit. Equivalently, validate already-downloaded
artifacts and an API-fetched controller run document with:

```powershell
node tools/manifest-ci.mjs offline-proof `
    --repository . `
    --candidate-evidence .ci/candidate-evidence `
    --verified-verdict .ci/verified-verdict/manifest-verdict.json `
    --candidate-id <complete-resolved-manifest-content-address> `
    --candidate-run .ci/candidate-run.json `
    --candidate-run-id <manifest-pr-run-id> `
    --controller-run .ci/controller-run.json `
    --controller-run-id <trusted-controller-run-id> `
    --proof-evidence .ci/proof-evidence `
    --out .ci/offline-proof.json
```

The result is an `Offline Proof` prerequisite only. It does not declare the
Candidate Promotable or Stable; Owner-gated promotion remains a separate step.

## Owner-gated promotion transaction

Promotion is a fail-closed, three-commit transaction. The only supported remote
mutation entry is `.github/workflows/release-owner.yml` dispatched from the
exact protected `main` commit. Its job enters `protected-release-environment`,
rejects bots and actor-changing reruns, reads the run and environment review
history back from the GitHub API, and gives every transaction command a
short-lived `release-owner-context` authorization. The JSON approval record in
the provisional bundle remains business evidence; it is not generated by the
workflow and is not a replacement for configuring the environment or branch
ruleset.

The authorization shown in the command examples below is illustrative of the
workflow's private runner-temporary file. It must be produced by
`release-owner-context` from the current GitHub run and `/approvals` API
responses; operators must not hand-author it or retain it for another main
commit or operation.

The workflow never pushes `main`, creates a tag, creates a GitHub Release, or
merges its result. It writes exactly one operation commit to a run-specific
branch and opens a pull request so protected-main required checks remain the
commit gate. `record-release-evidence` additionally downloads the exact
`tier1-offline-proof-<candidate-id>` artifact from a successful trusted
`tier1-offline-proof.yml` run and requires it to be byte-identical to the
Offline Proof in the provisional bundle. A claimed or locally fabricated proof
therefore cannot replace ticket 17 execution evidence.

Every downloaded provisional bundle, publication record, or rollback approval
must itself come from a successful human-dispatched workflow on manifest main,
and that source commit must remain an ancestor of the transaction's exact main
commit. Candidate or failed-run artifacts are rejected before any transaction
command executes.

`protected-release-environment` must provide a narrowly scoped
`TSFG_RELEASE_OWNER_TOKEN` secret that can create a release branch and pull
request without bypassing branch protection. The default `GITHUB_TOKEN` stays
read-only and is used only for run/review and artifact reads. This separate
credential is required because a pull request created with the default token
does not reliably trigger the required pull-request workflow.

First commit the candidate's immutable version snapshot by itself. Its path is
`snapshots/tsfg-v<product-version>.xml`, and it must already be the exact
snapshot named by the Verified Candidate and Offline Proof. The product tag and
non-Stable release materials, including external checksums for both Tier 1
targets, must also be fixed before the next command runs.

Create a provisional evidence directory containing exactly:

- `verified-candidate.json` from the successful Manifest PR verdict;
- `offline-proof.json` from the successful minimum Tier 1 proof;
- `version-readiness.json` binding `status: "ready"`, Product Version, and
  Candidate content address;
- `owner-approval.json` binding the same version and Candidate to a human
  `Release Owner`, action `promote-stable`, and source
  `protected-release-environment`; its `additionalApprovals` array records every
  other applicable `Contracts Owner` or `Integration Owner` approval, and each
  entry must also be a unique human approval rather than a bot decision;
- `product-tag.json` binding the immutable `tsfg-v<version>` tag to the proven
  product commit;
- `release-materials.json` binding fixed, non-Stable archive, Artifact
  Manifest, external-checksum, and Build Identity digests for both Tier 1
  targets; and
- `bundle.json`, whose sorted `entries` hash the six files above and whose
  `contentAddress` is the canonical JSON digest of
  `{ entries, schemaVersion: "1" }`. The bundle never hashes itself.

Record the versioned, self-reference-free Release Evidence and Promotable
state, then commit both files before attempting Stable promotion:

```powershell
node tools/manifest-ci.mjs record-release-evidence `
    --repository . `
    --version 0.1.0 `
    --bundle C:\trusted\tsfg-v0.1.0-provisional `
    --authorization C:\trusted\release-owner-authorization.json

git add releases/tsfg-v0.1.0
git commit -m "release: record tsfg-v0.1.0 evidence"
```

The generated `releases/tsfg-v0.1.0/evidence.json` binds the already-fixed
snapshot, product tag, external checksums, Candidate, and provisional bundle.
It deliberately contains neither its own digest nor a future manifest commit
OID, so the product tag and Build Identity can be reproduced without the later
record. Manifest CI makes this evidence immutable once committed.

Only the authenticated human named in that evidence may create the final
default-manifest change:

```powershell
node tools/manifest-ci.mjs promote-stable `
    --repository . `
    --version 0.1.0 `
    --authorization C:\trusted\release-owner-authorization.json

git add default.xml releases
git commit -m "release: promote tsfg-v0.1.0 Stable"
```

`default.xml` is written last and byte-for-byte equals the immutable snapshot;
that final commit is the Stable commit point. Before the first Stable the file
does not exist. A later Stable promotion atomically marks the prior current
release `Superseded`. Missing, skipped, failed, malformed, uncommitted, or
candidate-mismatched evidence prevents the transition, as does a bot actor.

Post-Stable publication metadata is separate from Stable identity. It may be
finalized once and replayed idempotently with identical input; a conflicting
retry fails without changing `default.xml`, the snapshot, evidence, or Stable
state:

```powershell
node tools/manifest-ci.mjs finalize-release `
    --repository . `
    --version 0.1.0 `
    --metadata C:\trusted\tsfg-v0.1.0-publication.json `
    --authorization C:\trusted\release-owner-authorization.json
```

Rollback also requires a protected-environment approval by a human Release
Owner. The approval binds `fromVersion`, `toVersion`, and a non-empty reason:

```powershell
node tools/manifest-ci.mjs rollback `
    --repository . `
    --approval C:\trusted\rollback.json `
    --authorization C:\trusted\release-owner-authorization.json

git add default.xml releases
git commit -m "release: withdraw tsfg-v0.2.0 and roll back to v0.1.0"
```

The target must be an earlier release whose Git history proves it was Stable.
Rollback writes a new commit, repoints `default.xml` to that unchanged snapshot,
and moves only the current bad release from `Stable` to `Withdrawn`. It does not
move a product tag, modify a historical snapshot or Release Evidence, revive a
`Superseded` state, or rewrite any prior commit.

The trusted workflow runs only on a self-hosted runner carrying the
`tsfg-tier1-vm-controller` label. Repository variable
`TSFG_TIER1_VM_CONTROLLER` must be the absolute path of the host-controlled
executable that injects the verified candidate cache, drives the short-lived
VMs out of band, and writes the closed proof tree. Missing capacity, runner
label, variable, executable, source report, or successful VM replay leaves no
artifact and therefore cannot produce Offline Proof.
