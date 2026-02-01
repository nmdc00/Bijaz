#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_DIR="$ROOT_DIR/logs"

mkdir -p "$RUN_DIR" "$LOG_DIR"

THUFIR_PORT="${THUFIR_PORT:-18790}"
OPENCLAW_PORT="${OPENCLAW_PORT:-18789}"

start_proc() {
  local name="$1"
  local pid_file="$RUN_DIR/$name.pid"
  local log_file="$LOG_DIR/$name.log"
  shift

  if [ -f "$pid_file" ]; then
    local pid
    pid="$(cat "$pid_file" || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" >/dev/null 2>&1; then
      echo "- $name already running (pid $pid)"
      return 0
    fi
  fi

  echo "- Starting $name"
  nohup "$@" >"$log_file" 2>&1 &
  echo $! >"$pid_file"
  echo "  pid $(cat "$pid_file"), log $log_file"
}

echo "Starting all services from $ROOT_DIR"

if [ ! -d "$ROOT_DIR/vendor/openclaw/.git" ]; then
  echo "OpenClaw repo missing at vendor/openclaw. Skipping OpenClaw gateway."
else
  if [ ! -d "$ROOT_DIR/vendor/openclaw/node_modules" ]; then
    echo "OpenClaw deps missing; run: pnpm --dir vendor/openclaw install"
    exit 1
  fi
  start_proc "openclaw-gateway" env OPENCLAW_GATEWAY_PORT="$OPENCLAW_PORT" \
    "$ROOT_DIR/vendor/openclaw/scripts/run-node.mjs" gateway --force
fi

start_proc "thufir-gateway" env THUFIR_GATEWAY_PORT="$THUFIR_PORT" pnpm gateway

echo "Done."
