#!/usr/bin/env bash
# Stamp a new cache-busting version on every script and the stylesheet in index.html.
# Run before each push: ./bump-version.sh
set -euo pipefail
cd "$(dirname "$0")"
v=$(date +%Y%m%d%H%M)
sed -i '' -E "s/\?v=[0-9a-z]+/?v=$v/g" index.html
echo "version $v"
