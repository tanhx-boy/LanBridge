<#
    build.ps1 - LanBridge 一键构建（Windows）

    与原 build.bat 等价，但刻意【不调用】vcvars64.bat：
      vcvars64 -> vcvarsall -> VsDevCmd.bat 这条链会用 reg.exe 查询注册表来定位
      VS 与 Windows SDK。在启用了程序黑名单或受限沙箱的机器上，reg.exe 可能被
      拦截，vcvars 会在中途失败：既不设置 INCLUDE/LIB，也不返回明确的错误码，
      于是整个构建静默中断、看不到任何提示。
    这里自己定位 MSVC 与 Windows SDK 目录并直接设置 PATH / INCLUDE / LIB，
    对本项目需要的 cl / rc / link 完全等价，而且更快、失败时也更透明。

    用法：
      powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1
#>
param()

$ErrorActionPreference = "Stop"

$toolDir = $PSScriptRoot
$rootDir = (Resolve-Path (Join-Path $toolDir "..")).Path

function Fail($msg) {
    Write-Host ""
    Write-Host "  [ERROR] $msg" -ForegroundColor Red
    Write-Host ""
    Write-Host "======================================================="
    Write-Host "  Build FAILED."
    Write-Host "======================================================="
    exit 1
}

Write-Host "======================================================="
Write-Host "  LanBridge C++ - one-click build"
Write-Host "======================================================="

# ---------- 1. 定位 Visual Studio（含 C++ 工具集） ----------
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    Fail "vswhere.exe not found. 请安装 Visual Studio 2022/2026 并勾选「使用 C++ 的桌面开发」。"
}
$vsPath = & $vswhere -latest -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ([string]::IsNullOrWhiteSpace($vsPath)) {
    Fail "未找到含 C++ 工具集的 Visual Studio 实例。"
}
$vsPath = ($vsPath | Select-Object -First 1).Trim()
Write-Host "  VS:   $vsPath"

# ---------- 2. 定位 MSVC 工具集 ----------
$msvcRoot = Join-Path $vsPath "VC\Tools\MSVC"
if (-not (Test-Path $msvcRoot)) { Fail "找不到 MSVC 工具集目录：$msvcRoot" }
$msvc = Get-ChildItem $msvcRoot -Directory |
        Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } -Descending |
        Select-Object -First 1
if (-not $msvc) { Fail "MSVC 目录下没有版本子目录：$msvcRoot" }
Write-Host "  MSVC: $($msvc.FullName)"

# ---------- 3. 定位 Windows SDK ----------
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10"
$sdkIncRoot = Join-Path $sdkRoot "Include"
if (-not (Test-Path $sdkIncRoot)) { Fail "找不到 Windows SDK：$sdkIncRoot" }
$sdkVer = Get-ChildItem $sdkIncRoot -Directory |
          Where-Object { $_.Name -match '^10\.' } |
          Sort-Object Name -Descending |
          Select-Object -First 1
if (-not $sdkVer) { Fail "Windows SDK 下没有 10.x 版本：$sdkIncRoot" }
Write-Host "  SDK:  $($sdkVer.Name)"

# ---------- 4. 组装编译环境（等价于 vcvars64 的作用） ----------
$env:PATH = (@(
    (Join-Path $msvc.FullName "bin\Hostx64\x64"),
    (Join-Path $sdkRoot "bin\$($sdkVer.Name)\x64")
) + ($env:PATH -split ';')) -join ';'

$env:INCLUDE = @(
    (Join-Path $msvc.FullName "include"),
    (Join-Path $sdkIncRoot "$($sdkVer.Name)\ucrt"),
    (Join-Path $sdkIncRoot "$($sdkVer.Name)\um"),
    (Join-Path $sdkIncRoot "$($sdkVer.Name)\shared"),
    (Join-Path $sdkIncRoot "$($sdkVer.Name)\winrt")
) -join ';'

$env:LIB = @(
    (Join-Path $msvc.FullName "lib\x64"),
    (Join-Path $sdkRoot "Lib\$($sdkVer.Name)\ucrt\x64"),
    (Join-Path $sdkRoot "Lib\$($sdkVer.Name)\um\x64")
) -join ';'

$cl = Join-Path $msvc.FullName "bin\Hostx64\x64\cl.exe"
$rc = Join-Path $sdkRoot "bin\$($sdkVer.Name)\x64\rc.exe"
if (-not (Test-Path $cl)) { Fail "找不到 cl.exe：$cl" }
if (-not (Test-Path $rc)) { Fail "找不到 rc.exe：$rc" }

Set-Location $rootDir

# ---------- 5. favicon 裁剪 + 资源内嵌 ----------
Write-Host "-------------------------------------------------------"
Write-Host "  Preparing favicon.ico ..."
Write-Host "-------------------------------------------------------"
& (Join-Path $toolDir "make-favicon.ps1")

Write-Host "-------------------------------------------------------"
Write-Host "  Embedding index.html and favicon.ico ..."
Write-Host "-------------------------------------------------------"
& (Join-Path $toolDir "embed.ps1")
& (Join-Path $toolDir "embed.ps1") `
    -Source (Join-Path $rootDir "favicon.ico") `
    -Output (Join-Path $rootDir "src\app_ico.h") `
    -Symbol APP_ICON

# ---------- 6. 编译图标资源 ----------
Write-Host "-------------------------------------------------------"
Write-Host "  Compiling resources ..."
Write-Host "-------------------------------------------------------"
& $rc /nologo /fo app.res app.rc
if ($LASTEXITCODE -ne 0) { Fail "rc 编译资源失败（退出码 $LASTEXITCODE）" }

# ---------- 7. 编译链接 ----------
Write-Host "-------------------------------------------------------"
Write-Host "  Compiling ..."
Write-Host "-------------------------------------------------------"
$clArgs = @(
    "/nologo", "/std:c++17", "/O2", "/MT", "/utf-8", "/EHsc", "/W3",
    "/I", "third_party",
    "src\server.cpp",
    "app.res",
    "/Fe:LanBridge.exe",
    "/link", "ws2_32.lib", "bcrypt.lib", "iphlpapi.lib"
)
& $cl @clArgs
if ($LASTEXITCODE -ne 0) { Fail "编译失败（退出码 $LASTEXITCODE）" }

$exe = Join-Path $rootDir "LanBridge.exe"
$kb = [math]::Round((Get-Item $exe).Length / 1KB, 0)
Write-Host "======================================================="
Write-Host "  Build OK: $exe  ($kb KB)"
Write-Host "  Double-click LanBridge.exe to run."
Write-Host "======================================================="
exit 0
