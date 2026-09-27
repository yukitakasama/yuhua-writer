[CmdletBinding()]
param(
  [string]$Version = "0.1.0-alpha.2"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$iscc = "C:\Users\yuki\AppData\Local\Programs\Inno Setup 6\ISCC.exe"
if (-not (Test-Path -LiteralPath $iscc)) {
  throw "Inno Setup Compiler was not found at $iscc."
}

Write-Host "Building the application without Tauri bundlers..."
Push-Location $root
try {
  cmd /c "pnpm exec tauri build --no-bundle"
  if ($LASTEXITCODE -ne 0) { throw "Application build failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$outDir = Join-Path $root "target\release\bundle\inno"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
& $iscc "/DAppVersion=$Version" "/DOutputDir=$outDir" (Join-Path $root "scripts\yuhua-writer.iss")
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE." }

Write-Host "Created Inno Setup installer in $outDir"
