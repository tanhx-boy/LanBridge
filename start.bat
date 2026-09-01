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
echo   Starting LanBridge ...
echo =======================================================

node server.js

if %ERRORLEVEL% neq 0 (
  echo =======================================================
  echo   Failed to start, error code: %ERRORLEVEL%
  echo =======================================================
  pause
)

exit /b %ERRORLEVEL%
