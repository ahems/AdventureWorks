# Exercises the real automatic-seed branch with fake SQL and importer; no Azure access.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert($Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

class SeedLifecycleCommand {
    [string] $CommandText
    [int] $ExistingTables
    [bool] $Incomplete
    [int] $Calls
    [object] ExecuteScalar() { $this.Calls++; return $this.ExistingTables }
    [int] ExecuteNonQuery() {
        $this.Calls++
        if ($this.Incomplete) { throw 'Existing database is not a completed AdventureWorks seed' }
        return 0
    }
}

function Write-Log { param([string] $Message) }
function Import-ManufacturingOverlays {
    param($Connection, [string] $SqlFolder)
    $script:imports++
    if ($script:conflict) { throw 'Instruction conflict: existing non-NULL instructions are protected.' }
    return @{ InstructionRecordsVerified = 3; IllustrationRecordsVerified = 4; MappingRecordsVerified = 4 }
}

$seedPath = Join-Path $PSScriptRoot '../seed-database.ps1'
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($seedPath, [ref]$null, [ref]$errors)
Assert ($errors.Count -eq 0) 'Seed script parses'
$seed = $ast.Extent.Text
$branch = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
        $node.Extent.Text.StartsWith("if (`$env:SEED_SKIP_EXISTING -eq 'true')")
}, $true)
Assert ($null -ne $branch) 'Automatic deployment branch exists'
$script:seedRoot = Split-Path $seedPath
$runBranch = [scriptblock]::Create($branch.Extent.Text.Replace('$PSScriptRoot', '$script:seedRoot'))
$originalMode = $env:SEED_SKIP_EXISTING
$originalRuntimeClient = $env:RUNTIME_MANAGED_IDENTITY_CLIENT_ID
try {
    $env:RUNTIME_MANAGED_IDENTITY_CLIENT_ID = $null
    $env:SEED_SKIP_EXISTING = 'true'
    $conn = [object]::new()
    $cmd = [SeedLifecycleCommand]::new()
    $script:seedSuccess = $false
    $script:imports = 0
    $script:conflict = $false
    & $runBranch
    Assert ($cmd.Calls -eq 1 -and $script:imports -eq 0 -and -not $script:seedSuccess) 'Empty database continues into full seed'

    $cmd.ExistingTables = 100
    $cmd.Calls = 0
    & $runBranch
    Assert ($cmd.Calls -eq 2 -and $script:imports -eq 1 -and $script:seedSuccess) 'Populated database imports overlays and completes without full seed'
    Assert ($cmd.CommandText -match 'THROW 51011' -and $cmd.CommandText -match 'THROW 51012') 'Partial schema/model-empty guards fail closed'
    Assert ($cmd.CommandText -match 'THROW 51013' -and $cmd.CommandText -match 'THROW 51014') 'Missing/empty core seed data fails closed'
    foreach ($table in @('Production.Product', 'Person.Person', 'Sales.SalesOrderHeader')) {
        Assert ($cmd.CommandText.Contains("OBJECT_ID('$table', 'U') IS NULL") -and
            $cmd.CommandText.Contains("NOT EXISTS (SELECT 1 FROM $table)")) "Existing base seed requires populated $table"
    }

    $script:seedSuccess = $false
    $script:conflict = $true
    $failed = $false
    try { & $runBranch } catch { $failed = $_.Exception.Message -match 'Instruction conflict' }
    Assert ($failed -and -not $script:seedSuccess) 'Overlay conflict propagates without success'

    $script:conflict = $false
    $cmd.Incomplete = $true
    $before = $script:imports
    $failed = $false
    try { & $runBranch } catch { $failed = $_.Exception.Message -match 'not a completed' }
    Assert ($failed -and $script:imports -eq $before) 'Incomplete database fails without importing or resetting'

    $env:SEED_SKIP_EXISTING = 'false'
    $cmd.Calls = 0
    & $runBranch
    Assert ($cmd.Calls -eq 0) 'Explicit non-automatic invocation retains original full-seed workflow'

    $cleanup = $seed.IndexOf('Dropping ALL user objects')
    Assert ($branch.Extent.StartOffset -lt $cleanup) 'Existing-database guard precedes destructive cleanup'
    $validation = $seed.IndexOf('$null = Read-ManufacturingOverlays')
    Assert ($validation -gt 0 -and $validation -lt $cleanup) 'All artifacts validate before cleanup'
    $targeted = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.IfStatementAst] -and
            $node.Extent.Text.StartsWith('if ($ManufacturingOverlaysOnly)')
    }, $true)
    Assert ($targeted.Extent.EndOffset -lt $seed.IndexOf('Initialize-RuntimeDatabaseAccess') -and
        $targeted.Extent.Text -match 'return' -and
        $targeted.Extent.Text -match '-VerifyOnly:\$VerifyOnly' -and
        $targeted.Extent.Text -notmatch 'Initialize-RuntimeDatabaseAccess|Grant-RuntimeChangeTrackingAccess') 'Targeted verify-only exits before any runtime bootstrap/grants'
    Assert ($branch.Extent.Text -match 'return') 'Populated branch exits before full-seed mutations'
    $overlay = $seed.IndexOf('@{ ManufacturingOverlays=$true }')
    $previous = 0
    foreach ($file in @('Illustration.csv', 'ProductModel.csv', 'ProductModelIllustration.csv')) {
        $position = $seed.IndexOf("File='$file'")
        Assert ($position -gt $previous -and $position -lt $overlay) "Full overlay dependency order includes $file"
        $previous = $position
    }
    $loadBranch = $ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.IfStatementAst] -and
            $node.Extent.Text.StartsWith('if ($config.ManufacturingOverlays)')
    }, $true)
    Assert ($loadBranch.Extent.Text -match 'Import-ManufacturingOverlays' -and
        $loadBranch.Extent.Text -notmatch 'catch|Test-Path|skipping') 'Fresh seed overlay is mandatory and cannot silently skip/fail'
    Assert ($seed.LastIndexOf('Grant-RuntimeChangeTrackingAccess') -gt
        $seed.IndexOf("ENABLE CHANGE_TRACKING WITH")) 'Fresh object-scoped Change Tracking grant follows table creation and tracking enablement'
    Write-Output 'PASS: fresh/existing/partial seed selection, conflict propagation, mandatory artifact validation and dependency placement.'
} finally {
    $env:SEED_SKIP_EXISTING = $originalMode
    $env:RUNTIME_MANAGED_IDENTITY_CLIENT_ID = $originalRuntimeClient
}
