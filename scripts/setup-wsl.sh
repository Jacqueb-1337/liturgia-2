#!/usr/bin/env bash
set -euo pipefail

# scripts/setup-wsl.sh
# Install prerequisites inside a WSL2 (Ubuntu) distro and run the app (WSLg preferred).
# Usage: sudo ./scripts/setup-wsl.sh

if [[ $(id -u) -ne 0 ]]; then
  echo "This script requires sudo/root. Run: sudo $0"
  exit 2
fi

echo "Updating apt..."
apt update && apt upgrade -y

echo "Installing runtime deps and build tools..."
apt install -y curl ca-certificates gnupg build-essential git

# Node 18 LTS install (NodeSource)
if ! command -v node >/dev/null 2>&1 || [[ $(node -v 2>/dev/null || "") != v18* ]]; then
  echo "Installing Node 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt install -y nodejs
fi

# GUI libs commonly required by Electron on Linux
apt install -y libgtk-3-0 libnotify4 libnss3 libxss1 libasound2 libx11-xcb1 libxcomposite1 libxrandr2 libgbm1

# Optional: ffmpeg for richer codec support
apt install -y ffmpeg || echo "ffmpeg install failed (optional, continue)"

echo "Switch to your project directory (e.g., /home/<user>/liturgia-2) and run:
  npm ci
  npm start

If WSLg is available the GUI should appear on your Windows desktop automatically. If not, install an X server on Windows and set DISPLAY inside WSL:
  export DISPLAY=$(grep nameserver /etc/resolv.conf | awk '{print $2}'):0

Tips:
 - Use /mnt/c/ path to access Windows files from WSL and verify fileUrlFor handles them.
 - To build a Linux AppImage inside WSL, run: npx electron-builder --linux

Done.
