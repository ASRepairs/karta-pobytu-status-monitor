#!/usr/bin/env python3
"""Connect only Przybysz traffic through a European VPN Gate relay.

This helper is intentionally zero-configuration. It fetches the current VPN Gate
server list from the University of Tsukuba endpoint, selects European OpenVPN
relays, and tries them until Przybysz is reachable. It does not receive or use
PIO credentials.
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

API_URL = "https://www.vpngate.net/api/iphone/"
TMP_DIR = Path("/tmp/kpsm-vpngate")
PID_FILE = TMP_DIR / "openvpn.pid"
LOG_FILE = TMP_DIR / "openvpn.log"
AUTH_FILE = TMP_DIR / "auth.txt"
CONFIG_FILE = TMP_DIR / "relay.ovpn"

# Prefer nearby/central European exits first, then broaden out. Russia is
# intentionally omitted: the portal only needs European reachability and there
# is no reason to route an authenticated government session there.
COUNTRY_PRIORITY = [
    "PL", "DE", "CZ", "NL", "AT", "SK", "LT", "LV", "EE", "DK", "SE",
    "FI", "BE", "FR", "LU", "IE", "GB", "CH", "NO", "SI", "HR", "HU",
    "RO", "BG", "GR", "IT", "ES", "PT", "MT", "CY", "IS", "LI", "RS",
    "BA", "ME", "MK", "AL", "MD", "UA",
]
EUROPE = set(COUNTRY_PRIORITY)

# Never allow a remotely supplied OpenVPN profile to execute local hooks or
# replace the runner's default route. VPN Gate publishes the profiles, but this
# defense-in-depth keeps the helper safe if malformed data ever appears.
DROP_DIRECTIVES = {
    "auth-user-pass",
    "auth-user-pass-verify",
    "cd",
    "chroot",
    "client-connect",
    "client-disconnect",
    "daemon",
    "down",
    "down-pre",
    "group",
    "ipchange",
    "learn-address",
    "log",
    "log-append",
    "management",
    "plugin",
    "pull-filter",
    "redirect-gateway",
    "route",
    "route-delay",
    "route-gateway",
    "route-ipv6",
    "route-nopull",
    "route-pre-down",
    "route-up",
    "script-security",
    "setenv-safe",
    "status",
    "tls-verify",
    "up",
    "up-delay",
    "user",
    "writepid",
}


def log(message: str) -> None:
    print(message, flush=True)


def fetch_servers() -> list[dict[str, str]]:
    request = urllib.request.Request(
        API_URL,
        headers={"User-Agent": "karta-pobytu-status-monitor/0.1"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        text = response.read().decode("utf-8-sig", errors="replace")

    rows = [line for line in text.splitlines() if line and not line.startswith("*")]
    if not rows or not rows[0].startswith("#HostName,"):
        raise RuntimeError("VPN Gate returned an unexpected server-list format")

    rows[0] = rows[0][1:]
    reader = csv.DictReader(io.StringIO("\n".join(rows)))
    servers = []
    for row in reader:
        country = (row.get("CountryShort") or "").upper().strip()
        config = row.get("OpenVPN_ConfigData_Base64") or ""
        if country not in EUROPE or not config:
            continue
        servers.append(row)

    def numeric(row: dict[str, str], key: str) -> int:
        try:
            return int(row.get(key) or 0)
        except ValueError:
            return 0

    priority = {country: i for i, country in enumerate(COUNTRY_PRIORITY)}
    # Quality first within a light geographic preference. We retry multiple
    # candidates, so one stale volunteer relay does not fail the workflow.
    servers.sort(
        key=lambda row: (
            priority.get((row.get("CountryShort") or "").upper(), 999),
            -numeric(row, "Score"),
            -numeric(row, "Speed"),
        )
    )
    return servers


def resolve_ipv4(host: str) -> list[str]:
    addresses: list[str] = []
    for info in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM):
        ip = info[4][0]
        if ip not in addresses:
            addresses.append(ip)
    if not addresses:
        raise RuntimeError(f"Could not resolve an IPv4 address for {host}")
    return addresses


def sanitize_config(raw: str, portal_ips: list[str]) -> str:
    output: list[str] = []
    inline_block: str | None = None

    for line in raw.replace("\r", "").splitlines():
        stripped = line.strip()
        lower = stripped.lower()

        if inline_block:
            output.append(line)
            if lower == f"</{inline_block}>":
                inline_block = None
            continue

        if stripped.startswith("<") and stripped.endswith(">") and not stripped.startswith("</"):
            tag = stripped[1:-1].split()[0].lower()
            inline_block = tag
            output.append(line)
            continue

        if not stripped or stripped.startswith("#") or stripped.startswith(";"):
            output.append(line)
            continue

        directive = stripped.split(None, 1)[0].lower()
        if directive in DROP_DIRECTIVES:
            continue
        output.append(line)

    output.extend(
        [
            "",
            "# Added by karta-pobytu-status-monitor",
            "script-security 1",
            "auth-user-pass /tmp/kpsm-vpngate/auth.txt",
            "auth-nocache",
            "route-nopull",
            'pull-filter ignore "redirect-gateway"',
        ]
    )
    for ip in portal_ips:
        output.append(f"route {ip} 255.255.255.255")
    output.append("")
    return "\n".join(output)


def stop_existing() -> None:
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
        except (ValueError, ProcessLookupError, PermissionError):
            pass
        for _ in range(20):
            try:
                os.kill(pid, 0)
            except (ProcessLookupError, UnboundLocalError):
                break
            time.sleep(0.25)
    PID_FILE.unlink(missing_ok=True)


def start_openvpn(config: str) -> bool:
    stop_existing()
    CONFIG_FILE.write_text(config, encoding="utf-8")
    CONFIG_FILE.chmod(0o600)
    LOG_FILE.unlink(missing_ok=True)

    command = [
        "openvpn",
        "--config",
        str(CONFIG_FILE),
        "--script-security",
        "1",
        "--daemon",
        "--writepid",
        str(PID_FILE),
        "--log",
        str(LOG_FILE),
    ]
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode != 0:
        return False

    for _ in range(45):
        if LOG_FILE.exists():
            text = LOG_FILE.read_text(encoding="utf-8", errors="replace")
            if "Initialization Sequence Completed" in text:
                return True
            if "AUTH_FAILED" in text or "Exiting due to fatal error" in text:
                return False
        time.sleep(1)
    return False


def portal_reachable(host: str, portal_ips: list[str]) -> bool:
    for ip in portal_ips:
        command = [
            "curl",
            "-A",
            "karta-pobytu-status-monitor/0.1",
            "-fsSL",
            "--connect-timeout",
            "10",
            "--max-time",
            "25",
            "--resolve",
            f"{host}:443:{ip}",
            "-o",
            "/dev/null",
            f"https://{host}/login",
        ]
        if subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--portal-host", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text("vpn\nvpn\n", encoding="utf-8")
    AUTH_FILE.chmod(0o600)

    portal_ips = resolve_ipv4(args.portal_host)
    servers = fetch_servers()
    if not servers:
        raise RuntimeError("VPN Gate currently lists no usable European OpenVPN relays")

    # Do not spend the entire Actions run chasing stale volunteer relays.
    candidates = servers[:12]
    log(f"Found {len(servers)} European VPN Gate OpenVPN relays; trying up to {len(candidates)}.")

    for index, server in enumerate(candidates, start=1):
        country = (server.get("CountryShort") or "??").upper()
        hostname = server.get("HostName") or "unknown"
        try:
            raw_config = base64.b64decode(
                server["OpenVPN_ConfigData_Base64"], validate=True
            ).decode("utf-8", errors="replace")
        except Exception:
            continue

        log(f"VPN Gate attempt {index}/{len(candidates)}: {country} relay {hostname}")
        config = sanitize_config(raw_config, portal_ips)
        if not start_openvpn(config):
            stop_existing()
            continue

        # The portal itself is the authoritative reachability check. PIO
        # credentials have not been loaded into this helper or this step.
        if portal_reachable(args.portal_host, portal_ips):
            log(f"European VPN route verified through {country}; Przybysz is reachable.")
            with open(args.output, "a", encoding="utf-8") as output:
                output.write("mode=vpngate\n")
                output.write(f"vpn_country={country}\n")
            return 0

        stop_existing()

    stop_existing()
    raise RuntimeError(
        "Direct access, Tor, and the available European VPN Gate relays could not reach Przybysz"
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Automatic European VPN fallback failed: {error}", file=sys.stderr)
        raise SystemExit(1)
