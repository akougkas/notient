#!/bin/bash
# Auto-rebuild and copy to test vault
# Usage: ./dev.sh [--reset]

VAULT_PLUGIN="/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient"

# Check for reset flag
if [[ "$1" == "--reset" || "$1" == "-r" ]]; then
    echo "🗑️  Resetting plugin data..."
    rm -f "$VAULT_PLUGIN/data.json" 2>/dev/null
    rm -f "$VAULT_PLUGIN/orama-*.json" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/cache" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/processing-queue" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/lancedb" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/locks" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/logs" 2>/dev/null
    rm -f "$VAULT_PLUGIN/index-state.json" 2>/dev/null
    echo "✅ Reset complete"
fi

echo "🔨 Building..."
~/.bun/bin/bun esbuild.config.ts

if [ $? -eq 0 ]; then
    echo "📦 Copying to vault..."
    cp main.js manifest.json "$VAULT_PLUGIN/"
    echo "✅ Done! Reload Obsidian (Ctrl+R) or toggle plugin off/on"
else
    echo "❌ Build failed"
    exit 1
fi
