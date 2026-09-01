#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "======================================================="
  echo "  未检测到 Node.js，请先安装 Node.js 后再启动"
  echo "  下载地址: https://nodejs.org/"
  echo "======================================================="
  exit 1
fi

echo "Starting web-copy-share..."
exec node server.js
