# SPDX-License-Identifier: MIT

param(
    [Parameter(Mandatory)]
    [ValidateSet("pre", "post")]
    [string] $Phase,

    [Parameter(Mandatory)]
    [string] $WorkspaceRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$workspace = [System.IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\', '/')
$workspacePrefix = $workspace + [System.IO.Path]::DirectorySeparatorChar
$manifestPath = Join-Path $workspace ".repo/manifests/bootstrap/r00.xml"
$agentRoot = Join-Path $workspace ".agents"
$mappings = @(
    @{ Destination = "AGENTS.md"; Source = ".agents/AGENTS.md" },
    @{ Destination = ".codex/config.toml"; Source = ".agents/codex/config.toml" },
    @{ Destination = ".codex/hooks.json"; Source = ".agents/codex/hooks.json" }
)

function Stop-Activation {
    param([Parameter(Mandatory)] [string] $Message)

    [Console]::Error.WriteLine("ERROR: Agent Activation Surface $Message")
    exit 1
}

function Get-CanonicalPath {
    param([Parameter(Mandatory)] [string] $Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

try {
    [xml] $manifest = Get-Content -LiteralPath $manifestPath -Raw
    $agentProject = $manifest.SelectSingleNode("/manifest/project[@path='.agents']")
    $agentRevision = [string] $agentProject.revision
}
catch {
    Stop-Activation "cannot read the selected bootstrap manifest: $($_.Exception.Message)"
}
if ($null -eq $agentProject -or $agentRevision -notmatch '^[0-9a-f]{40}$') {
    Stop-Activation "cannot identify the pinned .agents commit in bootstrap/r00.xml"
}

foreach ($mapping in $mappings) {
    $destination = Get-CanonicalPath (Join-Path $workspace $mapping.Destination)
    $source = Get-CanonicalPath (Join-Path $workspace $mapping.Source)

    if (-not $destination.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $source.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Activation "mapping escapes the Repo Workspace: $($mapping.Destination)"
    }

    if (-not (Test-Path -LiteralPath $destination)) {
        if ($Phase -eq "pre") {
            continue
        }
        Stop-Activation "is missing required symbolic link $($mapping.Destination)"
    }

    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        Stop-Activation "managed source is missing: $($mapping.Source)"
    }

    $projectPath = $mapping.Source.Substring(".agents/".Length)
    $expectedBlob = (& git -C $agentRoot rev-parse "$($agentRevision):$projectPath" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $expectedBlob -notmatch '^[0-9a-f]{40}$') {
        Stop-Activation "cannot read $projectPath from pinned agent commit $agentRevision"
    }
    $actualBlob = (& git -C $agentRoot hash-object -- $projectPath 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualBlob -cne $expectedBlob) {
        Stop-Activation "content does not match the pinned agent commit: $($mapping.Source)"
    }

    $item = Get-Item -LiteralPath $destination -Force
    $linkType = $item.PSObject.Properties["LinkType"]
    $linkTarget = $item.PSObject.Properties["Target"]
    if ($null -eq $linkType -or $linkType.Value -ne "SymbolicLink" -or
        $null -eq $linkTarget -or @($linkTarget.Value).Count -ne 1) {
        Stop-Activation "requires $($mapping.Destination) to be a symbolic link; copied files and other link types are forbidden"
    }

    $targetText = [string] @($linkTarget.Value)[0]
    if ([System.IO.Path]::IsPathRooted($targetText)) {
        $resolvedTarget = Get-CanonicalPath $targetText
    }
    else {
        $resolvedTarget = Get-CanonicalPath (Join-Path (Split-Path -Parent $destination) $targetText)
    }

    if (-not $resolvedTarget.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Activation "link escapes the Repo Workspace: $($mapping.Destination) -> $targetText"
    }
    if (-not $resolvedTarget.Equals($source, [System.StringComparison]::OrdinalIgnoreCase)) {
        Stop-Activation "link target conflicts with the managed source: $($mapping.Destination) -> $targetText"
    }
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
    $destinationHash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash
    if ($sourceHash -cne $destinationHash) {
        Stop-Activation "content does not match managed source: $($mapping.Destination)"
    }
}

exit 0
