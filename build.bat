@echo off
setlocal
cd /d "%~dp0"

echo =======================================================
echo   LanBridge C++ - one-click build
echo =======================================================
echo.

rem ---------------------------------------------------------------------
rem The actual build logic lives in tools\build.ps1.
rem
rem We deliberately do NOT call vcvars64.bat here. The chain
rem   vcvars64 -> vcvarsall -> VsDevCmd.bat
rem shells out to reg.exe to query the registry for the VS / Windows SDK
rem layout. On machines with a program blacklist or a hardened sandbox,
rem reg.exe may be blocked; vcvars then fails halfway - setting neither
rem INCLUDE/LIB nor a clear exit code - and the build aborts silently.
rem build.ps1 locates the toolchain itself and sets the environment
rem directly, which is equivalent for this project and fails loudly.
rem ---------------------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -File "tools\build.ps1"
set "BUILD_RC=%ERRORLEVEL%"

echo.
pause
endlocal & exit /b %BUILD_RC%
