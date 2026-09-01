#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "======================================================="
  echo "  Node.js not found. Please install Node.js first."
  echo "  Download: https://nodejs.org/"
  echo "======================================================="
  exit 1
fi

echo "======================================================="
echo "  Starting LanBridge ..."
echo "======================================================="

exec node server.js
