@echo off
setlocal
cd /d "%~dp0"

echo =======================================================
echo   LanBridge C++ - one-click build
echo =======================================================

rem ---- 1. Locate Visual Studio with the C++ toolset ----
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo [ERROR] vswhere.exe not found.
  echo         Install Visual Studio 2022/2026 with "Desktop development with C++".
  goto :fail
)

set "VSPATH="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSPATH=%%i"
if not defined VSPATH (
  echo [ERROR] No Visual Studio instance with the C++ toolset found.
  goto :fail
)
echo   VS: %VSPATH%

call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 (
  echo [ERROR] vcvars64.bat failed.
  goto :fail
)

rem ---- 2. Embed index.html into a C++ header ----
echo -------------------------------------------------------
echo   Embedding index.html ...
echo -------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\embed.ps1"
if errorlevel 1 (
  echo [ERROR] embed.ps1 failed.
  goto :fail
)

rem ---- 3. Compile ----
echo -------------------------------------------------------
echo   Compiling ...
echo -------------------------------------------------------
cl /nologo /std:c++17 /O2 /MT /utf-8 /EHsc /W3 ^
   /I third_party ^
   src\server.cpp ^
   /Fe:LanBridge.exe ^
   /link ws2_32.lib bcrypt.lib iphlpapi.lib
if errorlevel 1 (
  echo [ERROR] Compile failed.
  goto :fail
)

echo =======================================================
echo   Build OK: %CD%\LanBridge.exe
echo   Double-click LanBridge.exe to run.
echo =======================================================
goto :done

:fail
echo.
echo   Build FAILED.

:done
echo.
pause
endlocal
