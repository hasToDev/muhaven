#!/bin/bash
# Oracle staleness monitor — homelab cron job.
#
# Polls the prod `IssuerControlledOracle` for each onboarded RWA token's
# `updatedAt` timestamp. If any token's NAV is older than THRESHOLD_HR
# hours, posts an alert to the operator's Telegram chat.
#
# Designed to be cheap + boring:
#   - Curl + jq only (no node, no docker, no npm-managed deps).
#   - Read-only eth_call against the public RPC. No signing, no gas.
#   - Independent of the nav-worker / nav-publisher pipeline — so a
#     publisher failure (the exact case we're catching) doesn't take
#     down the monitor.
#
# Configuration (env vars):
#   THRESHOLD_HR             — staleness alert threshold (default 12h).
#                              Contract's max-staleness is 36h, so 12h
#                              gives ~24h of slack to act before
#                              Subscription.purchase reverts.
#   ARB_SEPOLIA_RPC_URL      — RPC endpoint (default public Arb Sepolia).
#   TELEGRAM_BOT_TOKEN       — required for alerts; otherwise stdout-only.
#   TELEGRAM_OPERATOR_CHAT_ID — required for alerts; otherwise stdout-only.
#
# Token roster + oracle address are hardcoded against the prod
# deployment file (`deployments/arb-sepolia-v2.json`). If a new token
# is onboarded, append to the TOKENS array below + redeploy. The
# `MUHAVEN_NAV_TOKEN_ROSTER` env var below lets you override at runtime
# without editing the file (one or more `addr:symbol` pairs separated
# by spaces).
#
# Crontab (operator-installed, see HOMELAB_DEPLOY.md):
#   */30 * * * * cd /home/muhaven/Project/Fhenix/MuHaven && \
#                bash scripts/oracle-staleness-check.sh >> /var/log/muhaven-oracle-monitor.log 2>&1
#
# Exit codes:
#   0 — all tokens fresh.
#   1 — at least one token stale (alert sent if Telegram env present).
#   2 — RPC/network failure (alert sent if Telegram env present).

set -euo pipefail

# Cron's environment is minimal — no $HOME/.bashrc, no /etc/profile.
# Source a dedicated env file so the operator can keep monitor creds in
# one place without polluting the running services' env files. File is
# optional (the script degrades to stdout-only logging if absent or
# TELEGRAM_* vars are unset).
MONITOR_ENV_FILE="${MONITOR_ENV_FILE:-/home/muhaven/Project/Fhenix/MuHaven/.monitor.env}"
if [ -f "$MONITOR_ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$MONITOR_ENV_FILE"
  set +a
fi

THRESHOLD_HR="${THRESHOLD_HR:-12}"
RPC_URL="${ARB_SEPOLIA_RPC_URL:-https://sepolia-rollup.arbitrum.io/rpc}"
ORACLE_ADDR="0xD30069114dFC83C714B04d6036dEfa64d2E9d583"

# 2026-05-17 Design A: roster source is on-chain `TokenRegistry`. The
# static MUHAVEN_NAV_TOKEN_ROSTER env still works as an override (useful
# for testing or sentinel exclusion). When unset, the script enumerates
# active+oracle-bound tokens from TokenRegistry on each run — which
# catches apply-issuer-onboarded tokens the prior static roster missed
# (e.g. 0xf03a… that surfaced during the 2026-05-17 walkthrough).
TOKEN_REGISTRY_ADDR="${TOKEN_REGISTRY_ADDR:-0x4915E9Aa034244e299fb1609792D66b9fFAbf885}"
ROSTER="${MUHAVEN_NAV_TOKEN_ROSTER:-}"

# Function selectors (computed via keccak256("name(types)")[:4]).
GET_NAV_SELECTOR="0x179ddcdd"
REGISTERED_TOKEN_COUNT_SELECTOR="0xe5d3a97b"  # registeredTokenCount()
GET_REGISTERED_TOKENS_SELECTOR="0xc349bec6"  # getRegisteredTokens(uint256,uint256)
GET_CONFIG_SELECTOR="0xe48a5f7b"             # getConfig(address)
SYMBOL_SELECTOR="0x95d89b41"                 # symbol()

now=$(date +%s)
threshold_sec=$((THRESHOLD_HR * 3600))
stale_count=0
err_count=0

send_telegram() {
  local msg="$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_OPERATOR_CHAT_ID:-}" ]; then
    curl -sS -m 10 -o /dev/null \
      -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_OPERATOR_CHAT_ID}" \
      --data-urlencode "text=${msg}" \
      --data-urlencode "disable_notification=false" || true
  fi
}

# Zero-pad a hex address (0x-prefixed) to 64 hex chars (32-byte ABI slot).
pad_addr() {
  local addr_raw="${1#0x}"
  local addr_lc
  addr_lc=$(echo "$addr_raw" | tr 'A-F' 'a-f')
  printf '%064s' "$addr_lc" | tr ' ' '0'
}

# Pad an integer to 64 hex chars (32-byte ABI slot).
pad_uint() {
  printf '%064x' "$1"
}

# eth_call helper — returns the .result hex string, or empty on error.
eth_call() {
  local to="$1"
  local data="$2"
  local response
  response=$(curl -sS -m 15 -X POST "$RPC_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$to\",\"data\":\"$data\"},\"latest\"]}" 2>&1) \
    || return 1
  local err
  err=$(echo "$response" | jq -r '.error.message // empty')
  if [ -n "$err" ]; then
    echo "$err" >&2
    return 1
  fi
  echo "$response" | jq -r '.result'
}

# Hex → decimal, safe against bash octal interpretation.
hex_to_dec() {
  local clean
  clean=$(echo "$1" | sed 's/^0*//')
  if [ -z "$clean" ]; then
    echo 0
  else
    echo $((16#${clean}))
  fi
}

# Enumerate active+oracle-bound tokens from TokenRegistry.
# Outputs lines of `address:symbol` (symbol may be the abbreviated
# address if symbol() fails or the token is non-ERC20).
enumerate_active_tokens() {
  local count_hex
  count_hex=$(eth_call "$TOKEN_REGISTRY_ADDR" "$REGISTERED_TOKEN_COUNT_SELECTOR") \
    || { echo "ENUM_FAIL: registeredTokenCount" >&2; return 1; }
  local count
  count=$(hex_to_dec "${count_hex#0x}")
  if [ "$count" -eq 0 ]; then return 0; fi

  # Single page call (count is small in practice; 100 is the ceiling).
  local data="${GET_REGISTERED_TOKENS_SELECTOR}$(pad_uint 0)$(pad_uint 100)"
  local result
  result=$(eth_call "$TOKEN_REGISTRY_ADDR" "$data") \
    || { echo "ENUM_FAIL: getRegisteredTokens" >&2; return 1; }
  local hex="${result#0x}"
  # ABI shape: [offset (32B)] [length (32B)] [addr (32B)] × N
  # offset is always 0x20 here so we can skip it and read length next.
  local len_hex="${hex:64:64}"
  local len
  len=$(hex_to_dec "$len_hex")
  if [ "$len" -eq 0 ]; then return 0; fi

  local i=0
  while [ "$i" -lt "$len" ]; do
    local start=$((128 + i * 64))
    local addr_padded="${hex:$start:64}"
    # Last 20 bytes = address; right-shift past the 12-byte left-pad.
    local addr="0x${addr_padded:24:40}"

    # Check active+oracle-bound via getConfig.
    local cfg_data="${GET_CONFIG_SELECTOR}$(pad_addr "$addr")"
    local cfg_result
    cfg_result=$(eth_call "$TOKEN_REGISTRY_ADDR" "$cfg_data") || {
      i=$((i + 1)); continue
    }
    local cfg_hex="${cfg_result#0x}"
    # TokenConfig struct field 0 = active (bool), padded to 32 bytes.
    local active_hex="${cfg_hex:0:64}"
    local active
    active=$(hex_to_dec "$active_hex")
    if [ "$active" -eq 0 ]; then i=$((i + 1)); continue; fi
    # Field 3 = oracle (address, 32 bytes). Offset 3*64 = 192.
    local oracle_padded="${cfg_hex:192:64}"
    local cfg_oracle="0x${oracle_padded:24:40}"
    # Compare lowercase against our managed oracle. Tokens wired to a
    # different oracle (e.g. Chainlink) are out of this monitor's scope.
    local oracle_lc cfg_oracle_lc
    oracle_lc=$(echo "$ORACLE_ADDR" | tr 'A-F' 'a-f')
    cfg_oracle_lc=$(echo "$cfg_oracle" | tr 'A-F' 'a-f')
    if [ "$oracle_lc" != "$cfg_oracle_lc" ]; then
      i=$((i + 1)); continue
    fi

    # Resolve symbol (best-effort).
    local sym
    sym=$(eth_call "$addr" "$SYMBOL_SELECTOR" 2>/dev/null || echo "")
    local sym_clean=""
    if [ -n "$sym" ] && [ "$sym" != "0x" ]; then
      local sym_hex="${sym#0x}"
      # ABI string: [offset (32B)] [length (32B)] [data padded to 32-byte boundary]
      local sym_len_hex="${sym_hex:64:64}"
      local sym_len
      sym_len=$(hex_to_dec "$sym_len_hex")
      if [ "$sym_len" -gt 0 ] && [ "$sym_len" -lt 64 ]; then
        local sym_data_hex="${sym_hex:128:$((sym_len * 2))}"
        # Hex → ASCII via xxd.
        sym_clean=$(printf '%s' "$sym_data_hex" | xxd -r -p 2>/dev/null || echo "")
      fi
    fi
    [ -z "$sym_clean" ] && sym_clean="${addr:0:6}…${addr: -4}"

    echo "${addr}:${sym_clean}"
    i=$((i + 1))
  done
}

# Resolve the roster — override env > on-chain enumeration.
if [ -z "$ROSTER" ]; then
  echo "$(date -Iseconds) Enumerating active tokens from TokenRegistry ($TOKEN_REGISTRY_ADDR)…"
  ROSTER=$(enumerate_active_tokens) || {
    msg="❌ MuHaven oracle monitor — TokenRegistry enumeration failed. Falling back to no tokens; will alert next cycle."
    echo "$(date -Iseconds) $msg" >&2
    send_telegram "$msg"
    exit 2
  }
  if [ -z "$ROSTER" ]; then
    echo "$(date -Iseconds) TokenRegistry returned no active tokens. Nothing to monitor."
    exit 0
  fi
  # Convert newlines to spaces so the for-loop below iterates cleanly.
  ROSTER=$(echo "$ROSTER" | tr '\n' ' ')
fi

for entry in $ROSTER; do
  addr="${entry%%:*}"
  sym="${entry##*:}"

  # Build calldata: selector + padded address argument.
  data="${GET_NAV_SELECTOR}$(pad_addr "$addr")"

  # eth_call to oracle.getNAV(token) → returns (uint256 nav, uint256 updatedAt).
  response=$(curl -sS -m 15 -X POST "$RPC_URL" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"$ORACLE_ADDR\",\"data\":\"$data\"},\"latest\"]}" 2>&1) \
    || {
      msg="❌ MuHaven oracle monitor — RPC call failed for ${sym} (${addr})"
      echo "$(date -Iseconds) $msg" >&2
      send_telegram "$msg"
      err_count=$((err_count + 1))
      continue
    }

  err_field=$(echo "$response" | jq -r '.error.message // empty')
  if [ -n "$err_field" ]; then
    msg="❌ MuHaven oracle monitor — eth_call reverted for ${sym} (${addr}): ${err_field}"
    echo "$(date -Iseconds) $msg" >&2
    send_telegram "$msg"
    err_count=$((err_count + 1))
    continue
  fi

  hex=$(echo "$response" | jq -r '.result')
  # Strip leading 0x; first 64 hex chars = nav, next 64 = updatedAt.
  hex_stripped="${hex#0x}"
  if [ ${#hex_stripped} -lt 128 ]; then
    msg="❌ MuHaven oracle monitor — short response for ${sym}: ${hex}"
    echo "$(date -Iseconds) $msg" >&2
    err_count=$((err_count + 1))
    continue
  fi
  updated_at_hex="${hex_stripped:64:64}"
  # Strip leading zeros from the hex to avoid bash octal interpretation.
  updated_at_hex_clean=$(echo "$updated_at_hex" | sed 's/^0*//')
  if [ -z "$updated_at_hex_clean" ]; then
    updated_at=0
  else
    updated_at=$((16#${updated_at_hex_clean}))
  fi

  age=$((now - updated_at))
  age_hr=$((age / 3600))

  if [ "$age" -gt "$threshold_sec" ]; then
    msg="⚠ MuHaven oracle stale — ${sym} (${addr}) last setNAV ${age_hr}h ago (threshold ${THRESHOLD_HR}h, contract max-staleness 36h). Run \`refresh-oracle.ts\` to unstick; investigate nav-worker if recurring."
    echo "$(date -Iseconds) $msg" >&2
    send_telegram "$msg"
    stale_count=$((stale_count + 1))
  else
    echo "$(date -Iseconds) ✓ ${sym} fresh (age ${age_hr}h, threshold ${THRESHOLD_HR}h)"
  fi
done

if [ "$err_count" -gt 0 ]; then
  exit 2
fi
if [ "$stale_count" -gt 0 ]; then
  exit 1
fi
exit 0
