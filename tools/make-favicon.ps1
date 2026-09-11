# make-favicon.ps1 - trim app.ico down to the sizes a browser actually needs.
#
# Usage (normally invoked by build.bat):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-favicon.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-favicon.ps1 -Sizes 16,32
#
# 只做字节层面的裁切与目录重建，不重新编码任何图像，画质无损。
# 产物 favicon.ico 是构建中间物，不需要提交（见 .gitignore）。
param(
    [string]$Source = "",
    [string]$Output = "",
    [int[]]$Sizes = @(16, 24, 32, 48)
)

$ErrorActionPreference = "Stop"

$toolDir = $PSScriptRoot
$rootDir = (Resolve-Path (Join-Path $toolDir "..")).Path
if ([string]::IsNullOrWhiteSpace($Source)) { $Source = Join-Path $rootDir "app.ico" }
if ([string]::IsNullOrWhiteSpace($Output)) { $Output = Join-Path $rootDir "favicon.ico" }

$inPath = (Resolve-Path $Source).Path
$bytes = [System.IO.File]::ReadAllBytes($inPath)
if ($bytes.Length -lt 22) { throw "file too small to be an ICO: $inPath" }

$reserved = [BitConverter]::ToUInt16($bytes, 0)
$type = [BitConverter]::ToUInt16($bytes, 2)
$count = [BitConverter]::ToUInt16($bytes, 4)
if ($reserved -ne 0 -or $type -ne 1) { throw "not an ICO file: $inPath" }

$picked = @()
for ($i = 0; $i -lt $count; $i++) {
    $e = 6 + $i * 16
    $w = [int]$bytes[$e]
    if ($w -eq 0) { $w = 256 }
    if ($Sizes -contains $w) {
        $picked += [pscustomobject]@{
            W      = $w
            Entry  = $e
            Size   = [int][BitConverter]::ToUInt32($bytes, $e + 8)
            Offset = [int][BitConverter]::ToUInt32($bytes, $e + 12)
        }
    }
}
if ($picked.Count -eq 0) {
    throw "none of the requested sizes ($($Sizes -join ',')) exist in $inPath"
}
$picked = $picked | Sort-Object W

$dataStart = 6 + $picked.Count * 16
$total = $dataStart
foreach ($p in $picked) { $total += $p.Size }

$out = New-Object byte[] $total
$out[2] = 1                                                      # type = 1 (icon)
[BitConverter]::GetBytes([uint16]$picked.Count).CopyTo($out, 4)  # image count

$cursor = $dataStart
$j = 0
foreach ($p in $picked) {
    $ne = 6 + $j * 16
    [Array]::Copy($bytes, $p.Entry, $out, $ne, 16)
    # 目录项里的数据偏移必须重算，否则浏览器会读到错误位置
    [BitConverter]::GetBytes([uint32]$cursor).CopyTo($out, $ne + 12)
    [Array]::Copy($bytes, $p.Offset, $out, $cursor, $p.Size)
    $cursor += $p.Size
    $j++
}

[System.IO.File]::WriteAllBytes($Output, $out)
Write-Host "  [favicon] kept $((($picked | ForEach-Object { "$($_.W)x$($_.W)" }) -join ', ')) -> $Output ($($out.Length) bytes)"
