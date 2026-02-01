#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "Updating Thufir in $ROOT_DIR"

echo "- Fetching latest code"
git pull --ff-only

echo "- Installing dependencies"
pnpm install

if [ -d "$ROOT_DIR/vendor/openclaw/.git" ]; then
  echo "- Updating OpenClaw vendor"
  git -C "$ROOT_DIR/vendor/openclaw" pull --ff-only
  echo "- Installing OpenClaw dependencies"
  pnpm --dir "$ROOT_DIR/vendor/openclaw" install
fi

echo "- Building"
pnpm build

echo "- Restarting service"
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart thufir
  sudo systemctl status thufir --no-pager
  if systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -qx 'openclaw-gateway.service'; then
    echo "- Restarting openclaw-gateway"
    sudo systemctl restart openclaw-gateway
    sudo systemctl status openclaw-gateway --no-pager
  fi
  if systemctl list-unit-files --type=service --no-legend | awk '{print $1}' | grep -qx 'llm-mux.service'; then
    echo "- Restarting llm-mux"
    sudo systemctl restart llm-mux
    sudo systemctl status llm-mux --no-pager
  fi
else
  echo "systemctl not found; skipping service restart"
fi

echo "Update complete"
