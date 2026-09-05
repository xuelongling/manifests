# SPDX-License-Identifier: MIT

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$gitDirectory = Split-Path -Parent (Get-Command git -ErrorAction Stop).Source
$passed = 0
$failed = 0

function New-MaterializationSandbox {
    $path = Join-Path $temporaryRoot ("tsfg-materialization-test-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $path | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "repo.cmd") -Destination (Join-Path $path "repo.cmd")
    Set-Content -LiteralPath (Join-Path $path "repo.py") -Value "# test launcher" -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $path "python.cmd") -Encoding ascii -Value @'
@echo off
if "%~1"=="--version" exit /b 0
>>"%CD%\repo-invocations.txt" echo %*
exit /b 0
'@

    $manifestRoot = Join-Path $path ".repo/manifests"
    New-Item -ItemType Directory -Path (Join-Path $manifestRoot "bootstrap") -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repoRoot "bootstrap/r00.xml") -Destination (Join-Path $manifestRoot "bootstrap/r00.xml")
    $verifierSource = Join-Path $repoRoot "tools/verify-agent-activation.ps1"
    if (Test-Path -LiteralPath $verifierSource) {
        New-Item -ItemType Directory -Path (Join-Path $manifestRoot "tools") -Force | Out-Null
        Copy-Item -LiteralPath $verifierSource -Destination (Join-Path $manifestRoot "tools/verify-agent-activation.ps1")
    }

    $agentRoot = Join-Path $path ".agents"
    New-Item -ItemType Directory -Path (Join-Path $agentRoot "codex") -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $agentRoot "AGENTS.md") -Value "managed instructions" -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $agentRoot "codex/config.toml") -Value "managed config" -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $agentRoot "codex/hooks.json") -Value "{}" -Encoding utf8NoBOM
    & git -C $agentRoot init --initial-branch=main --quiet
    & git -C $agentRoot config user.name "tsfg test"
    & git -C $agentRoot config user.email "test@example.invalid"
    & git -C $agentRoot add -- AGENTS.md codex/config.toml codex/hooks.json
    & git -C $agentRoot commit --quiet -m "fixture"
    $agentRevision = (& git -C $agentRoot rev-parse HEAD).Trim()

    [xml] $manifest = Get-Content -LiteralPath (Join-Path $manifestRoot "bootstrap/r00.xml") -Raw
    $agentProject = @($manifest.manifest.project | Where-Object path -eq ".agents")
    $agentProject.SetAttribute("revision", $agentRevision)
    $manifest.Save((Join-Path $manifestRoot "bootstrap/r00.xml"))
    return $path
}

function Remove-MaterializationSandbox {
    param([Parameter(Mandatory)] [string] $Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($resolved)).StartsWith("tsfg-materialization-test-", [System.StringComparison]::Ordinal)) {
        throw "Refusing to remove unexpected test path: $resolved"
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
            return
        }
        catch {
            if ($attempt -eq 9) { throw }
            Start-Sleep -Milliseconds (25 * ($attempt + 1))
        }
    }
}

function Invoke-SandboxSync {
    param([Parameter(Mandatory)] [string] $Sandbox)

    $savedPath = $env:PATH
    Push-Location -LiteralPath $Sandbox
    try {
        $env:PATH = "$Sandbox;$gitDirectory;$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
        $output = & (Join-Path $Sandbox "repo.cmd") sync 2>&1
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = ($output -join "`n")
        }
    }
    finally {
        $env:PATH = $savedPath
        Pop-Location
    }
}

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

Test-Case "activation verifier does not depend on Get-FileHash module discovery" {
    $verifier = Get-Content -LiteralPath (Join-Path $repoRoot "tools/verify-agent-activation.ps1") -Raw
    if ($verifier -match '\bGet-FileHash\b') {
        throw "activation verifier still depends on Get-FileHash"
    }
    if ($verifier -notmatch '\[System\.Security\.Cryptography\.SHA256\]::Create\(\)') {
        throw "activation verifier does not use an in-process SHA-256 implementation"
    }
}

if (-not $IsWindows) {
    Write-Host "SKIP repo.cmd materialization fixtures require Windows"
    Write-Host "$passed passed, $failed failed"
    exit $(if ($failed -eq 0) { 0 } else { 1 })
}

Test-Case "sync rejects copied Agent Activation Surface entries" {
    $sandbox = New-MaterializationSandbox
    try {
        Copy-Item -LiteralPath (Join-Path $sandbox ".agents/AGENTS.md") -Destination (Join-Path $sandbox "AGENTS.md")
        $result = Invoke-SandboxSync -Sandbox $sandbox
        if ($result.ExitCode -eq 0) {
            throw "sync accepted an ordinary copied AGENTS.md"
        }
        if ($result.Output -notmatch "symbolic link") {
            throw "sync did not explain the required symbolic-link postcondition: $($result.Output)"
        }
        if (Test-Path -LiteralPath (Join-Path $sandbox "repo-invocations.txt")) {
            throw "sync invoked repo before rejecting the conflicting ordinary file"
        }
    }
    finally {
        Remove-MaterializationSandbox -Path $sandbox
    }
}

Test-Case "sync fails after repo returns success without creating activation links" {
    $sandbox = New-MaterializationSandbox
    try {
        $result = Invoke-SandboxSync -Sandbox $sandbox
        if ($result.ExitCode -eq 0) {
            throw "sync accepted a missing Agent Activation Surface"
        }
        if ($result.Output -notmatch "missing required symbolic link") {
            throw "sync did not explain the missing-link postcondition: $($result.Output)"
        }
        if (-not (Test-Path -LiteralPath (Join-Path $sandbox "repo-invocations.txt"))) {
            throw "the fixture did not reach the post-sync capability check"
        }
    }
    finally {
        Remove-MaterializationSandbox -Path $sandbox
    }
}

Test-Case "sync rejects activation content that differs from the pinned agent commit" {
    $sandbox = New-MaterializationSandbox
    try {
        Set-Content -LiteralPath (Join-Path $sandbox ".agents/AGENTS.md") -Value "tampered instructions" -Encoding utf8NoBOM
        Copy-Item -LiteralPath (Join-Path $sandbox ".agents/AGENTS.md") -Destination (Join-Path $sandbox "AGENTS.md")
        $result = Invoke-SandboxSync -Sandbox $sandbox
        if ($result.ExitCode -eq 0) {
            throw "sync accepted content that differs from the pinned agent commit"
        }
        if ($result.Output -notmatch "content does not match the pinned agent commit") {
            throw "sync did not report the managed-content mismatch: $($result.Output)"
        }
    }
    finally {
        Remove-MaterializationSandbox -Path $sandbox
    }
}

Test-Case "sync rejects activation paths that traverse a junction outside the workspace" {
    $sandbox = New-MaterializationSandbox
    $outside = Join-Path $temporaryRoot ("tsfg-materialization-outside-" + [guid]::NewGuid().ToString("N"))
    try {
        New-Item -ItemType Directory -Path $outside | Out-Null
        Set-Content -LiteralPath (Join-Path $outside "config.toml") -Value "outside config" -Encoding utf8NoBOM
        New-Item -ItemType Junction -Path (Join-Path $sandbox ".codex") -Target $outside | Out-Null

        $result = Invoke-SandboxSync -Sandbox $sandbox
        if ($result.ExitCode -eq 0) {
            throw "sync accepted an activation path through an out-of-workspace junction"
        }
        if ($result.Output -notmatch "reparse point") {
            throw "sync did not report the physical containment failure: $($result.Output)"
        }
        if (Test-Path -LiteralPath (Join-Path $sandbox "repo-invocations.txt")) {
            throw "sync invoked repo before rejecting the junction escape"
        }
    }
    finally {
        Remove-MaterializationSandbox -Path $sandbox
        if (Test-Path -LiteralPath $outside) {
            Remove-Item -LiteralPath $outside -Recurse -Force
        }
    }
}

Test-Case "sync rejects a broken reparse-point conflict before invoking repo" {
    $sandbox = New-MaterializationSandbox
    $outside = Join-Path $temporaryRoot ("tsfg-materialization-broken-" + [guid]::NewGuid().ToString("N"))
    $destination = Join-Path $sandbox "AGENTS.md"
    try {
        New-Item -ItemType Directory -Path $outside | Out-Null
        New-Item -ItemType Junction -Path $destination -Target $outside | Out-Null
        Remove-Item -LiteralPath $outside -Recurse -Force

        $result = Invoke-SandboxSync -Sandbox $sandbox
        if ($result.ExitCode -eq 0) {
            throw "sync accepted a broken reparse-point conflict"
        }
        if (Test-Path -LiteralPath (Join-Path $sandbox "repo-invocations.txt")) {
            throw "sync invoked repo before rejecting the broken conflict"
        }
    }
    finally {
        if ((Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue)) {
            Remove-Item -LiteralPath $destination -Force
        }
        Remove-MaterializationSandbox -Path $sandbox
        if (Test-Path -LiteralPath $outside) {
            Remove-Item -LiteralPath $outside -Recurse -Force
        }
    }
}

Test-Case "sync rejects a managed source leaf linked to outside the workspace" {
    $sandbox = New-MaterializationSandbox
    $outside = Join-Path $temporaryRoot ("tsfg-materialization-source-" + [guid]::NewGuid().ToString("N") + ".md")
    try {
        $source = Join-Path $sandbox ".agents/AGENTS.md"
        Copy-Item -LiteralPath $source -Destination $outside
        Remove-Item -LiteralPath $source -Force
        New-Item -ItemType HardLink -Path $source -Target $outside | Out-Null
        Copy-Item -LiteralPath $source -Destination (Join-Path $sandbox "AGENTS.md")

        $result = Invoke-SandboxSync -Sandbox $sandbox
        if ($result.ExitCode -eq 0) {
            throw "sync accepted a managed source leaf linked outside the workspace"
        }
        if ($result.Output -notmatch "managed source must be an ordinary file") {
            throw "sync did not report the source-link containment failure: $($result.Output)"
        }
        if (Test-Path -LiteralPath (Join-Path $sandbox "repo-invocations.txt")) {
            throw "sync invoked repo before rejecting the linked managed source"
        }
    }
    finally {
        Remove-MaterializationSandbox -Path $sandbox
        if (Test-Path -LiteralPath $outside) {
            Remove-Item -LiteralPath $outside -Force
        }
    }
}

Write-Host "$passed passed, $failed failed"
if ($failed -ne 0) {
    exit 1
}
