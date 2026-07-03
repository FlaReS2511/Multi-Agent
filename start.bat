@echo off
REM start.bat - double-click to launch the Multi-Agent IDE (Windows).
REM Runs start.ps1 with PowerShell. Prefers pwsh (PowerShell 7), falls back to
REM Windows PowerShell. Keeps the window open if it errors.

setlocal
cd /d "%~dp0"

where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
)

if %ERRORLEVEL% neq 0 (
  echo.
  echo Launch exited with an error. Press any key to close.
  pause >nul
)
endlocal
