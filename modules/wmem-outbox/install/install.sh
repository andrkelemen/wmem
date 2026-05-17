#!/usr/bin/env bash
# install.sh — install wmem-outbox systemd-user service on Linux.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
UNIT_SRC="$REPO/modules/wmem-outbox/install/wmem-outbox.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_DST="$UNIT_DIR/wmem-outbox.service"

if [ ! -f "$UNIT_SRC" ]; then
  echo "✗ unit template not found at $UNIT_SRC" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"
cp "$UNIT_SRC" "$UNIT_DST"
echo "✓ installed unit at $UNIT_DST"

systemctl --user daemon-reload
systemctl --user enable --now wmem-outbox.service
sleep 2

if systemctl --user is-active --quiet wmem-outbox.service; then
  echo "✓ wmem-outbox.service is active"
  echo
  echo "Logs:"
  journalctl --user -u wmem-outbox.service --no-pager -n 10 || true
else
  echo "✗ wmem-outbox.service failed to start" >&2
  journalctl --user -u wmem-outbox.service --no-pager -n 20 >&2
  exit 1
fi

echo
echo "Test:"
echo "  curl -s http://127.0.0.1:4201/health | jq"
