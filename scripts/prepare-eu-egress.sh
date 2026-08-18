#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PIO_BASE_URL:-https://pio-przybysz.duw.pl}"
BASE_URL="${BASE_URL%/}"
PORTAL_URL="${BASE_URL}/login"
OUTPUT_FILE="${GITHUB_OUTPUT:-/tmp/kpsm-egress-output}"
SUMMARY_FILE="${GITHUB_STEP_SUMMARY:-/dev/null}"

log_summary() {
  printf '%s\n' "$1" >> "$SUMMARY_FILE"
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

# A user-supplied trusted proxy always has priority. This remains optional;
# the default path below requires no networking configuration from the user.
if [[ -n "${PIO_PROXY_SERVER:-}" ]]; then
  echo 'Testing configured proxy before exposing portal credentials…'
  if probe_http_proxy; then
    echo 'mode=custom-proxy' >> "$OUTPUT_FILE"
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
  log_summary '### European egress'
  log_summary 'The GitHub runner could reach Przybysz directly; no relay was used.'
  exit 0
fi

# First automatic fallback: Tor. The Ubuntu package may start its own default
# service, so stop that instance before starting our isolated client on 9050.
echo 'Direct access failed. Trying an automatically configured European Tor exit…'
sudo systemctl stop tor@default.service tor.service 2>/dev/null || true
sudo pkill -x tor 2>/dev/null || true
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

if tor -f /tmp/kpsm-tor/torrc --RunAsDaemon 1; then
  for _ in $(seq 1 45); do
    if grep -q 'Bootstrapped 100%' /tmp/kpsm-tor/tor.log 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if grep -q 'Bootstrapped 100%' /tmp/kpsm-tor/tor.log 2>/dev/null && probe_tor; then
    echo 'European Tor path can reach Przybysz.'
    echo 'mode=tor' >> "$OUTPUT_FILE"
    echo 'proxy=socks5://127.0.0.1:9050' >> "$OUTPUT_FILE"
    log_summary '### European egress'
    log_summary 'Direct access was unavailable. The monitor is using an automatically selected Tor exit that successfully reached Przybysz.'
    exit 0
  fi
fi

if [[ -f /tmp/kpsm-tor/tor.pid ]]; then
  kill "$(cat /tmp/kpsm-tor/tor.pid)" 2>/dev/null || true
fi

echo 'Tor could not reach Przybysz. Trying automatic VPN Gate European relays…'
# VPN Gate is the last zero-configuration fallback. The Python helper only
# routes the Przybysz server addresses through the VPN, rather than changing
# the default route for the whole GitHub runner.
sudo -E python3 scripts/vpngate-eu.py \
  --portal-host "$(node -e "console.log(new URL(process.argv[1]).hostname)" "$BASE_URL")" \
  --output "$OUTPUT_FILE"

log_summary '### European egress'
log_summary 'Direct and Tor access were unavailable. The monitor is using an automatically selected European VPN Gate relay, with only Przybysz traffic routed through the tunnel.'
