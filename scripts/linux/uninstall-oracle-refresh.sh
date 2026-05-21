#!/usr/bin/env bash
# uninstall-oracle-refresh.sh -- Remove the MuHaven Wave 5 Q2
# systemd --user timer + service installed by install-oracle-refresh.sh.

set -euo pipefail

SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SYSTEMD_USER_DIR}/muhaven-oracle-refresh.service"
TIMER_FILE="${SYSTEMD_USER_DIR}/muhaven-oracle-refresh.timer"

if ! systemctl --user list-unit-files muhaven-oracle-refresh.timer >/dev/null 2>&1; then
  echo "muhaven-oracle-refresh.timer not registered -- nothing to do."
  exit 0
fi

systemctl --user stop muhaven-oracle-refresh.timer 2>/dev/null || true
systemctl --user disable muhaven-oracle-refresh.timer 2>/dev/null || true
systemctl --user stop muhaven-oracle-refresh.service 2>/dev/null || true

rm -f -- "${TIMER_FILE}" "${SERVICE_FILE}"
systemctl --user daemon-reload

echo "Removed muhaven-oracle-refresh.timer + .service."
echo ""
echo "Note: journalctl logs are retained. To purge:"
echo "  journalctl --user --vacuum-time=1s -u muhaven-oracle-refresh"
