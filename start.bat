@echo off
chcp 65001 >nul

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo =======================================================
  echo   Node.js not found. Please install Node.js first.
  echo   Download: https://nodejs.org/
  echo =======================================================
  pause
  exit /b 1
)

echo Starting web-copy-share...
node server.js

if errorlevel 1 (
  echo =======================================================
  echo   Failed to start, error code: %errorlevel%
  echo =======================================================
  pause
)

exit /b %errorlevel%
