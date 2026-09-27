[CmdletBinding()]
param(
  [string]$Version = "0.1.0-alpha.2",
  [string]$AppName = "YuhuaWriter"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$sevenZip = "C:\Program Files\7-Zip\7z.exe"
if (-not (Test-Path -LiteralPath $sevenZip)) {
  throw "7-Zip was not found at $sevenZip. Install 7-Zip or update this script with the local path."
}

Write-Host "Building the NSIS installer (the default Windows target)..."
Push-Location $root
try {
  cmd /c "pnpm exec tauri build --bundles nsis"
  if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$releaseDir = Join-Path $root "target\release"
$appExe = Join-Path $releaseDir "yuhua-writer.exe"
if (-not (Test-Path -LiteralPath $appExe)) { throw "Built application was not found: $appExe" }

$outDir = Join-Path $releaseDir "bundle\portable"
$stage = Join-Path $outDir "$AppName`_$Version`_portable"
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage "extensions") | Out-Null
Copy-Item -LiteralPath $appExe -Destination (Join-Path $stage "$AppName.exe") -Force
Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination (Join-Path $stage "LICENSE") -Force
@"
$AppName $Version portable package

Run `$AppName.exe` directly. This is a directory-based portable package, not a single-file self-extracting executable.
The `extensions` directory is reserved for future optional integrations and assets.
For the normal install experience, use the NSIS installer in ..\nsis.
"@ | Set-Content -LiteralPath (Join-Path $stage "README.txt") -Encoding utf8
@"
This directory is intentionally kept as a separate extension point.
Future optional integrations may place their files here without changing the main executable.
"@ | Set-Content -LiteralPath (Join-Path $stage "extensions\README.txt") -Encoding utf8

$base = Join-Path $outDir "$AppName`_$Version`_portable"
$archive7z = "$base.7z"
$archiveZip = "$base.zip"
Remove-Item -LiteralPath $archive7z,$archiveZip -Force -ErrorAction SilentlyContinue
& $sevenZip a -t7z -mx=9 $archive7z $stage
if ($LASTEXITCODE -ne 0) { throw "7-Zip .7z packaging failed with exit code $LASTEXITCODE." }
& $sevenZip a -tzip -mx=9 $archiveZip $stage
if ($LASTEXITCODE -ne 0) { throw "7-Zip .zip packaging failed with exit code $LASTEXITCODE." }

Write-Host "Created directory-based packages:"
Write-Host "  $archive7z"
Write-Host "  $archiveZip"
