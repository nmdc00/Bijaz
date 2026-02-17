#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

printf '[v1.5 smoke] running acceptance regression harness (v1.4 + v1.5)\n'
pnpm vitest run tests/integration/v1_4_acceptance.test.ts tests/integration/v1_5_acceptance.test.ts

printf '[v1.5 smoke] running typecheck\n'
pnpm typecheck

printf '[v1.5 smoke] complete\n'
