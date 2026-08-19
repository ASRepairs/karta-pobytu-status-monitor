#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PIO_BASE_URL:-https://pio-przybysz.duw.pl}"
BASE_URL="${BASE_URL%/}"
PORTAL_URL="${BASE_URL}/login"
OUTPUT_FILE="${GITHUB_OUTPUT:-/tmp/kpsm-egress-output}"
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/null}"
MAX_ROUNDS="${PIO_EGRESS_RETRY_ROUNDS:-3}"
RETRY_DELAY="${PIO_EGRESS_RETRY_DELAY_SECONDS:-20}"

if ! [[ "$MAX_ROUNDS" =~ ^[1-9][0-9]*$ ]]; then
  MAX_ROUNDS=3
fi
if ! [[ "$RETRY_DELAY" =~ ^[0-9]+$ ]]; then
  RETRY_DELAY=20
fi

log_summary() {
  printf '%s\n' "$1" >> "$SUMMARY_FILE"
}

mark_available() {
  echo 'available=true' >> "$OUTPUT_FILE"
}

mark_unavailable() {
  echo 'available=false' >> "$OUTPUT_FILE"
  echo 'mode=unavailable' >> "$OUTPUT_FILE"
}

probe_direct() {
  curl -A 'karta-pobytu-status-monitor/0.1' \
    -fsSL --connect-timeout 8 --max-time 20 \
    -o /dev/null "$PORTAL_URL"
}

probe_http_proxy() {
  local args=(
    -A 'karta-pobytu-status-monitor/0.1'
    -fsSL --connect-timeout 10 --max-time 25
    --proxy "$PIO_PROXY_SERVER"
    -o /dev/null
  )

  if [[ -n "${PIO_PROXY_USERNAME:-}" || -n "${PIO_PROXY_PASSWORD:-}" ]]; then
    args+=(--proxy-user "${PIO_PROXY_USERNAME:-}:${PIO_PROXY_PASSWORD:-}")
  fi

  curl "${args[@]}" "$PORTAL_URL"
}

probe_tor() {
  curl -A 'karta-pobytu-status-monitor/0.1' \
    -fsSL --connect-timeout 12 --max-time 30 \
    --socks5-hostname 127.0.0.1:9050 \
    -o /dev/null "$PORTAL_URL"
}

stop_tor() {
  if [[ -f /tmp/kpsm-tor/tor.pid ]]; then
    kill "$(cat /tmp/kpsm-tor/tor.pid)" 2>/dev/null || true
  fi
  sudo pkill -x tor 2>/dev/null || true
}

start_fresh_tor() {
  stop_tor
  sleep 1
  rm -rf /tmp/kpsm-tor
  mkdir -p /tmp/kpsm-tor/data

  cat > /tmp/kpsm-tor/torrc <<'TORRC'
DataDirectory /tmp/kpsm-tor/data
SocksPort 127.0.0.1:9050
PidFile /tmp/kpsm-tor/tor.pid
Log notice file /tmp/kpsm-tor/tor.log
ExitNodes {pl},{de},{nl},{cz},{at},{sk},{lt},{lv},{ee},{se},{fi},{dk},{be},{fr},{gb},{ie},{ch},{no},{es},{pt},{it},{si},{hr},{hu},{ro},{bg},{gr},{lu},{mt},{cy},{is},{li},{rs},{ba},{me},{mk},{al},{md},{ua}
GeoIPExcludeUnknown 1
TORRC

  if ! tor -f /tmp/kpsm-tor/torrc --RunAsDaemon 1; then
    return 1
  fi

  for _ in $(seq 1 45); do
    if grep -q 'Bootstrapped 100%' /tmp/kpsm-tor/tor.log 2>/dev/null; then
      return 0
    fi
    sleep 1
  done

  return 1
}

# A user-supplied trusted proxy always has priority. This remains optional;
# the default path below requires no networking configuration from the user.
if [[ -n "${PIO_PROXY_SERVER:-}" ]]; then
  echo 'Testing configured proxy before exposing portal credentials…'
  if probe_http_proxy; then
    echo 'mode=custom-proxy' >> "$OUTPUT_FILE"
    mark_available
    log_summary '### European egress'
    log_summary 'Using the configured proxy; the portal was reachable through it before credentials were exposed.'
    exit 0
  fi
  echo 'Configured proxy could not reach Przybysz; continuing with automatic fallbacks.'
fi

# If the hosted runner happens to be accepted by Przybysz, use it directly.
# This is the fastest and most private option because no relay is involved.
echo 'Testing direct access to Przybysz…'
if probe_direct; then
  echo 'Direct runner access works; no relay is needed.'
  echo 'mode=direct' >> "$OUTPUT_FILE"
  mark_available
  log_summary '### European egress'
  log_summary 'The GitHub runner could reach Przybysz directly; no relay was used.'
  exit 0
fi

sudo systemctl stop tor@default.service tor.service 2>/dev/null || true

# Relay availability is inherently transient. Retry the entire automatic
# selection process a few times, creating a fresh Tor circuit and re-fetching
# VPN Gate's live relay list on every round.
for round in $(seq 1 "$MAX_ROUNDS"); do
  echo "Automatic European egress round ${round}/${MAX_ROUNDS}…"

  echo 'Trying an automatically configured European Tor exit…'
  if start_fresh_tor && probe_tor; then
    echo 'European Tor path can reach Przybysz.'
    echo 'mode=tor' >> "$OUTPUT_FILE"
    echo 'proxy=socks5://127.0.0.1:9050' >> "$OUTPUT_FILE"
    mark_available
    log_summary '### European egress'
    log_summary "Direct access was unavailable. A European Tor route reached Przybysz on automatic retry round ${round}/${MAX_ROUNDS}."
    exit 0
  fi

  stop_tor
  echo 'Tor could not reach Przybysz. Trying automatic VPN Gate European relays…'

  # VPN Gate is the last zero-configuration fallback. The Python helper only
  # routes the Przybysz server addresses through the VPN, rather than changing
  # the default route for the whole GitHub runner. Running it again on the next
  # round fetches a fresh volunteer-relay list.
  if sudo -E python3 scripts/vpngate-eu.py \
    --portal-host "$(node -e "console.log(new URL(process.argv[1]).hostname)" "$BASE_URL")" \
    --output "$OUTPUT_FILE"; then
    mark_available
    log_summary '### European egress'
    log_summary "Direct and Tor access were unavailable. A European VPN Gate relay reached Przybysz on automatic retry round ${round}/${MAX_ROUNDS}."
    exit 0
  fi

  if (( round < MAX_ROUNDS )); then
    echo "No European route worked in round ${round}/${MAX_ROUNDS}; waiting ${RETRY_DELAY}s before trying a fresh set of relays…"
    sleep "$RETRY_DELAY"
  fi
done

# This is deliberately a neutral outcome, not a workflow failure. A temporary
# shortage of usable public European relays says nothing about the user's case
# status and must never masquerade as a status-change alert.
stop_tor
mark_unavailable

echo "No usable European route was available after ${MAX_ROUNDS} automatic rounds. Skipping this status check without failing the workflow."
log_summary '### ⏭️ Status check skipped'
log_summary "Przybysz could not be reached through direct access, Tor, or VPN Gate after ${MAX_ROUNDS} automatic retry rounds. No case-status conclusion was made and the workflow is intentionally left successful to avoid a false alert."
exit 0
