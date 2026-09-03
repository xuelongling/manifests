# SPDX-License-Identifier: MIT

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$testFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter "*.tests.ps1" | Sort-Object Name
foreach ($testFile in $testFiles) {
    Write-Host "==> $($testFile.Name)"
    & pwsh -NoProfile -File $testFile.FullName
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
