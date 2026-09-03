# SPDX-License-Identifier: MIT

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$wrapperSource = Join-Path $repoRoot "repo.cmd"
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$passed = 0
$failed = 0

function Assert-Equal {
    param(
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual,
        [Parameter(Mandatory)] [string] $Because
    )

    if ($Expected -ne $Actual) {
        throw "$Because (expected: $Expected; actual: $Actual)"
    }
}

function New-WrapperSandbox {
    $path = Join-Path $temporaryRoot ("tsfg-repo-wrapper-test-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $path | Out-Null
    Copy-Item -LiteralPath $wrapperSource -Destination (Join-Path $path "repo.cmd")
    Set-Content -LiteralPath (Join-Path $path "repo.py") -Value "# test launcher" -Encoding utf8NoBOM
    Set-Content -LiteralPath (Join-Path $path "python.cmd") -Encoding ascii -Value @'
@echo off
if "%~1"=="--version" exit /b 0
>>"%REPO_TEST_CAPTURE%" echo %*
if defined REPO_TEST_EXIT exit /b %REPO_TEST_EXIT%
exit /b 0
'@
    return $path
}

function Remove-WrapperSandbox {
    param([Parameter(Mandatory)] [string] $Path)

    $resolved = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not ([System.IO.Path]::GetFileName($resolved)).StartsWith("tsfg-repo-wrapper-test-", [System.StringComparison]::Ordinal)) {
        throw "Refusing to remove unexpected test path: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

function Invoke-Wrapper {
    param(
        [Parameter(Mandatory)] [string] $Sandbox,
        [Parameter(Mandatory)] [string[]] $Arguments
    )

    $capture = Join-Path $Sandbox "arguments.txt"
    $savedPath = $env:PATH
    $savedCapture = $env:REPO_TEST_CAPTURE
    $savedExit = $env:REPO_TEST_EXIT
    try {
        $env:PATH = "$Sandbox;$env:SystemRoot\System32"
        $env:REPO_TEST_CAPTURE = $capture
        $env:REPO_TEST_EXIT = $null
        $output = & (Join-Path $Sandbox "repo.cmd") @Arguments 2>&1
        return [pscustomobject]@{
            ExitCode = $LASTEXITCODE
            Output = ($output -join "`n")
            Arguments = if (Test-Path -LiteralPath $capture) { Get-Content -Raw -LiteralPath $capture } else { "" }
        }
    }
    finally {
        $env:PATH = $savedPath
        $env:REPO_TEST_CAPTURE = $savedCapture
        $env:REPO_TEST_EXIT = $savedExit
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

Test-Case "init adds one worktree default and preserves caller arguments" {
    $sandbox = New-WrapperSandbox
    try {
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("init", "-u", "https://example.invalid/manifests.git")
        Assert-Equal 0 $result.ExitCode "init should preserve a successful launcher exit"
        Assert-Equal 1 ([regex]::Matches($result.Arguments, "(?<!\S)--worktree(?!\S)").Count) "init should add --worktree exactly once"
        if ($result.Arguments -notmatch "\binit\s+-u\s+https://example\.invalid/manifests\.git\b") {
            throw "init should preserve the caller arguments (actual: $($result.Arguments.Trim()))"
        }
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "init does not duplicate an explicit worktree option" {
    $sandbox = New-WrapperSandbox
    try {
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("init", "--worktree", "-u", "https://example.invalid/manifests.git")
        Assert-Equal 0 $result.ExitCode "init should preserve a successful launcher exit"
        Assert-Equal 1 ([regex]::Matches($result.Arguments, "(?<!\S)--worktree(?!\S)").Count) "init should not duplicate --worktree"
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "sync adds one verification default and preserves caller arguments" {
    $sandbox = New-WrapperSandbox
    try {
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("sync", "--jobs=4", "tsfg")
        Assert-Equal 0 $result.ExitCode "sync should preserve a successful launcher exit"
        Assert-Equal 1 ([regex]::Matches($result.Arguments, "(?<!\S)--verify(?!\S)").Count) "sync should add --verify exactly once"
        if ($result.Arguments -notmatch "\bsync\s+--jobs=4\s+tsfg\b") {
            throw "sync should preserve the caller arguments (actual: $($result.Arguments.Trim()))"
        }
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "sync does not duplicate an explicit verification option" {
    $sandbox = New-WrapperSandbox
    try {
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("sync", "--verify", "tsfg")
        Assert-Equal 0 $result.ExitCode "sync should preserve a successful launcher exit"
        Assert-Equal 1 ([regex]::Matches($result.Arguments, "(?<!\S)--verify(?!\S)").Count) "sync should not duplicate --verify"
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "sync rejects no-verify before invoking the launcher" {
    $sandbox = New-WrapperSandbox
    try {
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("sync", "--no-verify")
        Assert-Equal 2 $result.ExitCode "sync --no-verify should be rejected as unsafe usage"
        Assert-Equal "" $result.Arguments "the launcher should not run for sync --no-verify"
        if ($result.Output -notmatch "refuses --no-verify") {
            throw "the rejection should name --no-verify (actual: $($result.Output))"
        }
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "sync rejects no-repo-verify before invoking the launcher" {
    $sandbox = New-WrapperSandbox
    try {
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("sync", "--no-repo-verify")
        Assert-Equal 2 $result.ExitCode "sync --no-repo-verify should be rejected as unsafe usage"
        Assert-Equal "" $result.Arguments "the launcher should not run for sync --no-repo-verify"
        if ($result.Output -notmatch "refuses --no-repo-verify") {
            throw "the rejection should name --no-repo-verify (actual: $($result.Output))"
        }
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "init rejects no-repo-verify before invoking the launcher" {
    $sandbox = New-WrapperSandbox
    try {
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("init", "--no-repo-verify")
        Assert-Equal 2 $result.ExitCode "init --no-repo-verify should be rejected as unsafe usage"
        Assert-Equal "" $result.Arguments "the launcher should not run for init --no-repo-verify"
        if ($result.Output -notmatch "refuses --no-repo-verify") {
            throw "the rejection should name --no-repo-verify (actual: $($result.Output))"
        }
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "repo option abbreviations cannot bypass verification policy" {
    foreach ($case in @(
        @{ Command = "sync"; Option = "--no-v"; ExpectedName = "--no-verify" },
        @{ Command = "sync"; Option = "--no-ver"; ExpectedName = "--no-verify" },
        @{ Command = "sync"; Option = "--no-repo-v"; ExpectedName = "--no-repo-verify" },
        @{ Command = "init"; Option = "--no-repo-verif"; ExpectedName = "--no-repo-verify" }
    )) {
        $sandbox = New-WrapperSandbox
        try {
            $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @($case.Command, $case.Option)
            Assert-Equal 2 $result.ExitCode "$($case.Option) should be rejected as unsafe usage"
            Assert-Equal "" $result.Arguments "the launcher should not run for $($case.Option)"
            if ($result.Output -notmatch [regex]::Escape("refuses $($case.ExpectedName)")) {
                throw "the rejection should name $($case.ExpectedName) (actual: $($result.Output))"
            }
        }
        finally {
            Remove-WrapperSandbox -Path $sandbox
        }
    }
}

Test-Case "a missing launcher fails clearly before Python is invoked" {
    $sandbox = New-WrapperSandbox
    try {
        Remove-Item -LiteralPath (Join-Path $sandbox "repo.py")
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("--version")
        Assert-Equal 2 $result.ExitCode "a missing repo.py should be a usage/configuration failure"
        Assert-Equal "" $result.Arguments "Python should not run when repo.py is missing"
        if ($result.Output -notmatch "repo\.py is missing") {
            throw "the failure should identify the missing launcher (actual: $($result.Output))"
        }
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Test-Case "missing Python fails clearly" {
    $sandbox = New-WrapperSandbox
    try {
        Remove-Item -LiteralPath (Join-Path $sandbox "python.cmd")
        $result = Invoke-Wrapper -Sandbox $sandbox -Arguments @("--version")
        Assert-Equal 2 $result.ExitCode "missing Python should be a usage/configuration failure"
        if ($result.Output -notmatch "Python 3 is required") {
            throw "the failure should identify the Python prerequisite (actual: $($result.Output))"
        }
    }
    finally {
        Remove-WrapperSandbox -Path $sandbox
    }
}

Write-Host "$passed passed, $failed failed"
if ($failed -ne 0) {
    exit 1
}
