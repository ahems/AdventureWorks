Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-ManufacturingOverlayRows {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][ValidateSet('Instructions', 'Illustrations', 'Mappings')][string] $Kind
    )

    $text = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false, $true))
    if ($text -match '^\s*version https://git-lfs.github.com') {
        throw "Overlay is a Git LFS pointer: $Path"
    }
    if ([string]::IsNullOrWhiteSpace($text)) { throw "Empty overlay: $Path" }
    if ($Kind -eq 'Mappings') {
        $rows = $text -split '\r?\n'
        $delimiter = "`t"
    } else {
        if ($text.TrimEnd() -notmatch '&\|$') { throw "Missing &| record terminator: $Path" }
        $rows = $text -split '&\|(?:\r?\n)?'
        $delimiter = '+|'
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($row in $rows) {
        if ([string]::IsNullOrWhiteSpace($row)) { continue }
        $fields = $row -split [regex]::Escape($delimiter)
        $expected = if ($Kind -eq 'Instructions') { 2 } else { 3 }
        if ($fields.Count -ne $expected) { throw "Expected $expected columns in $Path" }
        $id = 0
        if ($fields[0] -notmatch '^[1-9][0-9]*$' -or -not [int]::TryParse($fields[0], [ref]$id)) {
            throw "Invalid positive integer ID in $Path"
        }
        $otherId = 0
        if ($Kind -eq 'Mappings' -and (
            $fields[1] -notmatch '^[1-9][0-9]*$' -or -not [int]::TryParse($fields[1], [ref]$otherId))) {
            throw "Invalid illustration ID in $Path"
        }
        $key = if ($Kind -eq 'Mappings') { "$id/$otherId" } else { [string]$id }
        if (-not $seen.Add($key)) { throw "Duplicate overlay key $key in $Path" }

        $date = $null
        if ($Kind -ne 'Instructions') {
            $date = [datetime]::MinValue
            $formats = [string[]]@('yyyy-MM-dd HH:mm:ss.FFFFFFF', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-ddTHH:mm:ss.FFFFFFF', 'yyyy-MM-ddTHH:mm:ss')
            if (-not [datetime]::TryParseExact($fields[2], $formats,
                [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$date) -or
                $date -lt [datetime]'1753-01-01') {
                throw "Invalid SQL datetime in $Path"
            }
        }
        if ($Kind -ne 'Mappings') {
            if ([string]::IsNullOrWhiteSpace($fields[1])) { throw "Empty XML in $Path" }
            $settings = [System.Xml.XmlReaderSettings]::new()
            $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
            $settings.XmlResolver = $null
            $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($fields[1]), $settings)
            try { while ($reader.Read()) { } } finally { $reader.Dispose() }
        }
        [pscustomobject]@{ ID = $id; OtherID = $otherId; Xml = $fields[1]; ModifiedDate = $date }
    }
}

function Read-ManufacturingOverlays {
    param([Parameter(Mandatory)][string] $SqlFolder)

    $instructions = @(Read-ManufacturingOverlayRows -Path (Join-Path $SqlFolder 'ProductModelInstructions-ai.csv') -Kind Instructions)
    $illustrations = @(Read-ManufacturingOverlayRows -Path (Join-Path $SqlFolder 'Illustration-ai.csv') -Kind Illustrations)
    $mappings = @(Read-ManufacturingOverlayRows -Path (Join-Path $SqlFolder 'ProductModelIllustration-ai.csv') -Kind Mappings)
    if ($instructions.Count -eq 0 -or $illustrations.Count -eq 0 -or $mappings.Count -eq 0) {
        throw 'Each manufacturing artifact must contain at least one record.'
    }
    $supplementalIds = @($mappings | Where-Object { $_.ID -notin $instructions.ID } | ForEach-Object { $_.ID } | Sort-Object -Unique)
    if ($supplementalIds.Count -gt 0) {
        $basePath = Join-Path $SqlFolder 'ProductModel.csv'
        $baseText = [System.IO.File]::ReadAllText($basePath, [System.Text.UTF8Encoding]::new($false, $true))
        if ($baseText -match '^\s*version https://git-lfs.github.com' -or $baseText.TrimEnd() -notmatch '&\|$') {
            throw 'Supplemental mappings require a complete, hydrated original ProductModel.csv.'
        }
        $eligible = [System.Collections.Generic.HashSet[int]]::new()
        $seen = [System.Collections.Generic.HashSet[int]]::new()
        foreach ($baseRow in ($baseText -split '&\|(?:\r?\n)?')) {
            if ([string]::IsNullOrWhiteSpace($baseRow)) { continue }
            $fields = $baseRow -split [regex]::Escape('+|')
            $id = 0
            if ($fields.Count -ne 6 -or $fields[0] -notmatch '^[1-9][0-9]*$' -or
                -not [int]::TryParse($fields[0], [ref]$id) -or -not $seen.Add($id)) {
                throw 'Malformed or duplicate original ProductModel.csv record.'
            }
            if ($id -notin $supplementalIds -or [string]::IsNullOrWhiteSpace($fields[3])) { continue }
            $settings = [System.Xml.XmlReaderSettings]::new()
            $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
            $settings.XmlResolver = $null
            $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($fields[3]), $settings)
            try {
                $document = [System.Xml.XmlDocument]::new()
                $document.XmlResolver = $null
                $document.Load($reader)
            } finally { $reader.Dispose() }
            $namespace = 'http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions'
            if ($document.DocumentElement.LocalName -ne 'root' -or
                $document.DocumentElement.NamespaceURI -ne $namespace -or
                [string]::IsNullOrWhiteSpace($document.DocumentElement.InnerText) -or
                $document.SelectNodes("//*[local-name()='diag']").Count -gt 0) {
                throw "Supplemental model $id must have original manufacturing instructions without diagram references."
            }
            $null = $eligible.Add($id)
        }
        foreach ($id in $supplementalIds) {
            if (-not $eligible.Contains($id)) {
                throw "Supplemental mapping model $id requires nonempty original instructions in ProductModel.csv."
            }
        }
    }
    foreach ($mapping in $mappings) {
        if ($mapping.OtherID -notin $illustrations.ID) {
            throw "Mapping $($mapping.ID)/$($mapping.OtherID) must reference an illustration in this overlay."
        }
    }
    [pscustomobject]@{ Instructions = $instructions; Illustrations = $illustrations; Mappings = $mappings }
}

function Invoke-ManufacturingOverlayCommand {
    param($Connection, $Transaction, [string] $Sql, [hashtable] $Values)

    $command = $Connection.CreateCommand()
    try {
        $command.Transaction = $Transaction
        $command.CommandTimeout = 120
        $command.CommandText = $Sql
        foreach ($name in $Values.Keys) {
            $parameter = $command.CreateParameter()
            $parameter.ParameterName = $name
            $parameter.Value = $Values[$name]
            $parameter.DbType = if ($Values[$name] -is [int]) {
                [System.Data.DbType]::Int32
            } elseif ($Values[$name] -is [datetime]) {
                [System.Data.DbType]::DateTime
            } else {
                [System.Data.DbType]::String
            }
            if ($parameter.DbType -eq [System.Data.DbType]::String) { $parameter.Size = -1 }
            $null = $command.Parameters.Add($parameter)
        }
        $command.ExecuteScalar()
    } finally { $command.Dispose() }
}

function Import-ManufacturingOverlays {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)] $Connection,
        [Parameter(Mandatory)][string] $SqlFolder,
        [switch] $VerifyOnly
    )

    # Parse every artifact before opening a transaction. No arbitrary table/column SQL is accepted.
    $data = Read-ManufacturingOverlays -SqlFolder $SqlFolder
    $artifactHashes = @('ProductModelInstructions-ai.csv', 'Illustration-ai.csv', 'ProductModelIllustration-ai.csv') | ForEach-Object {
        [pscustomobject]@{ File = $_; Sha256 = (Get-FileHash (Join-Path $SqlFolder $_) -Algorithm SHA256).Hash }
    }
    $changed = @{ Instructions = 0; Illustrations = 0; Mappings = 0 }
    $sourceIds = @($data.Instructions | ForEach-Object { $_.ID }) | ConvertTo-Json -Compress -AsArray
    $illustrationIds = @($data.Illustrations | ForEach-Object { $_.ID }) | ConvertTo-Json -Compress -AsArray
    $mappingIds = @($data.Mappings | Select-Object ID, OtherID) | ConvertTo-Json -Compress -AsArray
    $transaction = $Connection.BeginTransaction([System.Data.IsolationLevel]::Serializable)
    try {
        # Snapshot all models, not only overlay IDs, and retain locks through verification/commit.
        $snapshot = Invoke-ManufacturingOverlayCommand $Connection $transaction @'
SELECT (
    SELECT ProductModelID,
        CONVERT(varchar(64), HASHBYTES('SHA2_256', CONVERT(nvarchar(max), Instructions)), 2) AS InstructionsHash
    FROM Production.ProductModel WITH (UPDLOCK, HOLDLOCK)
    ORDER BY ProductModelID
    FOR JSON PATH, INCLUDE_NULL_VALUES
);
'@ @{}
        $phases = if ($VerifyOnly) { @(1) } else { @(0, 1) }
        foreach ($verify in $phases) {
        foreach ($row in $data.Instructions) {
            $count = Invoke-ManufacturingOverlayCommand $Connection $transaction @'
DECLARE @incoming xml(Production.ManuInstructionsSchemaCollection);
SET @incoming = CONVERT(xml, @xml, 0);
IF NOT EXISTS (SELECT 1 FROM Production.ProductModel WITH (UPDLOCK, HOLDLOCK) WHERE ProductModelID = @id)
    THROW 51000, 'Instruction overlay references a missing ProductModel.', 1;
IF EXISTS (
    SELECT 1 FROM Production.ProductModel WHERE ProductModelID = @id AND Instructions IS NOT NULL
    AND CONVERT(varbinary(max), CONVERT(nvarchar(max), Instructions))
        <> CONVERT(varbinary(max), CONVERT(nvarchar(max), @incoming)))
    THROW 51001, 'Instruction conflict: existing non-NULL instructions are protected.', 1;
IF @verify = 1 AND EXISTS (SELECT 1 FROM Production.ProductModel WHERE ProductModelID = @id AND Instructions IS NULL)
    THROW 51005, 'Verification failed: source instructions are missing.', 1;
DECLARE @changed int = 0;
IF @verify = 0
BEGIN
    UPDATE Production.ProductModel SET Instructions = @incoming
    WHERE ProductModelID = @id AND Instructions IS NULL;
    SET @changed = @@ROWCOUNT;
END;
SELECT @changed;
'@ @{ '@id' = $row.ID; '@xml' = $row.Xml; '@verify' = $verify }
            if ($verify -eq 0) { $changed.Instructions += [int]$count }
        }
        foreach ($row in $data.Illustrations) {
            $count = Invoke-ManufacturingOverlayCommand $Connection $transaction @'
DECLARE @incoming xml = CONVERT(xml, @xml, 0), @changed int = 0;
IF EXISTS (SELECT 1 FROM Production.Illustration WITH (UPDLOCK, HOLDLOCK) WHERE IllustrationID = @id)
BEGIN
    IF EXISTS (
        SELECT 1 FROM Production.Illustration WHERE IllustrationID = @id
        AND (Diagram IS NULL OR CONVERT(varbinary(max), CONVERT(nvarchar(max), Diagram))
            <> CONVERT(varbinary(max), CONVERT(nvarchar(max), @incoming))))
        THROW 51002, 'Illustration conflict: existing diagram is protected.', 1;
END
ELSE
BEGIN
    IF @verify = 1
        THROW 51006, 'Verification failed: source illustration is missing.', 1;
    BEGIN TRY
        SET IDENTITY_INSERT Production.Illustration ON;
        INSERT Production.Illustration (IllustrationID, Diagram, ModifiedDate) VALUES (@id, @incoming, @date);
        SET @changed = @@ROWCOUNT;
        SET IDENTITY_INSERT Production.Illustration OFF;
    END TRY
    BEGIN CATCH
        SET IDENTITY_INSERT Production.Illustration OFF;
        THROW;
    END CATCH;
END;
SELECT @changed;
'@ @{ '@id' = $row.ID; '@xml' = $row.Xml; '@date' = $row.ModifiedDate; '@verify' = $verify }
            if ($verify -eq 0) { $changed.Illustrations += [int]$count }
        }
        foreach ($row in $data.Mappings) {
            $count = Invoke-ManufacturingOverlayCommand $Connection $transaction @'
DECLARE @changed int = 0;
IF NOT EXISTS (SELECT 1 FROM Production.ProductModel WITH (UPDLOCK, HOLDLOCK) WHERE ProductModelID = @model)
    OR NOT EXISTS (SELECT 1 FROM Production.Illustration WITH (UPDLOCK, HOLDLOCK) WHERE IllustrationID = @illustration)
    THROW 51003, 'Mapping references a missing model or illustration.', 1;
IF EXISTS (SELECT 1 FROM Production.ProductModelIllustration WITH (UPDLOCK, HOLDLOCK)
    WHERE IllustrationID = @illustration AND ProductModelID <> @model)
    THROW 51004, 'Mapping conflict: illustration already belongs to another model.', 1;
IF NOT EXISTS (SELECT 1 FROM Production.ProductModelIllustration WITH (UPDLOCK, HOLDLOCK)
    WHERE ProductModelID = @model AND IllustrationID = @illustration)
BEGIN
    IF @verify = 1
        THROW 51007, 'Verification failed: source mapping is missing.', 1;
    INSERT Production.ProductModelIllustration (ProductModelID, IllustrationID, ModifiedDate)
    VALUES (@model, @illustration, @date);
    SET @changed = @@ROWCOUNT;
END;
SELECT @changed;
'@ @{ '@model' = $row.ID; '@illustration' = $row.OtherID; '@date' = $row.ModifiedDate; '@verify' = $verify }
            if ($verify -eq 0) { $changed.Mappings += [int]$count }
        }
        }
        $verificationJson = Invoke-ManufacturingOverlayCommand $Connection $transaction @'
DECLARE @before table (ProductModelID int PRIMARY KEY, InstructionsHash varchar(64));
INSERT @before (ProductModelID, InstructionsHash)
SELECT ProductModelID, InstructionsHash
FROM OPENJSON(@snapshot) WITH (ProductModelID int, InstructionsHash varchar(64));
IF (SELECT COUNT(*) FROM @before) <> (SELECT COUNT(*) FROM Production.ProductModel)
    THROW 51008, 'Verification failed: ProductModel count changed.', 1;
IF EXISTS (
    SELECT 1 FROM @before b
    LEFT JOIN Production.ProductModel m ON m.ProductModelID = b.ProductModelID
    WHERE m.ProductModelID IS NULL OR
        ((b.InstructionsHash IS NOT NULL OR NOT EXISTS
            (SELECT 1 FROM OPENJSON(@targets) t WHERE CONVERT(int, t.value) = b.ProductModelID))
         AND ISNULL(b.InstructionsHash, '')
            <> ISNULL(CONVERT(varchar(64), HASHBYTES('SHA2_256', CONVERT(nvarchar(max), m.Instructions)), 2), '')))
    THROW 51009, 'Verification failed: original/non-target instructions changed.', 1;
DECLARE @protected int = (SELECT COUNT(*) FROM @before
WHERE InstructionsHash IS NOT NULL OR NOT EXISTS
    (SELECT 1 FROM OPENJSON(@targets) t WHERE CONVERT(int, t.value) = ProductModelID));
DECLARE @protectedBefore nvarchar(max) = (
    SELECT b.ProductModelID, b.InstructionsHash FROM @before b
    WHERE b.InstructionsHash IS NOT NULL OR NOT EXISTS
        (SELECT 1 FROM OPENJSON(@targets) t WHERE CONVERT(int, t.value) = b.ProductModelID)
    ORDER BY b.ProductModelID FOR JSON PATH, INCLUDE_NULL_VALUES);
DECLARE @protectedAfter nvarchar(max) = (
    SELECT m.ProductModelID,
        CONVERT(varchar(64), HASHBYTES('SHA2_256', CONVERT(nvarchar(max), m.Instructions)), 2) AS InstructionsHash
    FROM @before b JOIN Production.ProductModel m ON m.ProductModelID = b.ProductModelID
    WHERE b.InstructionsHash IS NOT NULL OR NOT EXISTS
        (SELECT 1 FROM OPENJSON(@targets) t WHERE CONVERT(int, t.value) = b.ProductModelID)
    ORDER BY m.ProductModelID FOR JSON PATH, INCLUDE_NULL_VALUES);
DECLARE @instructionsVerified int = (
    SELECT COUNT(*) FROM OPENJSON(@targets) t
    JOIN Production.ProductModel m ON m.ProductModelID = CONVERT(int, t.value)
    WHERE m.Instructions IS NOT NULL);
DECLARE @illustrationsVerified int = (
    SELECT COUNT(*) FROM OPENJSON(@illustrations) t
    JOIN Production.Illustration i ON i.IllustrationID = CONVERT(int, t.value)
    WHERE i.Diagram IS NOT NULL);
DECLARE @mappingsVerified int = (
    SELECT COUNT(*) FROM OPENJSON(@mappings) WITH (ID int, OtherID int) t
    JOIN Production.ProductModelIllustration m ON m.ProductModelID = t.ID AND m.IllustrationID = t.OtherID);
IF @instructionsVerified <> (SELECT COUNT(*) FROM OPENJSON(@targets))
    OR @illustrationsVerified <> (SELECT COUNT(*) FROM OPENJSON(@illustrations))
    OR @mappingsVerified <> (SELECT COUNT(*) FROM OPENJSON(@mappings))
    THROW 51010, 'Verification failed: database source record counts do not match artifacts.', 1;
SELECT (
    SELECT @protected AS ProtectedInstructionSnapshotsVerified,
        CONVERT(varchar(64), HASHBYTES('SHA2_256', @protectedBefore), 2) AS ProtectedInstructionsBeforeSha256,
        CONVERT(varchar(64), HASHBYTES('SHA2_256', @protectedAfter), 2) AS ProtectedInstructionsAfterSha256,
        @instructionsVerified AS InstructionRecordsVerified,
        @illustrationsVerified AS IllustrationRecordsVerified,
        @mappingsVerified AS MappingRecordsVerified
    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
);
'@ @{ '@snapshot' = $snapshot; '@targets' = $sourceIds; '@illustrations' = $illustrationIds; '@mappings' = $mappingIds }
        $verification = $verificationJson | ConvertFrom-Json
        $transaction.Commit()
    } catch {
        # A server-side error (for example a deadlock) may already have rolled back the transaction.
        try { $transaction.Rollback() } catch { Write-Warning "Overlay rollback: $($_.Exception.Message)" }
        throw
    } finally { $transaction.Dispose() }

    [pscustomobject]@{
        Mode = if ($VerifyOnly) { 'VerifyOnly' } else { 'ImportAndVerify' }
        InstructionRecords = $data.Instructions.Count
        IllustrationRecords = $data.Illustrations.Count
        MappingRecords = $data.Mappings.Count
        InstructionsUpdated = $changed.Instructions
        IllustrationsInserted = $changed.Illustrations
        MappingsInserted = $changed.Mappings
        InstructionsUnchanged = $data.Instructions.Count - $changed.Instructions
        IllustrationsUnchanged = $data.Illustrations.Count - $changed.Illustrations
        MappingsUnchanged = $data.Mappings.Count - $changed.Mappings
        ProtectedInstructionSnapshotsVerified = [int]$verification.ProtectedInstructionSnapshotsVerified
        ProtectedInstructionsBeforeSha256 = $verification.ProtectedInstructionsBeforeSha256
        ProtectedInstructionsAfterSha256 = $verification.ProtectedInstructionsAfterSha256
        InstructionRecordsVerified = [int]$verification.InstructionRecordsVerified
        IllustrationRecordsVerified = [int]$verification.IllustrationRecordsVerified
        MappingRecordsVerified = [int]$verification.MappingRecordsVerified
        SourceRecordsVerified = $verification.InstructionRecordsVerified + $verification.IllustrationRecordsVerified + $verification.MappingRecordsVerified
        ProductModelIDs = @($data.Instructions | ForEach-Object { $_.ID })
        IllustrationIDs = @($data.Illustrations | ForEach-Object { $_.ID })
        ArtifactSha256 = $artifactHashes
    }
}

Export-ModuleMember -Function Read-ManufacturingOverlayRows, Read-ManufacturingOverlays, Import-ManufacturingOverlays
