#!/bin/sh
# Livynq installer: downloads the single-file binary and runs it as a service.
#   curl -fsSL https://raw.githubusercontent.com/gongbin/livynq/main/installers/install.sh | sh
# Options (env): LIVYNQ_VERSION=v0.2.0  LIVYNQ_PREFIX=/opt/livynq  LIVYNQ_DATA=/var/lib/livynq  LIVYNQ_NO_SERVICE=1
set -eu

REPO="gongbin/livynq"
VERSION="${LIVYNQ_VERSION:-latest}"
PREFIX="${LIVYNQ_PREFIX:-/opt/livynq}"
DATA="${LIVYNQ_DATA:-/var/lib/livynq}"

say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) die "unsupported OS $(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m) (supported: x86_64, arm64)" ;;
esac

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "run as root or install sudo"
  SUDO="sudo"
fi

asset="livynq-${os}-${arch}"
if [ "$VERSION" = latest ]; then url="https://github.com/${REPO}/releases/latest/download/${asset}.gz"
else url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}.gz"; fi

say "downloading ${asset} (${VERSION}, ~40 MB)"
tmp="$(mktemp)"
curl -fL --progress-bar "$url" | gunzip > "$tmp" || die "download failed: $url"
chmod 755 "$tmp"
"$tmp" --version >/dev/null || die "downloaded binary does not run on this system"

$SUDO mkdir -p "$PREFIX"
# Replace, never overwrite in place (keeps macOS code signatures valid, avoids "text file busy").
$SUDO rm -f "$PREFIX/livynq"
$SUDO mv "$tmp" "$PREFIX/livynq"
$SUDO ln -sf "$PREFIX/livynq" /usr/local/bin/livynq
say "installed $("$PREFIX/livynq" --version) to $PREFIX/livynq"

[ "${LIVYNQ_NO_SERVICE:-}" = 1 ] && { say "skipping service setup (LIVYNQ_NO_SERVICE=1)"; exit 0; }

if [ "$os" = linux ] && command -v systemctl >/dev/null 2>&1; then
  if ! id livynq >/dev/null 2>&1; then
    $SUDO useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin livynq
  fi
  # Serial (Zigbee/Z-Wave sticks) and Bluetooth access
  for g in dialout bluetooth; do getent group "$g" >/dev/null 2>&1 && $SUDO usermod -aG "$g" livynq || true; done
  $SUDO mkdir -p "$DATA"
  $SUDO chown -R livynq:livynq "$DATA"
  $SUDO chmod 750 "$DATA"
  $SUDO tee /etc/systemd/system/livynq.service >/dev/null <<UNIT
[Unit]
Description=Livynq smart home hub
Documentation=https://github.com/${REPO}
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=livynq
Group=livynq
Environment=LIVYNQ_DATA_DIR=${DATA}
ExecStart=${PREFIX}/livynq start
Restart=on-failure
RestartSec=5
# HomeKit/Matter need multicast on the LAN; keep the sandbox to the data directory.
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${DATA}
PrivateTmp=true
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now livynq
  sleep 3
  say "service started — logs: journalctl -u livynq -f"
  say "login link: sudo -u livynq LIVYNQ_DATA_DIR=${DATA} livynq login-url"
elif [ "$os" = macos ]; then
  DATA="${LIVYNQ_DATA:-$HOME/.livynq}"
  plist="$HOME/Library/LaunchAgents/dev.livynq.hub.plist"
  mkdir -p "$(dirname "$plist")" "$DATA"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.livynq.hub</string>
  <key>ProgramArguments</key><array><string>${PREFIX}/livynq</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict><key>LIVYNQ_DATA_DIR</key><string>${DATA}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA}/livynq.log</string>
  <key>StandardErrorPath</key><string>${DATA}/livynq.log</string>
</dict></plist>
PLIST
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load -w "$plist"
  sleep 3
  say "service started — logs: tail -f ${DATA}/livynq.log"
  say "login link: livynq login-url"
else
  say "no systemd found; start manually: LIVYNQ_DATA_DIR=${DATA} ${PREFIX}/livynq start"
fi
