# SPDX-License-Identifier: MIT

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "bootstrap/r00.xml"
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

Test-Case "bootstrap manifest declares the complete R00 workspace" {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "bootstrap/r00.xml is missing"
    }

    [xml] $manifest = Get-Content -LiteralPath $manifestPath -Raw
    $root = $manifest.DocumentElement
    if ($null -eq $root -or $root.Name -ne "manifest") {
        throw "bootstrap/r00.xml must have a manifest root"
    }

    $remotes = @($root.remote)
    if ($remotes.Count -ne 1 -or
        $remotes[0].name -ne "github-xuelongling" -or
        $remotes[0].fetch -ne "https://github.com/xuelongling/") {
        throw "the manifest must use only the canonical xuelongling GitHub remote"
    }

    $projects = @($root.project)
    if ($projects.Count -ne 2) {
        throw "expected exactly tsfg and .agents, got $($projects.Count) projects"
    }

    $expected = @{
        "tsfg" = @{
            Name = "tsfg.git"
            Revision = "eb2838e4c4910113b23072b40c526a8b2843f744"
        }
        ".agents" = @{
            Name = ".agents.git"
            Revision = "20e5cb5e50c38c5a6fde9ed9b7875f9b405648e4"
        }
    }

    foreach ($project in $projects) {
        if (-not $expected.ContainsKey([string] $project.path)) {
            throw "unexpected project path: $($project.path)"
        }

        $entry = $expected[[string] $project.path]
        if ($project.name -ne $entry.Name) {
            throw "unexpected project name for $($project.path): $($project.name)"
        }
        if ($project.revision -ne $entry.Revision -or $project.revision -notmatch '^[0-9a-f]{40}$') {
            throw "$($project.path) must use its approved complete commit OID"
        }
        if ($project.remote -ne "github-xuelongling" -or $project.upstream -ne "refs/heads/main") {
            throw "$($project.path) must use the canonical remote with main only as a fetch hint"
        }
        if ($project.HasAttribute("clone-depth") -or $project.HasAttribute("force-path")) {
            throw "$($project.path) must be a complete clone at its canonical path"
        }
        if (@($project.SelectNodes("copyfile")).Count -ne 0) {
            throw "copyfile fallback is forbidden"
        }
        if ($project.path -ne ".agents" -and @($project.SelectNodes("linkfile")).Count -ne 0) {
            throw "only .agents may expose manifest-managed linkfiles"
        }
    }

    foreach ($forbiddenElement in @("copyfile", "extend-project", "include", "remove-project", "submanifest")) {
        if (@($root.SelectNodes(".//$forbiddenElement")).Count -ne 0) {
            throw "$forbiddenElement may not alter the Bootstrap Integration Snapshot"
        }
    }

    $agentProject = @($projects | Where-Object path -eq ".agents")
    $links = @($agentProject.linkfile)
    $actualLinks = @($links | ForEach-Object { "$($_.src)|$($_.dest)" } | Sort-Object)
    $expectedLinks = @(
        "AGENTS.md|AGENTS.md",
        "codex/config.toml|.codex/config.toml",
        "codex/hooks.json|.codex/hooks.json"
    ) | Sort-Object
    if (($actualLinks -join "`n") -cne ($expectedLinks -join "`n")) {
        throw "Agent Activation Surface linkfiles do not match the approved mapping"
    }

    if (Test-Path -LiteralPath (Join-Path $repoRoot "default.xml")) {
        throw "default.xml must not exist before the first Stable Integration"
    }
}

Test-Case "README publishes one replayable Bootstrap Integration Snapshot" {
    $readme = Get-Content -LiteralPath (Join-Path $repoRoot "README.md") -Raw
    $snapshotOid = "c0ea4bb1d32f80cea00d852fe6e36950e2aee598"

    foreach ($required in @(
        "https://github.com/xuelongling/manifests.git",
        "-b $snapshotOid",
        "-m bootstrap/r00.xml",
        "--repo-rev=v2.65",
        "Repo Workspace",
        "Agent Activation Surface",
        "repo sync --verify",
        "project OID verification",
        "does not verify the Agent Activation Surface"
    )) {
        if (-not $readme.Contains($required, [System.StringComparison]::Ordinal)) {
            throw "README is missing the bootstrap identity/materialization statement: $required"
        }
    }

    if ($readme.Contains("<full-manifest-commit-oid>", [System.StringComparison]::Ordinal)) {
        throw "README must not retain an executable bootstrap identity placeholder"
    }

    $snapshotBlob = (& git -C $repoRoot rev-parse "$($snapshotOid):bootstrap/r00.xml" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "published manifest commit does not contain bootstrap/r00.xml: $snapshotBlob"
    }
    $workingBlob = (& git -C $repoRoot hash-object $manifestPath 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $workingBlob -ne $snapshotBlob) {
        throw "published bootstrap identity does not match bootstrap/r00.xml"
    }

    & git -C $repoRoot cat-file -e "$($snapshotOid):default.xml" 2>$null
    if ($LASTEXITCODE -eq 0) {
        throw "the Bootstrap Integration Snapshot must not contain default.xml"
    }
}

Write-Host "$passed passed, $failed failed"
if ($failed -ne 0) {
    exit 1
}
