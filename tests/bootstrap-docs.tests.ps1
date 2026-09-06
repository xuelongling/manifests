# SPDX-License-Identifier: MIT

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$readmePath = Join-Path $repoRoot "README.md"
$passed = 0
$failed = 0

function Test-Case {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [scriptblock] $Body
    )

    try {
        & $Body
        $script:passed++
        Write-Host "PASS $Name"
    }
    catch {
        $script:failed++
        Write-Host "FAIL $Name"
        Write-Host "  $($_.Exception.Message)"
    }
}

Test-Case "README declares first-party MIT provenance" {
    $readme = Get-Content -Raw -LiteralPath $readmePath
    if (-not $readme.StartsWith("<!-- SPDX-License-Identifier: MIT -->", [System.StringComparison]::Ordinal)) {
        throw "README must begin with the canonical SPDX identifier"
    }
}

Test-Case "README pins the official launcher content and release" {
    $readme = Get-Content -Raw -LiteralPath $readmePath
    foreach ($required in @(
        "https://storage.googleapis.com/git-repo-downloads/repo-2.65",
        "1211b57b57e4122a9c546295a59b37d24068f1164d0e87bef096d5323c413e4f",
        "45,880 bytes",
        "--repo-rev=v2.65"
    )) {
        if (-not $readme.Contains($required, [System.StringComparison]::Ordinal)) {
            throw "README is missing the pinned value: $required"
        }
    }
}

Test-Case "README stages the manual install and publishes only verified content" {
    $readme = Get-Content -Raw -LiteralPath $readmePath
    foreach ($required in @(
        '$launcherStage = Join-Path $toolDir "repo.py.download"',
        'Invoke-WebRequest -Uri $repoUrl -OutFile $launcherStage',
        'Get-FileHash -LiteralPath $launcherStage -Algorithm SHA256',
        'if ($actualSha256 -ne $repoSha256)',
        'Move-Item -LiteralPath $launcherStage -Destination $launcherPath -Force'
    )) {
        if (-not $readme.Contains($required, [System.StringComparison]::Ordinal)) {
            throw "README is missing the staged-install step: $required"
        }
    }

    $hashCheck = $readme.IndexOf('if ($actualSha256 -ne $repoSha256)', [System.StringComparison]::Ordinal)
    $publish = $readme.IndexOf('Move-Item -LiteralPath $launcherStage -Destination $launcherPath -Force', [System.StringComparison]::Ordinal)
    if ($hashCheck -ge $publish) {
        throw "README must verify the digest before publishing repo.py"
    }
}

Test-Case "README verifies and records the installed launcher identity" {
    $readme = Get-Content -Raw -LiteralPath $readmePath
    foreach ($required in @(
        '& $wrapperPath --version',
        'repo launcher version 2.65',
        'Get-FileHash -LiteralPath $launcherPath -Algorithm SHA256',
        '$actualInstalledSha256 -ne $repoSha256',
        'bootstrap-trust-root.txt'
    )) {
        if (-not $readme.Contains($required, [System.StringComparison]::Ordinal)) {
            throw "README is missing the installed-identity check: $required"
        }
    }
}

Test-Case "README documents wrapper defaults and the materialization boundary" {
    $readme = Get-Content -Raw -LiteralPath $readmePath
    foreach ($required in @(
        'repo.cmd init',
        '--worktree',
        'repo.cmd sync',
        '--verify',
        '--no-verify',
        '--no-repo-verify',
        'https://github.com/xuelongling/manifests.git',
        '-b d94f4e6bff9aa980b18b0df94e133559e4b61240',
        '-m bootstrap/r00.xml',
        'Workspace Verification'
    )) {
        if (-not $readme.Contains($required, [System.StringComparison]::Ordinal)) {
            throw "README is missing the wrapper/materialization statement: $required"
        }
    }
}

Test-Case "repository contains a wrapper but no installer script" {
    $trackedScripts = @(& git -C $repoRoot ls-files "*.cmd" "*.bat" "*.ps1")
    if ($LASTEXITCODE -ne 0) {
        throw "git ls-files failed"
    }

    $unexpected = @($trackedScripts | Where-Object {
        $_ -notmatch '^tests/[^/]+\.tests\.ps1$' -and
        $_ -ne 'tests/run.ps1' -and
        $_ -ne 'tools/verify-agent-activation.ps1' -and
        $_ -ne 'repo.cmd'
    })
    if ($unexpected.Count -ne 0) {
        throw "unexpected executable install-capable scripts: $($unexpected -join ', ')"
    }

    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "repo.cmd") -PathType Leaf)) {
        throw "the versioned Windows wrapper is missing"
    }
}

Test-Case "README defines fail-closed outcomes for bootstrap failures" {
    $readme = Get-Content -Raw -LiteralPath $readmePath
    foreach ($required in @(
        'Download or TLS failure',
        'SHA-256 mismatch',
        'Python 3 missing',
        'User tools directory not writable',
        'no new `repo.py`'
    )) {
        if (-not $readme.Contains($required, [System.StringComparison]::Ordinal)) {
            throw "README is missing the failure outcome: $required"
        }
    }
}

Write-Host "$passed passed, $failed failed"
if ($failed -ne 0) {
    exit 1
}
