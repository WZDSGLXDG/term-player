# Build a clean, distributable zip of term-player.
#   powershell -ExecutionPolicy Bypass -File pack-release.ps1
# Includes: player.js lib\ test\ play.cmd install-tp.cmd README.md
# Excludes: config.json (user data: music dir + play progress), meta-cache.json (local ffprobe cache)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ver = (Get-Date).ToString('yyyyMMdd')
$stage = Join-Path $env:TEMP "tp-release-$ver"
$dist = Join-Path $root 'dist'
$zip = Join-Path $dist "term-player-$ver.zip"

if (-not (Test-Path (Join-Path $root 'player.js'))) { throw "player.js not found next to pack-release.ps1" }

if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory (Join-Path $stage 'term-player') | Out-Null
$dest = Join-Path $stage 'term-player'

Copy-Item (Join-Path $root 'player.js') $dest
Copy-Item (Join-Path $root 'play.cmd') $dest
Copy-Item (Join-Path $root 'install-tp.cmd') $dest
Copy-Item (Join-Path $root 'README.md') $dest
foreach ($d in 'lib', 'test') { Copy-Item (Join-Path $root $d) (Join-Path $dest $d) -Recurse }
foreach ($junk in 'config.json', 'meta-cache.json', 'config.json.tmp', 'meta-cache.json.tmp') {
  $p = Join-Path $dest $junk
  if (Test-Path $p) { Remove-Item -LiteralPath $p -Force }
}

if (-not (Test-Path $dist)) { New-Item -ItemType Directory $dist | Out-Null }
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path $dest -DestinationPath $zip -CompressionLevel Optimal

$files = Get-ChildItem -Path $dest -Recurse -File
$sum = (Get-FileHash $zip -Algorithm SHA256).Hash
Write-Host ""
Write-Host ("packaged: {0}" -f $zip)
Write-Host ("  files   : {0}" -f $files.Count)
Write-Host ("  raw     : {0:N1} KB" -f (($files | Measure-Object Length -Sum).Sum / 1KB))
Write-Host ("  zip     : {0:N1} KB" -f ((Get-Item $zip).Length / 1KB))
Write-Host ("  sha256  : {0}" -f $sum)
Write-Host ""
Write-Host "contents:"
$files | ForEach-Object { Write-Host ("  {0,-28} {1,7} B" -f $_.FullName.Substring($dest.Length + 1), $_.Length) }

Remove-Item -LiteralPath $stage -Recurse -Force
