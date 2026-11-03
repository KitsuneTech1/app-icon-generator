#!/usr/bin/env bash
echo "========================================================"
echo "  Icon Pack Forge (app-icon-generator)"
echo "  Kitsune Technologies LLC"
echo "========================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js was not found on your system."
    echo "Please install Node.js (v18+) from https://nodejs.org/"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install --omit=dev
fi

echo "Starting Icon Pack Forge at http://localhost:8792 ..."
if command -v xdg-open >/dev/null 2>&1; then
    xdg-open http://localhost:8792 &
elif command -v open >/dev/null 2>&1; then
    open http://localhost:8792 &
fi

node server.js
