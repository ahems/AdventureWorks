# Local, dependency-free parser/transaction/SQL-contract tests. No Azure or SQL access.
param([string] $ArtifactsFolder)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../ManufacturingOverlays.psm1') -Force

function Assert($Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws([scriptblock] $Action, [string] $Pattern) {
    $failure = $null
    try { & $Action } catch { $failure = $_ }
    Assert ($null -ne $failure) "Expected failure matching '$Pattern'"
    Assert ($failure.Exception.Message -match $Pattern) "Unexpected error: $failure"
}

class OverlayTestParameter {
    [string] $ParameterName
    [object] $Value
    [System.Data.DbType] $DbType
    [int] $Size
}

class OverlayTestTransaction {
    [bool] $Committed
    [bool] $RolledBack
    [bool] $Disposed
    [void] Commit() { $this.Committed = $true }
    [void] Rollback() { $this.RolledBack = $true }
    [void] Dispose() { $this.Disposed = $true }
}

class OverlayTestCommand {
    [object] $Owner
    [object] $Transaction
    [int] $CommandTimeout
    [string] $CommandText
    [System.Collections.Generic.List[object]] $Parameters = [System.Collections.Generic.List[object]]::new()
    OverlayTestCommand([object] $owner) { $this.Owner = $owner }
    [object] CreateParameter() { return [OverlayTestParameter]::new() }
    [object] ExecuteScalar() {
        if ($null -eq $this.Transaction) { throw 'Missing transaction' }
        $this.Owner.Commands.Add($this)
        if ($this.Owner.FailAt -eq $this.Owner.Commands.Count) { throw 'Simulated SQL validation/conflict failure' }
        if ($this.CommandText.Contains('DECLARE @before table')) {
            $counts = @{}
            foreach ($name in @('@targets', '@illustrations', '@mappings')) {
                $json = $this.Parameters.Where({ $_.ParameterName -eq $name })[0].Value
                $counts[$name] = @(ConvertFrom-Json -InputObject $json -NoEnumerate)[0].Count
            }
            return ConvertTo-Json -Compress -InputObject @{
                ProtectedInstructionSnapshotsVerified = 125
                ProtectedInstructionsBeforeSha256 = 'FAKE-HASH'
                ProtectedInstructionsAfterSha256 = 'FAKE-HASH'
                InstructionRecordsVerified = $counts['@targets']
                IllustrationRecordsVerified = $counts['@illustrations']
                MappingRecordsVerified = $counts['@mappings']
            }
        }
        if ($this.CommandText.Contains('FOR JSON PATH')) { return '[{"ProductModelID":1,"InstructionsHash":"ABCD"}]' }
        if ($this.Owner.AlreadyImported -or $this.Parameters.Where({ $_.ParameterName -eq '@verify' })[0].Value -eq 1) { return 0 }
        return 1
    }
    [void] Dispose() { }
}

class OverlayTestConnection {
    [int] $FailAt
    [bool] $AlreadyImported
    [object] $Transaction
    [System.Data.IsolationLevel] $Isolation
    [System.Collections.Generic.List[object]] $Commands = [System.Collections.Generic.List[object]]::new()
    [object] BeginTransaction([System.Data.IsolationLevel] $isolation) {
        $this.Isolation = $isolation
        $this.Transaction = [OverlayTestTransaction]::new()
        return $this.Transaction
    }
    [object] CreateCommand() { return [OverlayTestCommand]::new($this) }
}

$fixtures = Join-Path $PSScriptRoot ('.manufacturing-fixtures-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixtures
$instructionPath = Join-Path $fixtures 'ProductModelInstructions-ai.csv'
$illustrationPath = Join-Path $fixtures 'Illustration-ai.csv'
$mappingPath = Join-Path $fixtures 'ProductModelIllustration-ai.csv'

function Write-Fixtures {
    # Deliberately include Unicode, apostrophes, embedded newlines, and XML attributes.
    [IO.File]::WriteAllText($instructionPath, "19+|<root note=`"worker's`">`nMálaga`n</root>&|`r`n5+|<root/>&|`n59+|<root/>&|")
    [IO.File]::WriteAllText($illustrationPath, "100191+|<Viewbox/>+|2026-11-04 10:00:00.123&|`n100192+|<Viewbox/>+|2026-11-04 10:00:00&|`n100051+|<Viewbox/>+|2026-11-04 10:00:00&|`n100591+|<Viewbox/>+|2026-11-04 10:00:00&|")
    [IO.File]::WriteAllText($mappingPath, "19`t100191`t2026-11-04 10:00:00`r`n19`t100192`t2026-11-04 10:00:00`n5`t100051`t2026-11-04 10:00:00`n59`t100591`t2026-11-04 10:00:00`n")
}

try {
    Write-Fixtures
    $data = Read-ManufacturingOverlays $fixtures
    Assert ($data.Instructions.Count -eq 3) 'Three instruction records'
    Assert ($data.Illustrations.Count -eq 4 -and $data.Mappings.Count -eq 4) 'Four diagrams/mappings'
    Assert ($data.Instructions[0].Xml.Contains("`nMálaga`n")) 'Preserves Unicode and embedded newlines'
    Assert ($data.Illustrations[0].ModifiedDate.Millisecond -eq 123) 'Parses invariant datetime'

    $connection = [OverlayTestConnection]::new()
    $result = Import-ManufacturingOverlays $connection $fixtures
    Assert ($connection.Commands.Count -eq 24) 'Snapshot, import, full verification and preservation execute'
    Assert ($result.InstructionRecords -eq 3) 'Reports artifact records'
    Assert ($connection.Isolation -eq [System.Data.IsolationLevel]::Serializable) 'Serializable transaction'
    Assert ($connection.Transaction.Committed -and -not $connection.Transaction.RolledBack -and $connection.Transaction.Disposed) 'Commit and disposal'
    Assert ($result.InstructionsUpdated -eq 3 -and $result.IllustrationsInserted -eq 4 -and $result.MappingsInserted -eq 4) 'New/updated counts'
    Assert ($result.SourceRecordsVerified -eq 11 -and $result.ProtectedInstructionSnapshotsVerified -eq 125) 'Verified source and preservation counts'
    Assert ($result.InstructionRecordsVerified -eq 3 -and $result.IllustrationRecordsVerified -eq 4 -and $result.MappingRecordsVerified -eq 4) 'Database-returned counts'
    Assert ($result.ProtectedInstructionsBeforeSha256 -eq $result.ProtectedInstructionsAfterSha256) 'Protected snapshot digest logs agree'
    Assert ($result.ArtifactSha256.Count -eq 3) 'Artifact hashes reported'
    $instructionSql = $connection.Commands[1].CommandText
    $illustrationSql = $connection.Commands[4].CommandText
    $mappingSql = $connection.Commands[8].CommandText
    Assert ($instructionSql -match 'xml\(Production.ManuInstructionsSchemaCollection\)') 'SQL performs typed XML validation'
    Assert ($instructionSql -match 'WHERE ProductModelID = @id AND Instructions IS NULL') 'Only fills NULL instructions'
    Assert ($instructionSql -match 'Instructions IS NOT NULL' -and $instructionSql -match 'THROW 51001') 'Conflicting original instructions rejected'
    Assert ($instructionSql -match 'THROW 51000' -and $instructionSql -notmatch 'INSERT') 'Missing model fails; never inserts models'
    Assert ($instructionSql -notmatch "Málaga|worker's") 'XML not interpolated into SQL'
    Assert ($connection.Commands[1].Parameters.Where({ $_.ParameterName -eq '@xml' })[0].Value.Contains('Málaga')) 'XML bound as parameter'
    Assert ($instructionSql -match 'CONVERT\(xml, @xml, 0\)' -and $instructionSql -match 'CONVERT\(varbinary\(max\)') 'SQL normalization and exact byte comparison'
    Assert ($illustrationSql -match 'THROW 51002' -and $illustrationSql -match 'Diagram IS NULL') 'Existing diagram conflict protection'
    Assert ($illustrationSql -match 'IDENTITY_INSERT Production.Illustration OFF') 'Explicit identity cleanup'
    Assert ($mappingSql -match 'THROW 51003' -and $mappingSql -match 'THROW 51004') 'Mapping existence/ownership guards'
    Assert ($mappingSql -match 'IF NOT EXISTS' -and $mappingSql -notmatch 'UPDATE|DELETE') 'Existing mapping is never changed'
    foreach ($command in $connection.Commands) {
        if ($command.CommandText -notmatch 'DECLARE @before table') {
            Assert ($command.CommandText -match 'UPDLOCK, HOLDLOCK') 'Concurrency locks'
        }
        if ($command.CommandText -notmatch 'FOR JSON PATH') {
            Assert ($command.Parameters.Count -ge 2) 'All value-bearing SQL binds parameters'
        }
    }
    $preservationSql = $connection.Commands[23].CommandText
    Assert ($preservationSql -match 'THROW 51008' -and $preservationSql -match 'THROW 51009') 'Count and protected-original snapshot verification'
    Assert ($preservationSql -match 'THROW 51010' -and $preservationSql -match 'JOIN Production.ProductModelIllustration') 'Actual database counts match full source IDs and mapping pairs'
    Assert ($preservationSql -match 'HASHBYTES' -and $preservationSql -match 'b.InstructionsHash IS NOT NULL OR NOT EXISTS') 'All originals and non-targets protected'

    $connection = [OverlayTestConnection]::new()
    $connection.AlreadyImported = $true
    $replay = Import-ManufacturingOverlays $connection $fixtures
    Assert ($replay.InstructionsUpdated -eq 0 -and $replay.IllustrationsInserted -eq 0 -and $replay.MappingsInserted -eq 0) 'Idempotent replay new counts are zero'
    Assert ($replay.InstructionsUnchanged -eq 3 -and $replay.IllustrationsUnchanged -eq 4 -and $replay.MappingsUnchanged -eq 4) 'Idempotent unchanged counts'
    $connection = [OverlayTestConnection]::new()
    $verified = Import-ManufacturingOverlays $connection $fixtures -VerifyOnly
    Assert ($connection.Commands.Count -eq 13 -and $verified.Mode -eq 'VerifyOnly') 'Verify-only executes snapshot plus source and preservation checks'
    Assert ($verified.InstructionsUpdated -eq 0 -and $verified.IllustrationsInserted -eq 0 -and $verified.MappingsInserted -eq 0) 'Verify-only writes nothing'
    foreach ($command in $connection.Commands) {
        foreach ($parameter in $command.Parameters.Where({ $_.ParameterName -eq '@verify' })) {
            Assert ($parameter.Value -eq 1) 'All verify-only commands use read-only guard'
        }
    }

    # Driver failures in every stage must propagate and roll back all preceding writes.
    foreach ($failAt in @(1, 2, 5, 8, 9, 12, 13, 16, 20, 23, 24)) {
        $connection = [OverlayTestConnection]::new()
        $connection.FailAt = $failAt
        Assert-Throws { Import-ManufacturingOverlays $connection $fixtures } 'Simulated SQL'
        Assert ($connection.Transaction.RolledBack -and -not $connection.Transaction.Committed -and $connection.Transaction.Disposed) "Rollback at command $failAt"
    }

    # Ensure fake SQL derives counts from parameter arrays, including singleton JSON arrays.
    [IO.File]::WriteAllText($instructionPath, '42+|<root/>&|')
    [IO.File]::WriteAllText($illustrationPath, '200042+|<Viewbox/>+|2026-11-04 10:00:00&|')
    [IO.File]::WriteAllText($mappingPath, "42`t200042`t2026-11-04 10:00:00")
    $connection = [OverlayTestConnection]::new()
    $single = Import-ManufacturingOverlays $connection $fixtures
    Assert ($single.InstructionRecordsVerified -eq 1 -and $single.IllustrationRecordsVerified -eq 1 -and
        $single.MappingRecordsVerified -eq 1 -and $single.SourceRecordsVerified -eq 3) 'Dynamic singleton verification counts'
    Write-Fixtures

    # Original instructions may receive figures without adding/replacing instruction overlays.
    $basePath = Join-Path $fixtures 'ProductModel.csv'
    $originalXml = '<root xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions">Original wheel instructions</root>'
    [IO.File]::WriteAllText($basePath, "44+|Touring Front Wheel+|+|$originalXml+|guid+|2026-11-04 10:00:00&|")
    [IO.File]::AppendAllText($illustrationPath, "100441+|<Viewbox/>+|2026-11-04 10:00:00&|")
    [IO.File]::AppendAllText($mappingPath, "44`t100441`t2026-11-04 10:00:00`n")
    $supplemental = Read-ManufacturingOverlays $fixtures
    Assert ($supplemental.Instructions.Count -eq 3 -and $supplemental.Mappings.Count -eq 5) 'Supplemental original has mapping but no instruction overlay'
    $connection = [OverlayTestConnection]::new()
    $supplementImport = Import-ManufacturingOverlays $connection $fixtures
    Assert ($supplementImport.InstructionRecordsVerified -eq 3 -and $supplementImport.MappingRecordsVerified -eq 5) 'Supplemental mapping included in full import verification counts'
    $instructionCommands = @($connection.Commands | Where-Object { $_.CommandText.Contains('DECLARE @incoming xml(Production.ManuInstructionsSchemaCollection)') })
    Assert (@($instructionCommands | ForEach-Object { $_.Parameters.Where({ $_.ParameterName -eq '@id' })[0].Value } | Where-Object { $_ -eq 44 }).Count -eq 0) 'Original supplemental instructions never targeted for writes'
    Assert ($connection.Commands[-1].CommandText -match 'b.InstructionsHash IS NOT NULL OR NOT EXISTS') 'Original supplemental instructions covered by preservation snapshot'

    foreach ($invalid in @(
        '44+|Wheel+|+|+|guid+|date&|',
        "44+|Wheel+|+|$($originalXml.Replace('Original wheel instructions', '<diag>1</diag>'))+|guid+|date&|",
        '44+|Wheel+|+|<root/>+|guid+|date&|',
        "53+|Pedal+|+|$originalXml+|guid+|date&|",
        'version https://git-lfs.github.com/spec/v1'
    )) {
        [IO.File]::WriteAllText($basePath, $invalid)
        $connection = [OverlayTestConnection]::new()
        Assert-Throws { Import-ManufacturingOverlays $connection $fixtures } '.'
        Assert ($null -eq $connection.Transaction) 'Invalid original supplemental source rejected before transaction'
    }
    Remove-Item $basePath
    Assert-Throws { Read-ManufacturingOverlays $fixtures } '.'
    Write-Fixtures

    foreach ($bad in @(
        '19+|<root/>',                            # Missing terminator
        '19+|<root/>+|extra&|',                   # Wrong column count
        '19+|<root/>&|19+|<root/>&|',             # Duplicate
        '0+|<root/>&|',                          # Invalid ID
        '2147483648+|<root/>&|',                  # Overflow
        '19+|<root>&|',                          # Invalid XML
        '19+|<!DOCTYPE root [<!ENTITY x "x">]><root>&x;</root>&|',
        'version https://git-lfs.github.com/spec/v1',
        ''
    )) {
        [IO.File]::WriteAllText($instructionPath, $bad)
        $connection = [OverlayTestConnection]::new()
        Assert-Throws { Import-ManufacturingOverlays $connection $fixtures } '.'
        Assert ($null -eq $connection.Transaction) 'Parser failure precedes transaction'
    }
    Write-Fixtures
    [IO.File]::WriteAllText($illustrationPath, '100191+|<Viewbox/>+|not-a-date&|')
    Assert-Throws { Read-ManufacturingOverlays $fixtures } 'datetime'
    Write-Fixtures
    [IO.File]::WriteAllText($mappingPath, "19`t999999`t2026-11-04 10:00:00")
    Assert-Throws { Read-ManufacturingOverlays $fixtures } 'must reference'
    Write-Fixtures
    [IO.File]::AppendAllText($mappingPath, "19`t100191`t2026-11-04 10:00:00")
    Assert-Throws { Read-ManufacturingOverlays $fixtures } 'Duplicate'
    Write-Fixtures
    Remove-Item $illustrationPath
    Assert-Throws { Read-ManufacturingOverlays $fixtures } '.'

    $seedPath = Join-Path $PSScriptRoot '../seed-database.ps1'
    $seed = [IO.File]::ReadAllText($seedPath)
    $target = $seed.IndexOf('if ($ManufacturingOverlaysOnly)')
    Assert ($target -gt 0 -and $target -lt $seed.IndexOf('Dropping ALL user objects')) 'Targeted branch precedes destructive schema operations'
    Assert ($seed.Substring($target, $seed.IndexOf('# ---------------------------------------------------------------------', $target) - $target) -match 'return') 'Targeted mode exits full seed path'
    Assert ($seed.IndexOf("@{ ManufacturingOverlays=") -gt $seed.IndexOf("File='ProductModelIllustration.csv'")) 'Overlay follows original mapping load'
    foreach ($file in @($seedPath, (Join-Path $PSScriptRoot '../ManufacturingOverlays.psm1'))) {
        $parseErrors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$parseErrors)
        Assert ($parseErrors.Count -eq 0) "Valid PowerShell AST: $file"
    }
    if ($ArtifactsFolder) {
        $actual = Read-ManufacturingOverlays $ArtifactsFolder
        $expectedTotal = $actual.Instructions.Count + $actual.Illustrations.Count + $actual.Mappings.Count
        $driver = [OverlayTestConnection]::new()
        $actualImport = Import-ManufacturingOverlays $driver $ArtifactsFolder
        Assert ($actualImport.InstructionRecords -eq $actual.Instructions.Count -and
            $actualImport.IllustrationRecords -eq $actual.Illustrations.Count -and
            $actualImport.MappingRecords -eq $actual.Mappings.Count) 'Generated artifact counts'
        Assert ($actualImport.SourceRecordsVerified -eq $expectedTotal) 'Generated source verification contract'
        Assert (($actualImport.ProductModelIDs -join ',') -eq ($actual.Instructions.ID -join ',')) 'Generated model IDs match parsed source'
        Assert (($actualImport.IllustrationIDs -join ',') -eq ($actual.Illustrations.ID -join ',')) 'Generated illustration IDs match parsed source'
        Assert ($actualImport.InstructionsUpdated -eq $actual.Instructions.Count -and
            $actualImport.IllustrationsInserted -eq $actual.Illustrations.Count -and
            $actualImport.MappingsInserted -eq $actual.Mappings.Count) 'Generated initial mutation counts'
        Assert ($driver.Commands.Count -eq 2 * $expectedTotal + 2) 'Generated import and verification command count'
        $driver = [OverlayTestConnection]::new()
        $driver.AlreadyImported = $true
        $actualReplay = Import-ManufacturingOverlays $driver $ArtifactsFolder
        Assert ($actualReplay.InstructionsUpdated + $actualReplay.IllustrationsInserted + $actualReplay.MappingsInserted -eq 0) 'Generated idempotent replay contract'
        Assert ($actualReplay.InstructionsUnchanged -eq $actual.Instructions.Count -and
            $actualReplay.IllustrationsUnchanged -eq $actual.Illustrations.Count -and
            $actualReplay.MappingsUnchanged -eq $actual.Mappings.Count -and
            $actualReplay.SourceRecordsVerified -eq $expectedTotal) 'Generated replay unchanged and verification counts'
        $driver = [OverlayTestConnection]::new()
        $actualVerification = Import-ManufacturingOverlays $driver $ArtifactsFolder -VerifyOnly
        Assert ($actualVerification.SourceRecordsVerified -eq $expectedTotal -and
            $driver.Commands.Count -eq $expectedTotal + 2) 'Generated verify-only counts'
        Write-Output "PASS: generated artifacts parsed and exercised through fake import/replay/verify-only driver."
        $actualImport | ConvertTo-Json -Compress -Depth 5 | Write-Output
    }
    Write-Output 'PASS: manufacturing overlay parsing, parameterization, SQL safety contracts, and transaction orchestration.'
    Write-Output 'SQL schema validation/conflict execution requires SQL Server; local tests use a fake command/transaction driver.'
} finally {
    Remove-Item -LiteralPath $fixtures -Recurse -Force
}
