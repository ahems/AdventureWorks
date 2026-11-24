$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot '../SeedDataFiles.psm1') -Force

function Assert($Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

$seedDataFilesModule = Get-Module SeedDataFiles
Assert ((& $seedDataFilesModule { Get-SeedStageSelectExpression @{ Name = 'Demographics'; Type = 'xml' } }) -ceq 'CAST(NULL AS xml) AS [Demographics]') `
    'XML staging columns use untyped XML so tempdb does not require the target schema collection'
Assert ((& $seedDataFilesModule { Get-SeedStageSelectExpression @{ Name = 'Embedding'; Type = 'vector' } }) -ceq 'CAST(NULL AS nvarchar(max)) AS [Embedding]') `
    'Vector staging columns use text compatible with bulk copy'
Assert ((& $seedDataFilesModule { Get-SeedStageSelectExpression @{ Name = 'Name'; Type = 'nvarchar' } }) -ceq '[Name]') `
    'Ordinary staging columns retain their target type'

function Write-Gzip([string] $Path, [byte[]] $Bytes) {
    $file = [System.IO.File]::Create($Path)
    try {
        $gzip = [System.IO.Compression.GZipStream]::new($file, [System.IO.Compression.CompressionLevel]::Optimal)
        try { $gzip.Write($Bytes, 0, $Bytes.Length) } finally { $gzip.Dispose() }
    }
    finally { $file.Dispose() }
}

$folder = Join-Path ([System.IO.Path]::GetTempPath()) ("seed-data-files-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder | Out-Null
try {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $content = "1`tCafé`t[0.1,0.2]`r`n2`tÜber`t[0.3,0.4]`r`n"

    Assert ($null -eq (Resolve-SeedDataFile -Folder $folder -FileName 'Missing.csv')) 'Missing file resolves to null'

    Write-Gzip (Join-Path $folder 'Data.csv.gz') $utf8.GetBytes($content)
    $resolved = Resolve-SeedDataFile -Folder $folder -FileName 'Data.csv'
    Assert ($resolved -like '*Data.csv.gz') 'Logical .csv name resolves to the .csv.gz file'
    Assert ((Read-SeedDataText -Path $resolved) -ceq $content) 'Gzip content decodes to the original UTF-8 text'

    [System.IO.File]::WriteAllText((Join-Path $folder 'Data.csv'), 'plain', $utf8)
    Assert ((Resolve-SeedDataFile -Folder $folder -FileName 'Data.csv') -like '*Data.csv') 'Plain file takes precedence'

    $unicode = [System.Text.UnicodeEncoding]::new($false, $true)
    $bom = $unicode.GetPreamble() + $unicode.GetBytes($content)
    Write-Gzip (Join-Path $folder 'Wide.csv.gz') $bom
    Assert ((Read-SeedDataText -Path (Join-Path $folder 'Wide.csv.gz') -Encoding $unicode) -ceq $content) 'UTF-16 gzip content honours the BOM'

    # An un-pulled LFS object keeps the .gz name but contains a text pointer, not gzip data.
    $pointer = "version https://git-lfs.github.com/spec/v1`noid sha256:abc`nsize 123`n"
    [System.IO.File]::WriteAllText((Join-Path $folder 'Pointer.csv.gz'), $pointer, $utf8)
    $pointerText = Read-SeedDataText -Path (Resolve-SeedDataFile -Folder $folder -FileName 'Pointer.csv')
    Assert (Test-GitLfsPointerText $pointerText) 'LFS pointer named .csv.gz is detected'
    Assert (-not (Test-GitLfsPointerText $content)) 'Real CSV content is not treated as a pointer'
}
finally {
    Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output 'Seed data file tests passed.'
