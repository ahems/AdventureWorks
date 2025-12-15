#!/bin/bash
set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# App directory is parent of scripts directory
APP_DIR="$(dirname "$SCRIPT_DIR")"

echo "[Build Script] Starting build-with-env.sh"
echo "[Build Script] Script dir: $SCRIPT_DIR"
echo "[Build Script] App dir: $APP_DIR"
echo "[Build Script] Current directory: $(pwd)"

# Change to app directory if not already there
cd "$APP_DIR"
echo "[Build Script] Changed to: $(pwd)"

# Load .env.production if it exists and export variables
if [ -f ".env.production" ]; then
  echo "[Build Script] Found .env.production, loading..."
  cat .env.production
  export $(cat .env.production | xargs)
  echo "[Build Script] Environment variables set:"
  echo "  VITE_API_URL=$VITE_API_URL"
  echo "  VITE_API_FUNCTIONS_URL=$VITE_API_FUNCTIONS_URL"
else
  echo "[Build Script] WARNING: .env.production not found at $(pwd)/.env.production"
  ls -la .env* 2>/dev/null || echo "No .env files found"
fi

# Run the standard build
echo "[Build Script] Running npm run build..."
npm run build
echo "[Build Script] Build completed"
