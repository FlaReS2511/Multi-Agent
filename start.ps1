# start.ps1 - 1-click launcher for the Multi-Agent IDE (Windows, API-only).
#
# - Ensures shared/state.db exists (runs the migration once if missing).
# - Ensures frontend deps are installed.
# - Launches the Electron dev app (vite + electron).
#
# Agents are NOT spawned here - start them from inside the UI (they run on
# demand via the API providers configured in Backend Settings).
#
# Usage:  double-click start.bat   (or)   pwsh -File start.ps1

$ErrorActionPreference = 'Stop'
$ROOT = $PSScriptRoot
$FRONTEND = Join-Path $ROOT 'project\frontend'

function Write-Step($msg) { Write-Host "> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "[!] $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "========================================" -ForegroundColor Blue
Write-Host "  Multi-Agent IDE - Starting up" -ForegroundColor Blue
Write-Host "========================================" -ForegroundColor Blue
Write-Host ""

# Resolve python (python on Windows, fallback py)
$PYTHON = 'python'
if (-not (Get-Command $PYTHON -ErrorAction SilentlyContinue)) {
  if (Get-Command 'py' -ErrorAction SilentlyContinue) { $PYTHON = 'py' }
  else { Write-Warn2 "Python not found in PATH - agents won't run, but the UI will." ; $PYTHON = $null }
}

# 1) Ensure the SQLite state DB exists (migrate once from any legacy files).
$dbPath = Join-Path $ROOT 'shared\state.db'
if (Test-Path $dbPath) {
  Write-Ok "state.db present"
} elseif ($PYTHON) {
  Write-Step "Creating shared/state.db (one-time migration)..."
  & $PYTHON (Join-Path $ROOT 'scripts\migrate-to-sqlite.py') | Out-Null
  Write-Ok "state.db created"
} else {
  Write-Warn2 "Skipping DB init (no Python). The app will create an empty DB on launch."
}

# 2) Ensure Python API SDK is available (VietAPI = openai-compatible).
if ($PYTHON) {
  & $PYTHON -c "import openai" *> $null
  $hasOpenai = ($LASTEXITCODE -eq 0)
  if (-not $hasOpenai) {
    Write-Step "Installing Python deps (openai)..."
    & $PYTHON -m pip install -r (Join-Path $ROOT 'scripts\requirements.txt') | Out-Null
  }
  Write-Ok "Python API SDK ready"
}

# 3) Ensure frontend deps.
if (-not (Test-Path (Join-Path $FRONTEND 'node_modules'))) {
  Write-Step "Installing frontend deps (npm install)... this can take a few minutes"
  Push-Location $FRONTEND
  npm install
  Pop-Location
}
Write-Ok "Frontend deps ready"

# 4) Already running?
$inUse = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  Write-Ok "UI already running on http://localhost:5173"
  Write-Host ""
  Write-Host "If no window is visible, close it from the taskbar and re-run." -ForegroundColor DarkGray
  exit 0
}

# 5) Launch the Electron dev app.
Write-Step "Launching Multi-Agent IDE (vite + electron)..."
Write-Host ""
Write-Host "  - Spawn agents from inside the UI (Backend Settings to set the VietAPI key)." -ForegroundColor DarkGray
Write-Host "  - To stop everything later, run stop.bat (or close the app window)." -ForegroundColor DarkGray
Write-Host ""

Push-Location $FRONTEND
try {
  npm run dev
} finally {
  Pop-Location
}
