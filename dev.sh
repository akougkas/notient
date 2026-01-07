#!/bin/bash
# Auto-rebuild and copy to test vault
# Usage: ./dev.sh [--reset] [--hard-reset]
#   --reset       Reset settings only (preserves indices)
#   --hard-reset  Full wipe including indices

VAULT_PLUGIN="/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient"

# Check for reset flags
if [[ "$1" == "--hard-reset" || "$1" == "-H" ]]; then
    echo "🗑️  HARD RESET: Wiping ALL plugin data including indices..."
    rm -f "$VAULT_PLUGIN/data.json" 2>/dev/null
    rm -f "$VAULT_PLUGIN/index-*.json" 2>/dev/null
    rm -f "$VAULT_PLUGIN/state-*.json" 2>/dev/null
    rm -f "$VAULT_PLUGIN/intelligence-*.json" 2>/dev/null
    rm -f "$VAULT_PLUGIN/conversations.json" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/cache" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/locks" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/logs" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/.deleted" 2>/dev/null
    # Legacy cleanup (pre-0.2.0)
    rm -f "$VAULT_PLUGIN/orama-*.json" 2>/dev/null
    rm -f "$VAULT_PLUGIN/orama-*.orama" 2>/dev/null
    rm -f "$VAULT_PLUGIN/orama-*.meta.json" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/processing-queue" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/lancedb" 2>/dev/null
    rm -f "$VAULT_PLUGIN/index-state.json" 2>/dev/null
    echo "✅ Hard reset complete - indices DELETED"
elif [[ "$1" == "--reset" || "$1" == "-r" ]]; then
    echo "🔄 Soft reset: Resetting settings only (indices preserved)..."
    rm -f "$VAULT_PLUGIN/data.json" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/cache" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/locks" 2>/dev/null
    rm -rf "$VAULT_PLUGIN/logs" 2>/dev/null
    echo "✅ Soft reset complete - indices PRESERVED"
fi

echo "🔨 Building..."
~/.bun/bin/bun esbuild.config.ts

if [ $? -eq 0 ]; then
    echo "📦 Copying to vault..."
    cp main.js manifest.json src/styles.css "$VAULT_PLUGIN/"
    echo "✅ Done! Reload Obsidian (Ctrl+R) or toggle plugin off/on"
else
    echo "❌ Build failed"
    exit 1
fi
