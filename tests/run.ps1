# SPDX-License-Identifier: MIT

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$testFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.tests.ps1" | Sort-Object Name
foreach ($testFile in $testFiles) {
    Write-Host "==> $($testFile.Name)"
    & pwsh -NoProfile -File $testFile.FullName
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

& node --check (Join-Path $repoRoot "tools/manifest-ci.mjs")
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$nodeTestFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.test.mjs" | Sort-Object Name
foreach ($testFile in $nodeTestFiles) {
    Write-Host "==> $($testFile.Name)"
    & node --test --test-concurrency=1 $testFile.FullName
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
