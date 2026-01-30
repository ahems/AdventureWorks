Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# PSScriptAnalyzer SuppressMessage = 'PSUseApprovedVerbs', 'Ensure prefix retained for idempotent helper functions.'

#############################################
# Helpers: PSGallery trust & Module handling
#############################################
# PSScriptAnalyzer SuppressMessage = PSUseApprovedVerbs "Ensure prefix retained for idempotent helper functions."
function Ensure-PsGalleryTrusted {
	try {
		$gallery = Get-PSRepository -Name 'PSGallery' -ErrorAction Stop
		if ($gallery.InstallationPolicy -ne 'Trusted') {
			Write-Host "Setting PSGallery repository to Trusted..." -ForegroundColor DarkCyan
			Set-PSRepository -Name 'PSGallery' -InstallationPolicy Trusted
		}
	} catch {
		Write-Host "Registering PSGallery repository..." -ForegroundColor DarkCyan
		Register-PSRepository -Name 'PSGallery' -SourceLocation 'https://www.powershellgallery.com/api/v2' -InstallationPolicy Trusted
	}
}

# PSScriptAnalyzer SuppressMessage = PSUseApprovedVerbs "Ensure prefix retained for idempotent helper functions."
function Ensure-Module {
	param(
		[Parameter(Mandatory)][string]$Name,
		[string]$MinVersion
	)
	if (-not (Get-Module -ListAvailable -Name $Name)) {
		Write-Host "Installing missing module: $Name" -ForegroundColor Yellow
		$installParams = @{ Name = $Name; Scope = 'CurrentUser'; Force = $true; AllowClobber = $true }
		if ($MinVersion) { $installParams['MinimumVersion'] = $MinVersion }
		Install-Module @installParams | Out-Null
	}
	Import-Module $Name -ErrorAction Stop | Out-Null
}

function Get-AzdValue {
	param(
		[Parameter(Mandatory)][string]$Name,
		[string]$Default=''
	)
	# Capture both stdout & stderr so we can inspect the textual output even if azd returns a non-zero exit code.
	$raw = & azd env get-value $Name 2>&1
	$exit = $LASTEXITCODE
	if (-not $raw) { return $Default }
	# Normalize to single trimmed string (azd may emit trailing newlines)
	$val = ($raw | Out-String).Trim()

	# Detect common azd error patterns. Sometimes ANSI color codes or whitespace precede the word ERROR/error.
	#   - Possible formats observed: "ERROR: key 'XYZ' not found..." or "error: ..."
	#   - With color codes: "\x1b[31mERROR: key 'XYZ' not found ...\x1b[0m"
	#   - Non-zero exit code is also a strong signal the retrieval failed.
	$ansiPattern = '^(?:\x1B\[[0-9;]*m)*'  # optional leading ANSI sequences
	if ($exit -ne 0 -or
		$val -match ("${ansiPattern}\s*(?i:error:)" ) -or
		$val -match ("${ansiPattern}\s*(?i)key '?$Name'?'? not found") -or
		$val -match ("${ansiPattern}\s*(?i)no value found") ) {
		Write-Verbose "azd env key '$Name' not found or retrieval error (exit=$exit); returning default." -Verbose:$false
		return $Default
	}

	return $val
}

function Set-AzdValue {
	param([Parameter(Mandatory)][string]$Name,[Parameter(Mandatory)][string]$Value)
	azd env set $Name $Value | Out-Null
}

#############################################
# Azure AI Foundry Account + Model Selection
#############################################
class Model { [string]$format; [string]$name; [string]$version }

# PSScriptAnalyzer SuppressMessage = PSUseApprovedVerbs "Ensure helper naming aligns with rest of script."
function Ensure-FoundryAccount {
	param([string]$SubId,[string]$Rg,[string]$Acct,[string]$Loc)
	if ([string]::IsNullOrWhiteSpace($Acct)) { throw 'Ensure-FoundryAccount received an empty account name.' }
	$existingAcct = Get-AzCognitiveServicesAccount -Name $Acct -ResourceGroupName $Rg -ErrorAction SilentlyContinue
	if (-not $existingAcct) {
		Write-Host "Creating Microsoft Foundry account '$Acct' in $Loc..." -ForegroundColor Green
		New-AzCognitiveServicesAccount -ResourceGroupName $Rg -Name $Acct -Type 'AIServices' -SkuName 'S0' -Location $Loc -CustomSubDomainName $Acct -Force | Out-Null
	} elseif ($existingAcct.Location -ne $Loc) {
		Write-Warning "Existing account region '$($existingAcct.Location)' differs from requested '$Loc'; proceeding with existing region."
	}
}

function Get-AccountModelsMultiVersion {
	param([string]$SubId,[string]$Rg,[string]$Acct)
	$apiVersion = '2025-07-01-preview'
	$url = "/subscriptions/$SubId/resourceGroups/$Rg/providers/Microsoft.CognitiveServices/accounts/$Acct/models?api-version=$apiVersion"
	try { $resp = Invoke-AzRestMethod -Path $url -Method GET -ErrorAction Stop } catch { Write-Error "Failed to call models endpoint: $($_.Exception.Message)"; return @() }

	$models = @()
	if (-not $resp -or -not $resp.Content) {
		Write-Warning "Empty response when enumerating models."
		return $models
	}

	# Try to parse JSON, but be defensive: structure may change or contain an error payload.
	try {
		$json = $resp.Content | ConvertFrom-Json -ErrorAction Stop
	} catch {
		Write-Warning ("Unable to parse models JSON: {0}. Raw (truncated): {1}" -f $_.Exception.Message, ($resp.Content.Substring(0, [Math]::Min(500, $resp.Content.Length))))
		return $models
	}

	# Determine the collection of model items. Some API shapes return { value = [...] }, others may return an array directly.
	$modelItems = @()
	if ($null -ne $json) {
		$hasValueProp = $false
		if ($json -is [System.Management.Automation.PSObject]) {
			$hasValueProp = $json.PSObject.Properties.Name -contains 'value'
		}
		if ($hasValueProp -and $json.value) {
			$modelItems = $json.value
		} elseif ($json -is [System.Collections.IEnumerable] -and -not ($json -is [string])) {
			# Treat top-level array as models list
			$modelItems = $json
		}
	}

	if (-not $modelItems -or ($modelItems | Measure-Object).Count -eq 0) {
		Write-Warning ("No model entries discovered. Raw (truncated): {0}" -f ($resp.Content.Substring(0, [Math]::Min(500, $resp.Content.Length))))
		return $models
	}

	$excludePattern = '(?i)(realtime|transcribe|audio)'
	foreach ($m in $modelItems) {
		# Be tolerant if expected properties are missing
		if (-not ($m | Get-Member -Name name -ErrorAction SilentlyContinue)) { continue }
		if ($m.name -match $excludePattern) { continue }
		$model = [Model]::new();
		$model.name = $m.name
		if ($m | Get-Member -Name format -ErrorAction SilentlyContinue) { $model.format = $m.format }
		if ($m | Get-Member -Name version -ErrorAction SilentlyContinue) { $model.version = $m.version }
		$models += $model
	}
	return $models
}

function Get-AoaiModelAvailableQuota {
	[CmdletBinding()] param([Parameter(Mandatory)][string]$ResourceGroupName,[Parameter(Mandatory)][string]$AccountName,[Parameter(Mandatory)][string]$ModelName,[Parameter(Mandatory)][string]$ModelVersion,[ValidateSet('OpenAI')][string]$ModelFormat='OpenAI',[string]$Location,[switch]$AllRegions)
	$acct = Get-AzCognitiveServicesAccount -ResourceGroupName $ResourceGroupName -Name $AccountName -ErrorAction Stop
	$subscriptionId = ($acct.Id -split '/')[2]
	if (-not $Location) { $Location = $acct.Location }
	$apiVersion = '2024-10-01'
	function _Encode([string]$v){ [System.Uri]::EscapeDataString($v) }
	$relPath = "/subscriptions/$subscriptionId/providers/Microsoft.CognitiveServices/modelCapacities?api-version=$apiVersion&modelFormat=$(_Encode $ModelFormat)&modelName=$(_Encode $ModelName)&modelVersion=$(_Encode $ModelVersion)"
	$resp = Invoke-AzRestMethod -Method GET -Path $relPath -ErrorAction Stop
	$payload = $resp.Content | ConvertFrom-Json
	if (-not $payload.value){ Write-Warning "No capacity entries returned"; return }
	$rows = if ($AllRegions) { $payload.value } else { $payload.value | Where-Object { $_.location -ieq $Location } }
	if (-not $rows) { return }
	$rows = $rows | Where-Object { $_.properties.skuName -notmatch 'Batch$' } | Where-Object { ([int]$_.properties.availableCapacity) -gt 0 }
	if (-not $rows) { return }
	$rows | ForEach-Object { [pscustomobject]@{ SubscriptionId=$subscriptionId; Location=$_.location; SkuName=$_.properties.skuName; ModelFormat=$_.properties.model.format; ModelName=$_.properties.model.name; ModelVersion=$_.properties.model.version; AvailableCapacity=$_.properties.availableCapacity } } | Sort-Object Location, SkuName
}

#############################################
# MAIN EXECUTION FLOW
#############################################
Ensure-PsGalleryTrusted
Ensure-Module -Name Az.Resources
Ensure-Module -Name Az.CognitiveServices

$subscriptionId = Get-AzdValue -Name 'AZURE_SUBSCRIPTION_ID'

if (-not $subscriptionId) {
	Write-Warning "AZURE_SUBSCRIPTION_ID not found in azd environment. This may be required for model enumeration."
}

# Ensure NAME & OBJECT_ID env vars (user context) using Azure CLI
$nameVal = Get-AzdValue -Name 'NAME'
$objectIdVal = Get-AzdValue -Name 'OBJECT_ID'
if (-not $nameVal -or -not $objectIdVal) {
	Write-Host "Retrieving current user information from Azure CLI..." -ForegroundColor Cyan
	$accountInfo = az account show --query '{name:user.name}' -o json | ConvertFrom-Json
	$nameVal = $accountInfo.name
	$userInfo = az ad signed-in-user show --query '{id:id}' -o json | ConvertFrom-Json
	$objectIdVal = $userInfo.id
	Set-AzdValue -Name 'NAME' -Value $nameVal
	Set-AzdValue -Name 'OBJECT_ID' -Value $objectIdVal
	Write-Host "Persisted NAME and OBJECT_ID to azd env." -ForegroundColor Green
}

# Azure AI Foundry provisioning + model selection (skip if already fully selected)
$existingChatComplete = (Get-AzdValue -Name 'chatGptDeploymentVersion') -and (Get-AzdValue -Name 'chatGptSkuName') -and (Get-AzdValue -Name 'chatGptModelName') -and (Get-AzdValue -Name 'availableChatGptDeploymentCapacity')
$existingEmbComplete  = (Get-AzdValue -Name 'embeddingDeploymentVersion') -and (Get-AzdValue -Name 'embeddingDeploymentSkuName') -and (Get-AzdValue -Name 'embeddingDeploymentModelName') -and (Get-AzdValue -Name 'availableEmbeddingDeploymentCapacity')
$existingImageComplete = (Get-AzdValue -Name 'imageDeploymentVersion') -and (Get-AzdValue -Name 'imageDeploymentSkuName') -and (Get-AzdValue -Name 'imageDeploymentModelName') -and (Get-AzdValue -Name 'imageModelFormat') -and (Get-AzdValue -Name 'availableImageDeploymentCapacity')

if ($existingChatComplete -and $existingEmbComplete -and $existingImageComplete) {
	Write-Host "Model selections already present. Skipping model discovery." -ForegroundColor Yellow
	return
}

# Get cognitive services location (AI Foundry region), with fallback to main Azure location
$cognitiveServicesLocation = Get-AzdValue -Name 'cognitiveservicesLocation'
if (-not $cognitiveServicesLocation) {
	$cognitiveServicesLocation = Get-AzdValue -Name 'AZURE_LOCATION' -Default 'eastus2'
	Set-AzdValue -Name 'cognitiveservicesLocation' -Value $cognitiveServicesLocation
	Write-Host "Set cognitiveservicesLocation = $cognitiveServicesLocation (from AZURE_LOCATION)" -ForegroundColor Cyan
}
$location = $cognitiveServicesLocation

# Persist default Azure location if it was not previously set
if (-not (Get-AzdValue -Name 'AZURE_LOCATION')) {
	Set-AzdValue -Name 'AZURE_LOCATION' -Value $location
	Write-Host "Set default AZURE_LOCATION = $location" -ForegroundColor Cyan
}

# Get SQL database name from azd environment, default to 'todo' if not set
$sqlDatabaseName = (azd env get-value 'SQL_DATABASE_NAME' 2>$null).Trim()
if ($sqlDatabaseName -ceq "ERROR: key 'SQL_DATABASE_NAME' not found in the environment values" -or [string]::IsNullOrWhiteSpace($sqlDatabaseName)) {
    $sqlDatabaseName = 'AdventureWorks'
    Write-Output "SQL_DATABASE_NAME not found in azd environment. Setting default: '$sqlDatabaseName'"
    azd env set 'SQL_DATABASE_NAME' $sqlDatabaseName | Out-Null
}

$resourceGroup = Get-AzdValue -Name 'AZURE_RESOURCE_GROUP'
$envName = Get-AzdValue -Name 'AZURE_ENV_NAME'
if (-not $resourceGroup) {
	if (-not $envName) { throw 'AZURE_RESOURCE_GROUP not set and cannot derive because AZURE_ENV_NAME is missing.' }
	$resourceGroup = "rg-$envName"
	Set-AzdValue -Name 'AZURE_RESOURCE_GROUP' -Value $resourceGroup
	Write-Host "Derived and set AZURE_RESOURCE_GROUP = $resourceGroup" -ForegroundColor Cyan
}

$accountName = Get-AzdValue -Name 'AZURE_OPENAI_ACCOUNT_NAME'
if (-not $accountName) {
	$hash = ([System.BitConverter]::ToString((New-Guid).ToByteArray()) -replace '-','').Substring(0,8).ToLower()
	$accountName = "av-openai-$hash"
	Set-AzdValue -Name 'AZURE_OPENAI_ACCOUNT_NAME' -Value $accountName
	Write-Host "Derived Microsoft Foundry account name: $accountName" -ForegroundColor Cyan
}

Ensure-FoundryAccount -SubId $subscriptionId -Rg $resourceGroup -Acct $accountName -Loc $location

Write-Host "Enumerating models for Microsoft Foundry account '$accountName' in region '$location'..." -ForegroundColor Cyan
$null = if (-not $subscriptionId) { throw 'Subscription id is missing; cannot enumerate models. Ensure you are logged in (Connect-AzAccount) and that a subscription is selected (Set-AzContext).' }
$models = Get-AccountModelsMultiVersion -SubId $subscriptionId -Rg $resourceGroup -Acct $accountName
if (-not $models -or $models.Count -eq 0) { throw 'No models returned from Microsoft Foundry account; aborting preup hook.' }

# Filter to OpenAI-format models (includes GPT, DALL-E, embeddings, and other Foundry models)
$originalModelCount = $models.Count
$models = $models | Where-Object { 
	[string]::IsNullOrWhiteSpace($_.format) -or 
	$_.format -ieq 'OpenAI'
}
if ($models.Count -lt $originalModelCount) {
	$skippedCount = $originalModelCount - $models.Count
	Write-Host ("Filtered models: using {0} OpenAI models out of {1} total (skipped {2} non-OpenAI)." -f $models.Count, $originalModelCount, $skippedCount) -ForegroundColor DarkGray
}

# Get quota for each model (parallel when possible)
$allQuota = @()
$pwshSupportsParallel = $false
try {
	$feParams = (Get-Command ForEach-Object).Parameters
	if ($PSVersionTable.PSVersion.Major -ge 7 -and $feParams.ContainsKey('Parallel')) { $pwshSupportsParallel = $true }
} catch { }
$throttle = [int]([Environment]::GetEnvironmentVariable('AOAI_QUOTA_DOP'))
if (-not $throttle -or $throttle -lt 1) { $throttle = 8 }

if ($pwshSupportsParallel) {
	Write-Host ("Retrieving quota in parallel (ThrottleLimit={0})..." -f $throttle) -ForegroundColor DarkGreen
	# Pre-fetch account once to avoid doing it per parallel task
	try {
		$acctObj = Get-AzCognitiveServicesAccount -ResourceGroupName $resourceGroup -Name $accountName -ErrorAction Stop
	} catch {
		Write-Warning "Failed to retrieve Cognitive Services account for quota lookups: $($_.Exception.Message). Falling back to sequential mode."
		$pwshSupportsParallel = $false
	}
	if ($pwshSupportsParallel) {
		$acctSubId = ($acctObj.Id -split '/')[2]
		$acctLoc   = $acctObj.Location
		$apiVersionCap = '2024-10-01'
		$quotas = $models | ForEach-Object -Parallel {
			$fmt = if ([string]::IsNullOrWhiteSpace($_.format)) { 'OpenAI' } else { $_.format }
			try {

				function _Encode([string]$v){ [System.Uri]::EscapeDataString($v) }
				$relPath = "/subscriptions/$($using:acctSubId)/providers/Microsoft.CognitiveServices/modelCapacities?api-version=$($using:apiVersionCap)&modelFormat=$(_Encode $fmt)&modelName=$(_Encode $_.name)&modelVersion=$(_Encode $_.version)"
				$resp = Invoke-AzRestMethod -Method GET -Path $relPath -ErrorAction Stop
				$payload = $resp.Content | ConvertFrom-Json
				if (-not $payload.value) { return }
				$rows = $payload.value | Where-Object { $_.location -ieq $using:acctLoc }
				if (-not $rows) { return }
				$rows = $rows | Where-Object { $_.properties.skuName -notmatch 'Batch$' } | Where-Object { ([int]$_.properties.availableCapacity) -gt 0 }
				if (-not $rows) { return }
				$rows | ForEach-Object { [pscustomobject]@{ SubscriptionId=$using:acctSubId; Location=$_.location; SkuName=$_.properties.skuName; ModelFormat=$_.properties.model.format; ModelName=$_.properties.model.name; ModelVersion=$_.properties.model.version; AvailableCapacity=$_.properties.availableCapacity } } | Sort-Object Location, SkuName
			} catch {
				Write-Warning "Failed quota retrieval for Model $($_.name) v $($_.version): $($_.Exception.Message)"
			}
		} -ThrottleLimit $throttle
		foreach ($q in $quotas) { if ($q) { $allQuota += $q } }
	}
} else {
	Write-Host "Parallel quota retrieval not supported in this PowerShell version; running sequentially." -ForegroundColor Yellow
	$total = $models.Count
	$i = 0
	foreach ($m in $models) {
		$i++
		$fmt = if ([string]::IsNullOrWhiteSpace($m.format)) { 'OpenAI' } else { $m.format }
		try {

			$quota = Get-AoaiModelAvailableQuota -ResourceGroupName $resourceGroup -AccountName $accountName -ModelName $m.name -ModelVersion $m.version -ModelFormat $fmt -ErrorAction Stop
			if ($quota) { $allQuota += $quota }
		} catch {
			Write-Warning "Failed quota retrieval for Model $($m.name), version $($m.version): $($_.Exception.Message)"
		}
	}
}

if (-not $allQuota -or $allQuota.Count -eq 0) { Write-Warning 'No quota data collected.'; return }

Write-Host "Sorting quota results..." -ForegroundColor DarkGreen
$sorted = $allQuota | Sort-Object -Property @{Expression={ [int]$_.AvailableCapacity }; Descending=$true}, @{Expression={$_.ModelVersion}; Descending=$true}

# Select chat model with preference for 'mini' models, then exclude 'nano', then any available
$chatPick = $sorted | Where-Object { $_.ModelName -match '(?i)mini' } | Select-Object -First 1
if (-not $chatPick) {
	$chatPick = $sorted | Where-Object { $_.ModelName -notmatch '(?i)nano' } | Select-Object -First 1
}
if (-not $chatPick) {
	$chatPick = $sorted | Select-Object -First 1
}
if ($chatPick) {
	Set-AzdValue -Name 'chatGptDeploymentVersion' -Value $chatPick.ModelVersion
	Set-AzdValue -Name 'chatGptSkuName' -Value $chatPick.SkuName
	Set-AzdValue -Name 'chatGptModelName' -Value $chatPick.ModelName
	Set-AzdValue -Name 'availableChatGptDeploymentCapacity' -Value ($chatPick.AvailableCapacity.ToString())
	Write-Host "Selected Chat model: $($chatPick.ModelName) $($chatPick.ModelVersion) SKU $($chatPick.SkuName) Capacity $($chatPick.AvailableCapacity)" -ForegroundColor Green
} else { Write-Warning 'No chat model selected.' }

# Select embedding model with preference for 'small' models, then any available
$embeddingCandidates = $sorted | Where-Object { $_.ModelName -like '*embedding*' }
$embeddingPick = $embeddingCandidates | Where-Object { $_.ModelName -match '(?i)small' } | Select-Object -First 1
if (-not $embeddingPick) {
	$embeddingPick = $embeddingCandidates | Select-Object -First 1
}
if ($embeddingPick) {
	Set-AzdValue -Name 'embeddingDeploymentVersion' -Value $embeddingPick.ModelVersion
	Set-AzdValue -Name 'embeddingDeploymentSkuName' -Value $embeddingPick.SkuName
	Set-AzdValue -Name 'embeddingDeploymentModelName' -Value $embeddingPick.ModelName
	Set-AzdValue -Name 'availableEmbeddingDeploymentCapacity' -Value ($embeddingPick.AvailableCapacity.ToString())
	Write-Host "Selected Embeddings model: $($embeddingPick.ModelName) $($embeddingPick.ModelVersion) SKU $($embeddingPick.SkuName) Capacity $($embeddingPick.AvailableCapacity)" -ForegroundColor Green
} else { Write-Warning 'No embeddings model selected.' }

# Select image generation model (specifically filter for gpt-image-1)
$imageCandidates = $sorted | Where-Object { $_.ModelName -match '(?i)^gpt-?image-?1$' }
$imagePick = $imageCandidates | Select-Object -First 1

if ($imagePick) {
	Set-AzdValue -Name 'imageDeploymentVersion' -Value $imagePick.ModelVersion
	Set-AzdValue -Name 'imageDeploymentSkuName' -Value $imagePick.SkuName
	Set-AzdValue -Name 'imageDeploymentModelName' -Value 'gpt-image-1'
	Set-AzdValue -Name 'imageModelFormat' -Value $imagePick.ModelFormat
	Set-AzdValue -Name 'availableImageDeploymentCapacity' -Value ($imagePick.AvailableCapacity.ToString())
	Write-Host "Selected Image model: gpt-image-1 $($imagePick.ModelVersion) SKU $($imagePick.SkuName) Format $($imagePick.ModelFormat) Capacity $($imagePick.AvailableCapacity)" -ForegroundColor Green
} else { Write-Warning 'No gpt-image-1 model available in Azure catalog for this region. Bicep will skip image model deployment.' }

Write-Host "preup.ps1 completed." -ForegroundColor Cyan

