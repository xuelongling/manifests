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
