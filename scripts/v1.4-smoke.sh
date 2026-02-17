#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

printf '[v1.4 smoke] running acceptance harness\n'
pnpm vitest run tests/integration/v1_4_acceptance.test.ts

printf '[v1.4 smoke] running typecheck\n'
pnpm typecheck

printf '[v1.4 smoke] complete\n'
