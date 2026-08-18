# Karta Pobytu Status Monitor

Automatically checks the **Przybysz** portal of the Dolnośląski Urząd Wojewódzki (Wrocław / Lower Silesia) and notifies you when the status of your residence-permit case changes.

The monitor runs in **GitHub Actions**, so your computer does not need to stay on. Przybysz is geographically restricted to European access, but **users do not need to configure a VPN account, proxy, VPS, or self-hosted runner**. The workflow automatically finds a working European route before it exposes any Przybysz credentials.

> This project is unofficial and is not affiliated with the Dolnośląski Urząd Wojewódzki. It only automates the same authenticated status page that a user can normally check manually.

## What it does

- Runs on GitHub's `ubuntu-24.04` hosted runner.
- Automatically prepares a route that can reach the Europe-restricted Przybysz portal.
- Logs in to `pio-przybysz.duw.pl` with Playwright.
- Opens **Wnioski przyjęte**.
- Finds the configured PIO case.
- Creates a keyed fingerprint of the relevant case block.
- Compares it with the previous run.
- Runs every day at **13:55 Europe/Warsaw**.
- Uses **Node.js 24** and Node-24-compatible GitHub Actions.
- Intentionally does **not** print your residence-case details to public GitHub Actions logs.
- On the first successful run, saves a baseline and does not notify.
- If the case changes later, the workflow intentionally fails. GitHub records that failed run and may surface a notification according to the GitHub account's notification preferences.

## Zero-configuration European routing

GitHub-hosted runners are not guaranteed to exit in Europe. The workflow therefore prepares connectivity **before the step that receives `PIO_LOGIN`, `PIO_PASSWORD`, or `PIO_NUMBER`**.

It tries the following routes automatically, in order:

1. **Direct GitHub runner** — if Przybysz is already reachable, nothing else is used.
2. **European Tor exit** — the workflow starts a local Tor client, requests European exit nodes, and tests Przybysz through Tor. If it works, only the Playwright browser is sent through Tor.
3. **European VPN Gate relay** — if both previous routes fail, the workflow downloads the current public VPN Gate server list from the University of Tsukuba, selects European OpenVPN relays, and retries them automatically.

The VPN Gate fallback does **not** replace the whole GitHub runner's default route. It adds routes only for the resolved Przybysz server addresses, so ordinary GitHub/Actions traffic stays on the runner's normal network.

If none of those routes can reach Przybysz, the workflow fails before the portal credentials are used.

### Optional trusted-proxy override

The automatic route requires no additional setup. Advanced users who do not want to use Tor or VPN Gate can instead provide their own trusted proxy with these optional repository secrets:

- `PIO_PROXY_SERVER`
- `PIO_PROXY_USERNAME` — optional
- `PIO_PROXY_PASSWORD` — optional

A configured proxy is tested first and takes priority when it works.

## Privacy and relay warning

This repository can be public, but your credentials and PIO number must **never** be committed to it.

The workflow expects these three required GitHub Actions repository secrets:

- `PIO_LOGIN`
- `PIO_PASSWORD`
- `PIO_NUMBER`

The automatic Tor and VPN Gate fallbacks use public volunteer-operated relay infrastructure. Przybysz itself is accessed over HTTPS with normal certificate validation, so the relay is not given your portal password or readable HTTPS page contents. However, a relay can observe network metadata such as connection timing and the destination, and VPN Gate relays may have their own logging policies.

If you do not want an authenticated government session to traverse public relay infrastructure, configure a trusted European `PIO_PROXY_SERVER` instead or run the monitor locally from Europe.

The saved comparison state is a keyed HMAC fingerprint, not the readable case status. The password is used as the HMAC key, so if you change your Przybysz password, the next successful run may report one status change because the fingerprint key changed.

GitHub Actions caches should never be treated as a place for raw secrets. This project therefore stores only the keyed fingerprint there, not page HTML, screenshots, passwords, PIO numbers, or readable case text.

## Setup

### 1. Fork this repository

Click **Fork** on GitHub and create your own copy.

### 2. Add the three required secrets

In your fork, open:

**Settings → Secrets and variables → Actions → New repository secret**

Create:

| Secret | Value |
|---|---|
| `PIO_LOGIN` | Your Przybysz login/access code |
| `PIO_PASSWORD` | Your Przybysz password |
| `PIO_NUMBER` | The PIO number of the case you want to monitor |

Do not put these values in `README.md`, workflow files, issues, commits, or screenshots.

**No VPN, proxy, Tor, server, or runner configuration is required.**

### 3. Enable GitHub Actions and run once

Open the **Actions** tab in your fork and enable workflows if GitHub asks you to do so.

Then open **Karta pobytu status monitor** and click **Run workflow** once.

The first successful run establishes the baseline. Later runs compare the current case block with that baseline.

### 4. Notifications

When the monitor detects a case change, it deliberately marks that workflow run as **failed**. This gives GitHub a clear failure event that can be surfaced through GitHub's normal Actions notifications.

GitHub controls delivery of those notifications at the **account level**, not in this repository. Depending on your GitHub notification preferences, a failed Actions run may appear by email, on GitHub, or in GitHub Mobile.

GitHub does **not** guarantee that Actions email notifications are enabled for every account, so this project does not assume that every user will receive an email automatically.

The monitor itself does not send email and does not require an email-service API key.

## How to check a notification

The notification intentionally does not expose the new case status. When you receive one:

1. Log in to Przybysz normally.
2. Open **Wnioski przyjęte**.
3. Read the new status/message directly from the official portal.

This is deliberate because forks of this repository can be public.

## Manual check

You can run the monitor at any time:

**Actions → Karta pobytu status monitor → Run workflow**

A manual successful run updates the baseline in the same way as a scheduled run.

## What a failed run means

A failed run can mean either:

1. **the case changed**, or
2. **the monitor could not complete** because of login failure, portal downtime, an interface change, or because none of the automatic European routes could reach Przybysz.

Open the failed workflow. If the last failing step is **Status changed**, the monitor detected a real page change. If **Prepare European egress** failed, the workflow exhausted direct, Tor, and VPN Gate connectivity before PIO credentials were exposed. If **Check Przybysz** failed, inspect that step for the login/portal error.

## How the VPN Gate fallback is constrained

VPN Gate publishes current OpenVPN configuration data for its public relay network. The helper:

- filters the live list to European countries;
- tries multiple candidates because volunteer relays can disappear;
- strips OpenVPN directives that could execute hooks or replace the runner's default route;
- forces OpenVPN `script-security 1`;
- uses `route-nopull`;
- adds `/32` routes only for the currently resolved Przybysz IPv4 addresses;
- verifies that Przybysz is reachable before the monitor step receives PIO credentials.

This is a last-resort fallback, not a claim that a public VPN relay is as private as a VPN server you control.

## Portal connectivity

The monitor also retries transient Chromium errors and independently resolves portal IPv4 addresses when necessary. Those retries help with stale DNS/routing problems; the automatic European-route layer handles the geographic restriction.

## Portal compatibility

This project currently targets the Przybysz portal used by the **Dolnośląski Urząd Wojewódzki**. Other voivodeships may use different systems and are not automatically supported.

The scraper intentionally uses several fallback selectors because government portals can change their HTML without notice. If the login page or **Wnioski przyjęte** layout changes, please open an issue with a description of the failure. **Never include your password, PIO number, PESEL, passport number, or screenshots containing personal data in a public issue.**

## Schedule

The default schedule is:

```yaml
schedule:
  - cron: '55 13 * * *'
    timezone: 'Europe/Warsaw'
```

The minute (`55`) is intentionally away from the beginning of the hour because scheduled Actions jobs can be delayed during periods of high load.

GitHub may disable scheduled workflows in public repositories after a long period without repository activity. If that happens in your fork, open the **Actions** tab and re-enable the workflow.

## Local use

If your own computer is already in Europe, you can run the monitor directly with Node.js 24:

```bash
npm install
npx playwright install chromium
PIO_LOGIN='...' PIO_PASSWORD='...' PIO_NUMBER='...' npm run check
```

If you want to use your own proxy locally:

```bash
PIO_PROXY_SERVER='http://eu-proxy.example:3128' \
PIO_PROXY_USERNAME='...' \
PIO_PROXY_PASSWORD='...' \
PIO_LOGIN='...' \
PIO_PASSWORD='...' \
PIO_NUMBER='...' \
npm run check
```

The local state is stored under `.pio-state/` and is ignored by Git.

## Security notes

- Never commit portal credentials.
- Prefer a unique password for Przybysz.
- If you accidentally publish a credential, rotate it immediately.
- PIO credentials are not provided to the automatic egress-preparation step.
- The monitor does not upload screenshots or HTML by default.
- HTTPS certificate validation remains enabled.
- Public Tor/VPN Gate relays should be treated as untrusted networks; use your own trusted proxy if that distinction matters to you.

## License

MIT
