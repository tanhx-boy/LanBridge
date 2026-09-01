@echo off

cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo =======================================================
  echo   Node.js not found. Please install Node.js first.
  echo   Download: https://nodejs.org/
  echo =======================================================
  pause
  exit /b 1
)

echo =======================================================
echo   Building webshare.exe ...
echo =======================================================

REM Node 26+ built-in --build-sea: generate blob + copy node.exe + inject
node.exe --build-sea=sea-config.json
if %ERRORLEVEL% neq 0 (
  echo =======================================================
  echo   Build FAILED.
  echo =======================================================
  pause
  exit /b 1
)

REM Clean up SEA temp files
if exist "sea-prep.blob" del /f /q "sea-prep.blob" >nul 2>nul

echo =======================================================
echo   Build complete: %~dp0webshare.exe
echo =======================================================
pause
