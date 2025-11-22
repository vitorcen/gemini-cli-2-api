#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_ROOT"

CURRENT_STEP="startup"
on_error() {
  echo ""
  echo "❌ Initialization failed during: ${CURRENT_STEP}"
  echo ""
  echo "You can finish manually by running:"
echo "  npm install --legacy-peer-deps"
  echo "  npm run generate"
  echo "  npm run build:packages"
  echo ""
  exit 1
}
trap on_error ERR

# Gemini CLI 2 API - Project Initialization Script
# One-command setup for fresh clones

echo "🚀 Gemini CLI 2 API - Initialization"
echo "====================================="
echo ""

# Check Node.js version
CURRENT_STEP="Node.js version check"
echo "[1/5] Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Requires Node.js >= 20.0.0, current: $(node -v)"
  exit 1
fi
echo "      ✓ Node.js $(node -v)"
echo ""

# Install dependencies
CURRENT_STEP="npm install"
echo "[2/5] Installing dependencies..."
npm install --legacy-peer-deps
echo "      ✓ Dependencies installed"
echo ""

# Generate required files
CURRENT_STEP="generate git commit info"
echo "[3/5] Generating git commit info..."
npm run generate
echo "      ✓ git-commit.js generated"
echo ""

# Build all workspace packages
CURRENT_STEP="build workspaces"
echo "[4/5] Building all workspace packages..."
npm run build:packages
echo "      ✓ Build complete"
echo ""

# Verify build results
CURRENT_STEP="verify artifacts"
echo "[5/5] Verifying build results..."
if [ ! -f "packages/a2a-server/dist/src/http/server.js" ]; then
  echo "❌ Build failed: packages/a2a-server/dist/src/http/server.js not found"
  exit 1
fi

if [ ! -f "packages/core/dist/src/index.js" ]; then
  echo "❌ Build failed: packages/core/dist/src/index.js not found"
  exit 1
fi

JS_COUNT=$(find packages/a2a-server/dist packages/core/dist -name "*.js" 2>/dev/null | wc -l)
echo "      ✓ Generated $JS_COUNT .js files"
echo ""

# Test CLI
echo "      Testing CLI..."
CLI_VERSION=$(node bin/cli.js --version)
echo "      ✓ $CLI_VERSION"
echo ""

echo "✨ Initialization complete!"
echo ""
echo "Available commands:"
echo "  npm start              - Start proxy server (foreground)"
echo "  npm run build:packages - Rebuild all packages"
echo "  npm test               - Run tests"
echo "  npm run lint           - Lint code"
echo ""
echo "Publishing workflow:"
echo "  1. npm run generate"
echo "  2. npm run build:packages"
echo "  3. npm run prepare:package"
echo "  4. npm publish"
echo ""
