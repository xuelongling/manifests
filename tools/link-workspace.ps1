# SPDX-License-Identifier: MIT

param(
    [Parameter(Mandatory)] [string] $WorkspaceRoot,
    [switch] $Migrate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$workspace = (Get-Item -LiteralPath $WorkspaceRoot -Force).FullName
$project = Join-Path $workspace "tcfg"
$gitRoot = (& git -C $project rev-parse --show-toplevel | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($gitRoot) -ne $project) {
    throw "Expected the tcfg repository at $project"
}

function Assert-Ordinary($Item) {
    if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $Item.LinkType) {
        throw "Unexpected link or reparse point: $($Item.FullName)"
    }
}

function Get-ContentHash([string] $Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $file = [IO.File]::OpenRead($Path)
    try { [BitConverter]::ToString($algorithm.ComputeHash($file)) }
    finally { $file.Dispose(); $algorithm.Dispose() }
}

function Merge-Entry($Item, [string] $Destination) {
    Assert-Ordinary $Item
    $existing = Get-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        Assert-Ordinary $existing
        if ($existing.PSIsContainer -ne $Item.PSIsContainer) {
            throw "File and directory conflict at $Destination"
        }
    }

    if ($Item.PSIsContainer) {
        [IO.Directory]::CreateDirectory($Destination) | Out-Null
        foreach ($child in Get-ChildItem -LiteralPath $Item.FullName -Force) {
            Merge-Entry $child (Join-Path $Destination $child.Name)
        }
    }
    else {
        Copy-Item -LiteralPath $Item.FullName -Destination $Destination -Force
        if ((Get-ContentHash $Item.FullName) -ne (Get-ContentHash $Destination)) {
            throw "Migrated file differs from its original: $($Item.FullName)"
        }
    }
}

Assert-Ordinary (Get-Item -LiteralPath $workspace -Force)
Assert-Ordinary (Get-Item -LiteralPath $project -Force)

foreach ($name in @("AGENTS.md", "CONTEXT-MAP.md", "docs")) {
    $source = Join-Path $project $name
    $destination = Join-Path $workspace $name
    $old = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    $alreadyLinked = $false

    if ($null -ne $old -and ($old.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        $target = [string] $old.Target
        if ($old.LinkType -eq "SymbolicLink" -and $target) {
            if (-not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $workspace $target }
            $alreadyLinked = [IO.Path]::GetFullPath($target) -eq $source
        }
        if (-not $alreadyLinked) { throw "Unexpected existing link: $destination" }
    }
    elseif ($null -ne $old) {
        if (-not $Migrate) {
            throw "Existing workspace content requires link-workspace --migrate: $destination"
        }
        if ($old.PSIsContainer -ne ($name -eq "docs")) {
            throw "Unexpected workspace entry type: $destination"
        }
        Merge-Entry $old $source
    }

    $sourceItem = Get-Item -LiteralPath $source -Force
    Assert-Ordinary $sourceItem
    if ($sourceItem.PSIsContainer -ne ($name -eq "docs")) {
        throw "Unexpected tcfg entry type: $source"
    }
    if ($alreadyLinked) {
        Write-Output "$name -> tcfg/$name"
        continue
    }

    $temporary = Join-Path $workspace (".workspace-link-" + [Guid]::NewGuid().ToString("N"))
    $previous = "$temporary-previous"
    $previousName = [IO.Path]::GetFileName($previous)
    New-Item -ItemType SymbolicLink -Path $temporary -Target $source | Out-Null
    try {
        if ($null -ne $old) {
            Rename-Item -LiteralPath $destination -NewName $previousName
        }
        Rename-Item -LiteralPath $temporary -NewName $name
    }
    catch {
        if ((Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $destination)) {
            Rename-Item -LiteralPath $previous -NewName $name
        }
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary
        }
        throw
    }

    if ($null -ne $old) {
        $saved = Get-Item -LiteralPath $previous -Force
        if ([IO.Path]::GetDirectoryName($saved.FullName) -ne $workspace -or $saved.FullName -ne $previous) {
            throw "Unexpected temporary migration path: $previous"
        }
        Remove-Item -LiteralPath $previous -Recurse
    }
    Write-Output "$name -> tcfg/$name"
}
