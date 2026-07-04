#!/usr/bin/env bash
set -euo pipefail

echo "=== Trove Toolkits & Sources devcontainer setup ==="

# Install bun if not already available (pre-installed on claude.ai/code)
if ! command -v bun &>/dev/null; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

# Install dependencies
bun install --frozen-lockfile

echo ""
echo "=== Ready ==="
echo "  bun run lint       Lint all files"
echo "  bun run test       Run tests"
echo "  bun run check      Lint + test with coverage"
echo "  bun run validate   Validate registry.json"
