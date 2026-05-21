#!/usr/bin/env bash
# install-oracle-refresh.sh -- Register the Wave 5 Q2 oracle-refresh cron
# as a systemd `--user` timer on the homelab (GUI Ubuntu 24.04 with
# autologin). Runs the bash wrapper at scripts/refresh-and-ingest.sh
# three times daily at 00 / 08 / 16 UTC.
#
# Why systemd --user rather than crontab:
#   - Logs land in `journalctl --user -u muhaven-oracle-refresh` (greppable,
#     persistent, no race with logrotate).
#   - `OnCalendar=... UTC` is explicit + DST-proof.
#   - `Persistent=true` catches up if the homelab was off across a tick.
#   - `Environment=DISPLAY=:0` keeps headed Chromium happy without
#     adding a per-script export-and-hope-it-sticks dance.
#
# Why `--user` rather than system:
#   - The autologged-in operator owns the persistent Chromium profile;
#     running the timer as the same user means the profile is reachable
#     and the display is already this user's session.
#   - No sudo needed; no root in the cron path.
#
# Prereqs (operator must complete BEFORE running this installer):
#   1. Repo synced to ~/Project/Fhenix/MuHaven (via `pnpm run deploy:homelab`).
#   2. `cd ~/Project/Fhenix/MuHaven/scripts/oracle-mine && npm install`
#      (fetches playwright + ~150MB Chromium).
#   3. One-off interactive scrape to seed the persistent profile cookie:
#      `DISPLAY=:0 npx tsx scripts/scrape-asset.ts --slug=USYC`
#      (open the headed browser, log into rwa.xyz, press Enter).
#   4. `cp scripts/refresh-and-ingest.env.example scripts/refresh-and-ingest.env`
#      and fill in both secrets from `backend/.env`.
#   5. Manual smoke: `bash scripts/refresh-and-ingest.sh` -- expect a
#      green `outcome=ok rc=0` line in `scripts/oracle-mine/_debug/refresh-history.log`.
#
# If autologin is NOT enabled and the homelab user isn't always sitting in
# a graphical session, enable systemd lingering so the user manager runs
# across logout:
#   loginctl enable-linger "$USER"
#
# Usage:
#   bash scripts/linux/install-oracle-refresh.sh           # register + start
#   bash scripts/linux/install-oracle-refresh.sh --dry-run # print units, don't write

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WRAPPER="${REPO_ROOT}/scripts/refresh-and-ingest.sh"

if [ ! -x "${WRAPPER}" ] && [ ! -f "${WRAPPER}" ]; then
  echo "ERROR: wrapper not found at ${WRAPPER}" >&2
  exit 78
fi

SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SYSTEMD_USER_DIR}/muhaven-oracle-refresh.service"
TIMER_FILE="${SYSTEMD_USER_DIR}/muhaven-oracle-refresh.timer"

echo "Installing muhaven-oracle-refresh systemd --user units..."
echo "  wrapper:  ${WRAPPER}"
echo "  service:  ${SERVICE_FILE}"
echo "  timer:    ${TIMER_FILE}"
echo "  schedule: 00:00 / 08:00 / 16:00 UTC daily"
echo ""

if [ "${DRY_RUN}" = "0" ]; then
  mkdir -p "${SYSTEMD_USER_DIR}"
fi

# Render the service. WorkingDirectory + WRAPPER are absolute so the
# timer doesn't care where systemctl was invoked from.
SERVICE_CONTENT=$(cat <<EOF
[Unit]
Description=MuHaven Wave 5 Q2 -- oracle refresh (scrape rwa.xyz + ingest)
Documentation=file://${REPO_ROOT}/docs/OPERATOR_CRONS.md
# graphical-session.target is the right anchor for a HEADED Chromium
# launch; the headless equivalent (default.target) would race the
# desktop coming up after boot.
After=graphical-session.target
Wants=graphical-session.target

[Service]
Type=oneshot
# Autologin desktop sets DISPLAY=:0 in the operator's session; pin it
# explicitly so the timer-spawned environment inherits the right value
# even if systemd's environment passing changes.
Environment=DISPLAY=:0
WorkingDirectory=${REPO_ROOT}
ExecStart=/bin/bash ${WRAPPER}
# 1h matches the Task Scheduler ExecutionTimeLimit on the Windows
# fallback installer. A healthy headed scrape completes in ~4 min.
TimeoutStartSec=3600
# Don't restart on failure -- the wrapper fires its own Telegram alert
# and we want the next OnCalendar tick to be the recovery path, not a
# tight loop.
Restart=no

[Install]
WantedBy=default.target
EOF
)

TIMER_CONTENT=$(cat <<'EOF'
[Unit]
Description=MuHaven Wave 5 Q2 -- oracle refresh timer (00 / 08 / 16 UTC)
Documentation=man:systemd.timer(5)

[Timer]
# Explicit UTC anchors -- DST-proof; the operator's wall clock can
# move freely. systemd accepts the `UTC` suffix on OnCalendar specs.
OnCalendar=*-*-* 00,08,16:00:00 UTC
# Catch-up: if the homelab was off across a tick, fire the missed
# slot as soon as the user session is back up. Tracks last-run state
# in /var/lib/systemd/timers/.
Persistent=true
Unit=muhaven-oracle-refresh.service

[Install]
WantedBy=timers.target
EOF
)

if [ "${DRY_RUN}" = "1" ]; then
  echo "=== ${SERVICE_FILE} ==="
  echo "${SERVICE_CONTENT}"
  echo ""
  echo "=== ${TIMER_FILE} ==="
  echo "${TIMER_CONTENT}"
  echo ""
  echo "(dry-run -- no files written, no systemctl invoked)"
  exit 0
fi

printf '%s\n' "${SERVICE_CONTENT}" > "${SERVICE_FILE}"
printf '%s\n' "${TIMER_CONTENT}"   > "${TIMER_FILE}"

systemctl --user daemon-reload
systemctl --user enable --now muhaven-oracle-refresh.timer

echo ""
echo "Installed. Verify:"
echo "  systemctl --user status muhaven-oracle-refresh.timer"
echo "  systemctl --user list-timers muhaven-oracle-refresh.timer"
echo ""
echo "Force a one-off run (also useful for first-time smoke):"
echo "  systemctl --user start muhaven-oracle-refresh.service"
echo "  journalctl --user -u muhaven-oracle-refresh.service -f"
echo ""
echo "Uninstall:"
echo "  bash scripts/linux/uninstall-oracle-refresh.sh"
echo ""
if [ "$(loginctl show-user "${USER}" 2>/dev/null | grep -c 'Linger=yes')" -eq 0 ]; then
  echo "NOTE: systemd user manager will exit when you log out (no lingering)."
  echo "      For 24/7 timer firing even across logout, enable lingering:"
  echo "        sudo loginctl enable-linger ${USER}"
fi
