Param(
    [Parameter(Mandatory=$true)][string]$ResourceGroup,
    [Parameter(Mandatory=$true)][string]$AppName
)
# Vaihtoehto Visual Studion Publish-toiminnolle: zip-deploy Azure CLI:llä.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $env:TEMP "thermalanomalies-publish"
$zip = Join-Path $env:TEMP "thermalanomalies-app.zip"

az account show *> $null
if ($LASTEXITCODE -ne 0) { az login | Out-Null }

Remove-Item $stage, $zip -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
foreach ($item in "server.mjs", "server.cjs", "web.config", "package.json", "package-lock.json", "src", "public") {
    Copy-Item (Join-Path $root $item) $stage -Recurse
}

Push-Location $stage
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci epäonnistui" }
} finally { Pop-Location }

Compress-Archive -Path "$stage\*" -DestinationPath $zip
az webapp deploy --resource-group $ResourceGroup --name $AppName --src-path $zip --type zip
if ($LASTEXITCODE -ne 0) { throw "Azure-julkaisu epäonnistui" }

Remove-Item $stage, $zip -Recurse -Force
Write-Host "Valmis: https://$AppName.azurewebsites.net"
