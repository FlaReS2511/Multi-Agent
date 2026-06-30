# stop.ps1 — stop the Multi-Agent IDE dev processes (Windows).
# Kills the vite dev server on :5173, the Electron app, and any agent runtime
# python processes spawned by the app.

$ErrorActionPreference = 'SilentlyContinue'

Write-Host ""
Write-Host "========================================"
Write-Host "  Multi-Agent IDE - Stopping"
Write-Host "========================================"
Write-Host ""

# 1) Kill whatever listens on the vite dev port (5173).
$conns = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
$killed = $false
foreach ($c in $conns) {
  try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop; $killed = $true } catch {}
}
if ($killed) { Write-Host "[ok] Stopped vite dev server (:5173)" -ForegroundColor Green }
else { Write-Host "[--] No vite dev server on :5173" -ForegroundColor DarkGray }

# 2) Kill Electron processes launched from this project.
$root = $PSScriptRoot
$electrons = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*Multi-Agent*" }
foreach ($p in $electrons) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($electrons) { Write-Host "[ok] Stopped Electron app" -ForegroundColor Green }
else { Write-Host "[--] No Electron app running" -ForegroundColor DarkGray }

# 3) Kill agent runtime python processes (agent_runtime.py).
$pys = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='py.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*agent_runtime.py*" }
foreach ($p in $pys) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
if ($pys) { Write-Host "[ok] Stopped agent runtimes" -ForegroundColor Green }
else { Write-Host "[--] No agent runtimes running" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "Done." -ForegroundColor Green
