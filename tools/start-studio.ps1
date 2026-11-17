param(
  [Parameter(Mandatory=$true)][string]$RunRoot,
  [int]$Port = 8767
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedRun = (Resolve-Path -LiteralPath $RunRoot).Path
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Output "Port $Port is already in use. Existing process left running. Try http://127.0.0.1:$Port or choose another -Port."
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist-studio/index.html'))) {
  Push-Location -LiteralPath $repoRoot
  try { & pnpm.cmd studio:build; if ($LASTEXITCODE -ne 0) { throw 'Studio build failed' } } finally { Pop-Location }
}
$studioDir = Join-Path $resolvedRun 'studio'
New-Item -ItemType Directory -Path $studioDir -Force | Out-Null
$nodeExe = (Get-Command node.exe).Source
$process = Start-Process -FilePath $nodeExe -ArgumentList @('node_modules/tsx/dist/cli.mjs', 'tools/studio.mts', ('"' + $resolvedRun + '"'), "--port=$Port") -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $studioDir 'server.out.log') -RedirectStandardError (Join-Path $studioDir 'server.err.log') -PassThru
Write-Output "HotClip Studio starting: http://127.0.0.1:$Port (launcher PID $($process.Id))"
