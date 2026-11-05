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

function Read-ManufacturingDocumentOverlays {
    param([Parameter(Mandatory)][string] $SqlFolder)

    $documentPath = Join-Path $SqlFolder 'Document-ai.csv'
    $linkPath = Join-Path $SqlFolder 'ProductDocument-ai.csv'
    $hasDocuments = Test-Path -LiteralPath $documentPath
    if ($hasDocuments -ne (Test-Path -LiteralPath $linkPath)) {
        throw 'Document-ai.csv and ProductDocument-ai.csv must be shipped together.'
    }
    if (-not $hasDocuments) { return [pscustomobject]@{ Documents = @(); ProductDocuments = @() } }
    $formats = [string[]]@('yyyy-MM-dd HH:mm:ss.FFFFFFF', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-ddTHH:mm:ss.FFFFFFF', 'yyyy-MM-ddTHH:mm:ss')
    function ConvertTo-OverlayDate([string] $Value, [string] $Path) {
        $date = [datetime]::MinValue
        if (-not [datetime]::TryParseExact($Value, $formats, [cultureinfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::None, [ref]$date) -or $date -lt [datetime]'1753-01-01') {
            throw "Invalid SQL datetime in $Path"
        }
        $date
    }

    $text = [System.IO.File]::ReadAllText($documentPath, [System.Text.UTF8Encoding]::new($false, $true))
    if ($text -match '^\s*version https://git-lfs.github.com') { throw "Overlay is a Git LFS pointer: $documentPath" }
    if ([string]::IsNullOrWhiteSpace($text) -or $text.TrimEnd() -notmatch '&\|$') { throw "Missing &| record terminator: $documentPath" }
    $documents = [System.Collections.Generic.List[object]]::new()
    $paths = [System.Collections.Generic.HashSet[string]]::new()
    $guids = [System.Collections.Generic.HashSet[guid]]::new()
    foreach ($row in ($text -split '&\|(?:\r?\n)?')) {
        if ([string]::IsNullOrWhiteSpace($row)) { continue }
        $f = $row -split [regex]::Escape('+|')
        if ($f.Count -ne 13) { throw "Expected 13 columns in $documentPath" }
        if ($f[0] -notmatch '^/900000/(?:[1-9][0-9]{0,4}/)?$') { throw "Document node must be under /900000/ in $documentPath" }
        $folder = $f[0] -eq '/900000/'
        $owner = 0; $changeNumber = 0; $status = 0; $rowGuid = [guid]::Empty
        if ($f[3] -ne ([int]$folder).ToString() -or
            -not [int]::TryParse($f[2], [ref]$owner) -or $owner -lt 1 -or
            $f[1].Length -lt 1 -or $f[1].Length -gt 50 -or $f[4].Length -lt 1 -or $f[4].Length -gt 400 -or
            $f[5].Length -gt 8 -or ($folder -and $f[5] -ne '') -or (-not $folder -and $f[5] -ne '.xml') -or
            $f[6] -notmatch '^[0-9A-Za-z.]{1,5}$' -or
            -not [int]::TryParse($f[7], [ref]$changeNumber) -or $changeNumber -lt 0 -or
            -not [int]::TryParse($f[8], [ref]$status) -or $status -lt 1 -or $status -gt 3 -or
            -not [guid]::TryParse($f[11], [ref]$rowGuid)) {
            throw "Invalid document metadata for $($f[0]) in $documentPath"
        }
        if (-not $paths.Add($f[0]) -or -not $guids.Add($rowGuid)) { throw "Duplicate document node or rowguid $($f[0]) in $documentPath" }
        if ($folder -and $f[10] -ne '') { throw 'The generated document folder cannot contain document content.' }
        if (-not $folder) {
            $settings = [System.Xml.XmlReaderSettings]::new()
            $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
            $settings.XmlResolver = $null
            $reader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($f[10]), $settings)
            try {
                $xml = [System.Xml.XmlDocument]::new()
                $xml.XmlResolver = $null
                $xml.Load($reader)
            } finally { $reader.Dispose() }
            if ($xml.DocumentElement.LocalName -ne 'root' -or $xml.DocumentElement.NamespaceURI -ne
                'http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions') {
                throw "Document $($f[0]) must contain manufacturing instruction XML."
            }
        }
        $documents.Add([pscustomobject]@{
            Path = $f[0]; Title = $f[1]; Owner = $owner; FolderFlag = [int]$folder; FileName = $f[4]; FileExtension = $f[5]
            Revision = $f[6]; ChangeNumber = $changeNumber; Status = $status
            Summary = $f[9]; Xml = $f[10]; RowGuid = $rowGuid.ToString(); ModifiedDate = (ConvertTo-OverlayDate $f[12] $documentPath)
        })
    }
    if (-not $paths.Contains('/900000/')) { throw 'Document-ai.csv must define the /900000/ generated document folder.' }

    $linkText = [System.IO.File]::ReadAllText($linkPath, [System.Text.UTF8Encoding]::new($false, $true))
    if ($linkText -match '^\s*version https://git-lfs.github.com') { throw "Overlay is a Git LFS pointer: $linkPath" }
    $links = [System.Collections.Generic.List[object]]::new()
    $linked = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($row in ($linkText -split '\r?\n')) {
        if ([string]::IsNullOrWhiteSpace($row)) { continue }
        $f = $row -split "`t"
        $productId = 0
        if ($f.Count -ne 3 -or $f[0] -notmatch '^[1-9][0-9]{0,4}$' -or -not [int]::TryParse($f[0], [ref]$productId)) {
            throw "Invalid product document link in $linkPath"
        }
        if ($f[1] -ne "/900000/$productId/" -or -not $paths.Contains($f[1])) {
            throw "Product document link $productId must reference its own generated sheet."
        }
        if (-not $linked.Add($f[1])) { throw "Duplicate product document link $($f[1]) in $linkPath" }
        $links.Add([pscustomobject]@{ ProductID = $productId; Path = $f[1]; ModifiedDate = (ConvertTo-OverlayDate $f[2] $linkPath) })
    }
    foreach ($document in $documents) {
        if ($document.FolderFlag -eq 0 -and -not $linked.Contains($document.Path)) {
            throw "Generated document $($document.Path) has no product link."
        }
    }
    [pscustomobject]@{
        Documents = @($documents | Sort-Object { $_.Path.Length }, Path)
        ProductDocuments = @($links | Sort-Object ProductID)
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
    $documentData = Read-ManufacturingDocumentOverlays -SqlFolder $SqlFolder
    $partDiagrams = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($link in $documentData.ProductDocuments) {
        $sheet = 2000000 + $link.ProductID * 10
        $owned = @($illustrations | Where-Object { $_.ID -gt $sheet -and $_.ID -le $sheet + 3 })
        $xml = ($documentData.Documents | Where-Object { $_.Path -eq $link.Path }).Xml
        foreach ($match in [regex]::Matches($xml, '<diag>\s*([0-9]+)\s*</diag>')) {
            $diagram = [int]$match.Groups[1].Value
            if ($diagram -notin $owned.ID) {
                throw "Part sheet $($link.Path) references an illustration absent from this overlay."
            }
            $null = $partDiagrams.Add($diagram)
        }
    }
    foreach ($illustration in $illustrations) {
        if ($illustration.ID -ge 2000000 -and -not $partDiagrams.Contains($illustration.ID)) {
            throw "Part illustration $($illustration.ID) is not referenced by a generated part sheet."
        }
        if ($illustration.ID -lt 2000000 -and $illustration.ID -notin $mappings.OtherID) {
            throw "Model illustration $($illustration.ID) has no model mapping."
        }
    }
    [pscustomobject]@{
        Instructions = $instructions; Illustrations = $illustrations; Mappings = $mappings
        Documents = $documentData.Documents; ProductDocuments = $documentData.ProductDocuments
    }
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
            $parameter.DbType = if ($Values[$name] -is [byte[]]) {
                [System.Data.DbType]::Binary
            } elseif ($Values[$name] -is [int]) {
                [System.Data.DbType]::Int32
            } elseif ($Values[$name] -is [datetime]) {
                [System.Data.DbType]::DateTime
            } else {
                [System.Data.DbType]::String
            }
            if ($parameter.DbType -in @([System.Data.DbType]::String, [System.Data.DbType]::Binary)) { $parameter.Size = -1 }
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
    $artifactFiles = @('ProductModelInstructions-ai.csv', 'Illustration-ai.csv', 'ProductModelIllustration-ai.csv')
    if ($data.Documents.Count -gt 0) { $artifactFiles += @('Document-ai.csv', 'ProductDocument-ai.csv') }
    $artifactHashes = $artifactFiles | ForEach-Object {
        [pscustomobject]@{ File = $_; Sha256 = (Get-FileHash (Join-Path $SqlFolder $_) -Algorithm SHA256).Hash }
    }
    $changed = @{ Instructions = 0; Illustrations = 0; Mappings = 0; Documents = 0; ProductDocuments = 0 }
    $documentPaths = ConvertTo-Json -Compress -InputObject @($data.Documents | ForEach-Object { $_.Path })
    $productDocumentIds = ConvertTo-Json -Compress -InputObject @($data.ProductDocuments | Select-Object ProductID, Path)
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
        foreach ($row in $data.Documents) {
            $content = [System.Text.UTF8Encoding]::new($false).GetBytes($row.Xml)
            $count = Invoke-ManufacturingOverlayCommand $Connection $transaction @'
DECLARE @node hierarchyid = hierarchyid::Parse(@path), @changed int = 0;
DECLARE @document varbinary(max) = CASE WHEN @folder = 1 THEN NULL ELSE @content END;
IF @folder = 0
BEGIN
    DECLARE @typed xml(Production.ManuInstructionsSchemaCollection);
    SET @typed = CONVERT(xml, @xml, 0);
END;
IF EXISTS (SELECT 1 FROM Production.Document WITH (UPDLOCK, HOLDLOCK) WHERE DocumentNode = @node)
BEGIN
    IF NOT EXISTS (SELECT 1 FROM Production.Document WHERE DocumentNode = @node AND FolderFlag = @folder AND Title = @title
        AND ISNULL(CONVERT(varchar(64), HASHBYTES('SHA2_256', Document), 2), '')
            = ISNULL(CONVERT(varchar(64), HASHBYTES('SHA2_256', @document), 2), ''))
        THROW 51011, 'Document conflict: existing document is protected.', 1;
END
ELSE
BEGIN
    IF @verify = 1
        THROW 51012, 'Verification failed: source document is missing.', 1;
    IF NOT EXISTS (SELECT 1 FROM Production.Document WITH (UPDLOCK, HOLDLOCK)
        WHERE DocumentNode = @node.GetAncestor(1) AND FolderFlag = 1)
        THROW 51013, 'Document parent folder is missing.', 1;
    INSERT Production.Document (DocumentNode, Title, Owner, FolderFlag, FileName, FileExtension, Revision,
        ChangeNumber, Status, DocumentSummary, Document, rowguid, ModifiedDate)
    VALUES (@node, @title, @owner, @folder, @fileName, @extension, @revision, @changeNumber, @status,
        NULLIF(@summary, N''), @document, CONVERT(uniqueidentifier, @rowguid), @date);
    SET @changed = @@ROWCOUNT;
END;
SELECT @changed;
'@ @{ '@path' = $row.Path; '@title' = $row.Title; '@owner' = $row.Owner; '@folder' = $row.FolderFlag
                '@fileName' = $row.FileName; '@extension' = $row.FileExtension; '@revision' = $row.Revision
                '@changeNumber' = $row.ChangeNumber; '@status' = $row.Status; '@summary' = $row.Summary
                '@xml' = $row.Xml; '@content' = $content; '@rowguid' = $row.RowGuid; '@date' = $row.ModifiedDate
                '@verify' = $verify }
            if ($verify -eq 0) { $changed.Documents += [int]$count }
        }
        foreach ($row in $data.ProductDocuments) {
            $count = Invoke-ManufacturingOverlayCommand $Connection $transaction @'
DECLARE @node hierarchyid = hierarchyid::Parse(@path), @changed int = 0;
IF NOT EXISTS (SELECT 1 FROM Production.Product WITH (UPDLOCK, HOLDLOCK) WHERE ProductID = @product)
    OR NOT EXISTS (SELECT 1 FROM Production.Document WITH (UPDLOCK, HOLDLOCK) WHERE DocumentNode = @node AND FolderFlag = 0)
    THROW 51014, 'Product document link references a missing product or document.', 1;
IF NOT EXISTS (SELECT 1 FROM Production.ProductDocument WITH (UPDLOCK, HOLDLOCK)
    WHERE ProductID = @product AND DocumentNode = @node)
BEGIN
    IF @verify = 1
        THROW 51015, 'Verification failed: source product document link is missing.', 1;
    INSERT Production.ProductDocument (ProductID, DocumentNode, ModifiedDate) VALUES (@product, @node, @date);
    SET @changed = @@ROWCOUNT;
END;
SELECT @changed;
'@ @{ '@product' = $row.ProductID; '@path' = $row.Path; '@date' = $row.ModifiedDate; '@verify' = $verify }
            if ($verify -eq 0) { $changed.ProductDocuments += [int]$count }
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
DECLARE @documentsVerified int = (
    SELECT COUNT(*) FROM OPENJSON(@documents) t
    JOIN Production.Document d ON d.DocumentNode = hierarchyid::Parse(CONVERT(nvarchar(4000), t.value)));
DECLARE @productDocumentsVerified int = (
    SELECT COUNT(*) FROM OPENJSON(@productDocuments) WITH (ProductID int, Path nvarchar(4000)) t
    JOIN Production.ProductDocument pd ON pd.ProductID = t.ProductID AND pd.DocumentNode = hierarchyid::Parse(t.Path));
IF @instructionsVerified <> (SELECT COUNT(*) FROM OPENJSON(@targets))
    OR @illustrationsVerified <> (SELECT COUNT(*) FROM OPENJSON(@illustrations))
    OR @mappingsVerified <> (SELECT COUNT(*) FROM OPENJSON(@mappings))
    OR @documentsVerified <> (SELECT COUNT(*) FROM OPENJSON(@documents))
    OR @productDocumentsVerified <> (SELECT COUNT(*) FROM OPENJSON(@productDocuments))
    THROW 51010, 'Verification failed: database source record counts do not match artifacts.', 1;
SELECT (
    SELECT @protected AS ProtectedInstructionSnapshotsVerified,
        CONVERT(varchar(64), HASHBYTES('SHA2_256', @protectedBefore), 2) AS ProtectedInstructionsBeforeSha256,
        CONVERT(varchar(64), HASHBYTES('SHA2_256', @protectedAfter), 2) AS ProtectedInstructionsAfterSha256,
        @instructionsVerified AS InstructionRecordsVerified,
        @illustrationsVerified AS IllustrationRecordsVerified,
        @mappingsVerified AS MappingRecordsVerified,
        @documentsVerified AS DocumentRecordsVerified,
        @productDocumentsVerified AS ProductDocumentRecordsVerified
    FOR JSON PATH, WITHOUT_ARRAY_WRAPPER
);
'@ @{ '@snapshot' = $snapshot; '@targets' = $sourceIds; '@illustrations' = $illustrationIds; '@mappings' = $mappingIds; '@documents' = $documentPaths; '@productDocuments' = $productDocumentIds }
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
        DocumentRecords = $data.Documents.Count
        ProductDocumentRecords = $data.ProductDocuments.Count
        DocumentsInserted = $changed.Documents
        ProductDocumentsInserted = $changed.ProductDocuments
        DocumentsUnchanged = $data.Documents.Count - $changed.Documents
        ProductDocumentsUnchanged = $data.ProductDocuments.Count - $changed.ProductDocuments
        DocumentRecordsVerified = [int]$verification.DocumentRecordsVerified
        ProductDocumentRecordsVerified = [int]$verification.ProductDocumentRecordsVerified
        SourceRecordsVerified = $verification.InstructionRecordsVerified + $verification.IllustrationRecordsVerified +
            $verification.MappingRecordsVerified + $verification.DocumentRecordsVerified + $verification.ProductDocumentRecordsVerified
        ProductModelIDs = @($data.Instructions | ForEach-Object { $_.ID })
        IllustrationIDs = @($data.Illustrations | ForEach-Object { $_.ID })
        ArtifactSha256 = $artifactHashes
    }
}

Export-ModuleMember -Function Read-ManufacturingOverlayRows, Read-ManufacturingDocumentOverlays, Read-ManufacturingOverlays, Import-ManufacturingOverlays
