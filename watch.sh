#!/bin/bash
# Watch mode: auto-rebuild and copy on changes

VAULT_PLUGIN="/mnt/c/Users/akougk/Projects/vaultex/.obsidian/plugins/notient"

copy_files() {
    cp main.js manifest.json "$VAULT_PLUGIN/" 2>/dev/null && \
    echo "$(date +%H:%M:%S) ✅ Copied to vault"
}

# Initial build and copy
echo "🚀 Starting watch mode..."
~/.bun/bin/bun esbuild.config.ts && copy_files

# Watch for changes using inotifywait if available, otherwise poll
if command -v inotifywait &> /dev/null; then
    while inotifywait -r -e modify,create,delete src/ 2>/dev/null; do
        echo "$(date +%H:%M:%S) 🔨 Rebuilding..."
        ~/.bun/bin/bun esbuild.config.ts && copy_files
    done
else
    echo "📝 Polling mode (install inotify-tools for instant rebuilds)"
    LAST_HASH=""
    while true; do
        HASH=$(find src -type f -name "*.ts" -exec md5sum {} \; | md5sum)
        if [ "$HASH" != "$LAST_HASH" ] && [ -n "$LAST_HASH" ]; then
            echo "$(date +%H:%M:%S) 🔨 Rebuilding..."
            ~/.bun/bin/bun esbuild.config.ts && copy_files
        fi
        LAST_HASH=$HASH
        sleep 2
    done
fi
