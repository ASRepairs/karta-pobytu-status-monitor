# Karta Pobytu Status Monitor

Automatically checks the **Przybysz** portal of the Dolnośląski Urząd Wojewódzki (Wrocław / Lower Silesia) and notifies you when the status of your residence-permit case changes.

The monitor is designed to run from **GitHub Actions**, but there is one important networking requirement: **Przybysz is geographically restricted to European access**. A normal GitHub-hosted runner does not guarantee European internet egress, so reliable cloud monitoring requires either a trusted European proxy or a self-hosted GitHub runner located in Europe.

> This project is unofficial and is not affiliated with the Dolnośląski Urząd Wojewódzki. It only automates the same authenticated status page that a user can normally check manually.

## What it does

- Logs in to `pio-przybysz.duw.pl` with Playwright.
- Opens **Wnioski przyjęte**.
- Finds the configured PIO case.
- Creates a keyed fingerprint of the relevant case block.
- Compares it with the previous run.
- Runs every day at **13:55 Europe/Warsaw**.
- Uses **Node.js 24** and Node-24-compatible GitHub Actions.
- Retries transient portal failures and stale DNS/IPv4 routing problems.
- Intentionally does **not** print your residence-case details to public GitHub Actions logs.
- On the first successful run, saves a baseline and does not notify.
- If the case changes later, the workflow intentionally fails. GitHub records that failed run and may send an email/web notification according to the GitHub account's Actions notification preferences.

## Important: European network access is required

Przybysz only accepts access from Europe. Switching between Ubuntu and macOS GitHub-hosted runners does **not** solve that reliably because the hosted runner's public egress location is not something this workflow can pin to Europe.

You therefore have three ways to run the monitor:

### Option A — trusted European proxy

Keep the default GitHub-hosted runner and add these repository secrets:

- `PIO_PROXY_SERVER` — address of a proxy whose exit node is in Europe, for example `http://proxy.example:3128`;
- `PIO_PROXY_USERNAME` — optional;
- `PIO_PROXY_PASSWORD` — optional.

The monitor passes the proxy directly to Playwright. Do **not** use random/free public proxies for an authenticated government portal.

### Option B — self-hosted runner in Europe

Run a GitHub Actions self-hosted runner on a computer, server, Raspberry Pi, NAS, or VPS physically/network-wise located in Europe.

Then create this repository variable:

**Settings → Secrets and variables → Actions → Variables → New repository variable**

| Variable | Value |
|---|---|
| `PIO_RUNNER` | The label of your European self-hosted runner, for example `self-hosted` |

The workflow uses `PIO_RUNNER` when present and otherwise falls back to `ubuntu-24.04`.

Because this repository is public, be careful with self-hosted runners: do not add workflows that automatically execute untrusted pull-request code on that runner.

### Option C — run locally

The monitor can also be run directly on a computer in Europe using Node.js 24. This avoids GitHub's runner-location issue entirely, but you must schedule it yourself with cron, Task Scheduler, systemd, etc.

## Privacy

This repository is public, but your credentials and PIO number must **never** be committed to it.

The workflow expects them as GitHub Actions repository secrets:

- `PIO_LOGIN`
- `PIO_PASSWORD`
- `PIO_NUMBER`

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

### 3. Configure European egress

Choose either the **European proxy** or **European self-hosted runner** method described above.

A plain GitHub-hosted runner may return `ERR_CONNECTION_REFUSED` simply because its egress is outside Europe. That happens before authentication and does not mean your Przybysz credentials are wrong.

### 4. Enable GitHub Actions

Open the **Actions** tab in your fork and enable workflows if GitHub asks you to do so.

Then open **Karta pobytu status monitor** and click **Run workflow** once.

The first successful run establishes the baseline.

### 5. Notifications

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
2. **the monitor could not complete** because of login failure, portal downtime, geographic/network restriction, or a Przybysz interface change.

Open the failed workflow. If the last failing step is **Status changed**, the monitor detected a real page change. If an earlier step failed, the automation itself needs attention.

A failure such as:

```text
net::ERR_CONNECTION_REFUSED at https://pio-przybysz.duw.pl/login
```

before the login form appears is a network/egress problem, not a password failure. Make sure the runner or proxy exits in Europe.

## Portal connectivity

The monitor:

1. retries transient Chromium network errors;
2. resolves the portal independently and retries through IPv4 while keeping the original HTTPS hostname, SNI, and certificate validation;
3. reports a specific European-egress hint if the portal still cannot be reached.

The IPv4 retry only helps DNS/routing issues. It **cannot bypass a geographic access restriction**.

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

You can run it locally with Node.js 24:

```bash
npm install
npx playwright install chromium
PIO_LOGIN='...' PIO_PASSWORD='...' PIO_NUMBER='...' npm run check
```

If you need a proxy locally:

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
- The monitor does not upload screenshots or HTML by default.
- The monitor does not send your credentials to any third-party notification provider unless **you explicitly configure your own proxy**.
- A self-hosted runner attached to a public repository must not be exposed to workflows that execute untrusted pull-request code.

## License

MIT
