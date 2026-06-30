@echo off
REM stop.bat - double-click to stop the Multi-Agent IDE (Windows).

setlocal
cd /d "%~dp0"

where pwsh >nul 2>nul
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
)

echo.
echo Press any key to close.
pause >nul
endlocal
