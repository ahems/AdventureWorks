Set-StrictMode -Version Latest

# Seed data files may ship as plain CSV or gzip (`<name>.csv.gz`, stored in Git LFS).
# Callers always refer to the logical `<name>.csv` file name.

function Resolve-SeedDataFile {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Folder,
        [Parameter(Mandatory)][string] $FileName
    )
    $plain = Join-Path $Folder $FileName
    if (Test-Path -LiteralPath $plain -PathType Leaf) { return $plain }
    $compressed = "$plain.gz"
    if (Test-Path -LiteralPath $compressed -PathType Leaf) { return $compressed }
    return $null
}

function Read-SeedDataText {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string] $Path,
        [System.Text.Encoding] $Encoding = [System.Text.Encoding]::UTF8
    )
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    # Detect gzip by magic bytes, not extension: an un-pulled Git LFS pointer named *.csv.gz is plain
    # text and is returned as-is so callers can report it as a pointer.
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0x1F -and $bytes[1] -eq 0x8B) {
        $source = [System.IO.MemoryStream]::new($bytes)
        $gzip = [System.IO.Compression.GZipStream]::new($source, [System.IO.Compression.CompressionMode]::Decompress)
        $reader = [System.IO.StreamReader]::new($gzip, $Encoding, $true)
        try { return $reader.ReadToEnd() }
        finally { $reader.Dispose(); $gzip.Dispose(); $source.Dispose() }
    }
    $reader = [System.IO.StreamReader]::new([System.IO.MemoryStream]::new($bytes), $Encoding, $true)
    try { return $reader.ReadToEnd() }
    finally { $reader.Dispose() }
}

function Test-GitLfsPointerText {
    param([AllowNull()][string] $Text)
    return ($null -ne $Text -and $Text -match '^\s*version\s+https://git-lfs\.github\.com')
}

function New-SeedBulkCopy {
    param($Connection, $Transaction, [switch] $KeepIdentity)
    $namespace = $Connection.GetType().Namespace
    $bulkType = [type]"$namespace.SqlBulkCopy"
    $optionsType = [type]"$namespace.SqlBulkCopyOptions"
    $options = if ($KeepIdentity) { [Enum]::Parse($optionsType, 'KeepIdentity') } else { [Enum]::Parse($optionsType, 'Default') }
    $bulk = [Activator]::CreateInstance($bulkType, @($Connection, $options, $Transaction))
    $bulk.BatchSize = 5000
    $bulk.BulkCopyTimeout = 600
    return $bulk
}

function Invoke-SeedNonQuery {
    param($Connection, $Transaction, [string] $Sql)
    $command = $Connection.CreateCommand()
    try {
        $command.Transaction = $Transaction
        $command.CommandTimeout = 600
        $command.CommandText = $Sql
        return $command.ExecuteNonQuery()
    }
    finally { $command.Dispose() }
}

function Get-SeedStageExpression {
    param([hashtable] $Column)
    if ($Column.Type -eq 'vector') { return "CAST(s.[$($Column.Name)] AS VECTOR(1536))" }
    return "s.[$($Column.Name)]"
}

function Get-SeedStageSelectExpression {
    param([hashtable] $Column)
    if ($Column.Type -eq 'vector') { return "CAST(NULL AS nvarchar(max)) AS [$($Column.Name)]" }
    if ($Column.Type -eq 'xml') { return "CAST(NULL AS xml) AS [$($Column.Name)]" }
    return "[$($Column.Name)]"
}

<#
Set-based idempotent load: bulk-copies the parsed rows into a temp table, then (optionally) updates existing
rows by primary key and inserts only missing keys. Same outcome as the row-by-row INSERT ... WHERE NOT EXISTS
path, in a handful of round trips. Throws (after rolling back) when the data cannot be loaded set-based,
e.g. duplicate keys in the file or a constraint violation, so the caller can fall back to the row path.
#>
function Invoke-SeedStagedUpsert {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)][string] $Schema,
        [Parameter(Mandatory)][string] $Table,
        [Parameter(Mandatory)][System.Data.DataTable] $Data,
        [Parameter(Mandatory)][object[]] $Columns,
        [Parameter(Mandatory)][string[]] $KeyColumns,
        [bool] $UpdateIfExists
    )
    $target = "[$Schema].[$Table]"
    $loadColumns = @($Columns | Where-Object { -not $_.UseDefault })
    $loadNames = @($loadColumns | ForEach-Object { $_.Name })
    foreach ($key in $KeyColumns) {
        if ($key -notin $loadNames) { throw "Key column $key is not loaded from the file." }
    }
    $hasIdentity = $false
    $command = $Connection.CreateCommand()
    try {
        $command.CommandText = "SELECT name FROM sys.identity_columns WHERE object_id = OBJECT_ID(N'$target')"
        $identityName = $command.ExecuteScalar()
        $hasIdentity = ($null -ne $identityName -and $identityName -isnot [DBNull] -and [string]$identityName -in $loadNames)
    }
    finally { $command.Dispose() }
    $stageSelect = ($loadColumns | ForEach-Object { Get-SeedStageSelectExpression $_ }) -join ', '
    $keyJoin = ($KeyColumns | ForEach-Object { "t.[$_] = s.[$_]" }) -join ' AND '
    $keyList = ($KeyColumns | ForEach-Object { "[$_]" }) -join ', '

    $transaction = $Connection.BeginTransaction()
    $identityOn = $false
    try {
        $null = Invoke-SeedNonQuery $Connection $transaction "SELECT TOP 0 $stageSelect INTO #seed_stage FROM $target"
        $bulk = New-SeedBulkCopy -Connection $Connection -Transaction $transaction -KeepIdentity
        try {
            $bulk.DestinationTableName = '#seed_stage'
            foreach ($name in $loadNames) { $null = $bulk.ColumnMappings.Add($name, $name) }
            $bulk.WriteToServer($Data)
        }
        finally { $bulk.Close() }

        $command = $Connection.CreateCommand()
        try {
            $command.Transaction = $transaction
            $command.CommandText = "SELECT COUNT(*) FROM (SELECT $keyList FROM #seed_stage GROUP BY $keyList HAVING COUNT(*) > 1) d"
            if ([int]$command.ExecuteScalar() -gt 0) { throw 'File contains duplicate keys.' }
        }
        finally { $command.Dispose() }

        $updated = 0
        $updateColumns = @($loadColumns | Where-Object { $_.Name -notin $KeyColumns })
        if ($UpdateIfExists -and $updateColumns.Count -gt 0) {
            $setList = ($updateColumns | ForEach-Object { "t.[$($_.Name)] = $(Get-SeedStageExpression $_)" }) -join ', '
            $updated = Invoke-SeedNonQuery $Connection $transaction "UPDATE t SET $setList FROM $target t INNER JOIN #seed_stage s ON $keyJoin"
        }

        if ($hasIdentity) {
            $null = Invoke-SeedNonQuery $Connection $transaction "SET IDENTITY_INSERT $target ON"
            $identityOn = $true
        }
        $insertList = ($loadNames | ForEach-Object { "[$_]" }) -join ', '
        $selectList = ($loadColumns | ForEach-Object { Get-SeedStageExpression $_ }) -join ', '
        $inserted = Invoke-SeedNonQuery $Connection $transaction "INSERT INTO $target ($insertList) SELECT $selectList FROM #seed_stage s WHERE NOT EXISTS (SELECT 1 FROM $target t WHERE $keyJoin)"
        if ($identityOn) {
            $null = Invoke-SeedNonQuery $Connection $transaction "SET IDENTITY_INSERT $target OFF"
            $identityOn = $false
        }
        $null = Invoke-SeedNonQuery $Connection $transaction 'DROP TABLE #seed_stage'
        $transaction.Commit()
        return [pscustomobject]@{
            Inserted = $inserted
            Updated  = $updated
            Skipped  = $Data.Rows.Count - $inserted - $updated
        }
    }
    catch {
        try { $transaction.Rollback() } catch { }
        # IDENTITY_INSERT and temp tables are session state; clear both so a fallback path starts clean.
        if ($identityOn) { try { $null = Invoke-SeedNonQuery $Connection $null "SET IDENTITY_INSERT $target OFF" } catch { } }
        try { $null = Invoke-SeedNonQuery $Connection $null "DROP TABLE IF EXISTS #seed_stage" } catch { }
        throw
    }
    finally { $transaction.Dispose() }
}

<#
Bulk-copies $Data into #seed_update_stage (columns declared by $StageDefinition, e.g. '[Id] int NOT NULL, ...')
and runs $UpdateSql, which joins to that table. Returns the number of rows the update affected.
#>
function Invoke-SeedStagedUpdate {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)][System.Data.DataTable] $Data,
        [Parameter(Mandatory)][string] $StageDefinition,
        [Parameter(Mandatory)][string] $UpdateSql
    )
    $transaction = $Connection.BeginTransaction()
    try {
        $null = Invoke-SeedNonQuery $Connection $transaction "CREATE TABLE #seed_update_stage ($StageDefinition)"
        $bulk = New-SeedBulkCopy -Connection $Connection -Transaction $transaction
        try {
            $bulk.DestinationTableName = '#seed_update_stage'
            foreach ($column in $Data.Columns) { $null = $bulk.ColumnMappings.Add($column.ColumnName, $column.ColumnName) }
            $bulk.WriteToServer($Data)
        }
        finally { $bulk.Close() }
        $affected = Invoke-SeedNonQuery $Connection $transaction $UpdateSql
        $null = Invoke-SeedNonQuery $Connection $transaction 'DROP TABLE #seed_update_stage'
        $transaction.Commit()
        return $affected
    }
    catch {
        try { $transaction.Rollback() } catch { }
        try { $null = Invoke-SeedNonQuery $Connection $null 'DROP TABLE IF EXISTS #seed_update_stage' } catch { }
        throw
    }
    finally { $transaction.Dispose() }
}

Export-ModuleMember -Function Resolve-SeedDataFile, Read-SeedDataText, Test-GitLfsPointerText, Invoke-SeedStagedUpsert, Invoke-SeedStagedUpdate
