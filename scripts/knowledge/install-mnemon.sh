#!/usr/bin/env bash
set -euo pipefail

if command -v mnemon >/dev/null 2>&1; then
  mnemon --version
  exit 0
fi

if command -v brew >/dev/null 2>&1; then
  brew install mnemon-dev/tap/mnemon
elif command -v go >/dev/null 2>&1; then
  go install github.com/mnemon-dev/mnemon@latest
else
  echo "mnemon install requires Homebrew or Go 1.24+." >&2
  echo "Install Go or Homebrew, then rerun scripts/knowledge/install-mnemon.sh." >&2
  exit 1
fi

mnemon --version
