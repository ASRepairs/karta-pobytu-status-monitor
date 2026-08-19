# Karta Pobytu Status Monitor

Automatically checks the **Przybysz** portal of the Dolnośląski Urząd Wojewódzki and detects changes to the explicit status/stage of a residence-permit case.

The monitor runs in **GitHub Actions**, so your computer does not need to stay on. Przybysz is geographically restricted to European access, so the default workflow automatically prepares a European route before portal credentials are used. If no usable route is temporarily available, the check is skipped rather than being reported as a failed workflow.

> This project is unofficial and is not affiliated with the Dolnośląski Urząd Wojewódzki. It automates the same authenticated portal that a user can check manually.

## What it does

- Runs every day at **13:55 Europe/Warsaw**.
- Automatically prepares European connectivity when direct GitHub-runner access is rejected.
- Retries transient European-relay shortages with fresh Tor/VPN Gate selections.
- If no European route works after the retry rounds, records a neutral **skipped check** and leaves the workflow successful so relay availability cannot create a false status-change alarm.
- Logs in to `pio-przybysz.duw.pl` with Playwright.
- Opens **Wnioski przyjęte**.
- Finds the configured PIO case and follows its `/szczegoly-wniosku/...` details link.
- Reads the explicit **Etap realizacji** row from the application's details table.
- Refuses to save a baseline if it cannot positively identify the configured case and its explicit status field.
- Stores only a keyed HMAC fingerprint of the normalized status value.
- Compares that explicit status value on future runs.
- Does **not** print the readable status, PIO number, password, or authenticated page contents to public Actions logs.
- Deliberately fails the workflow when a verified status change is detected so GitHub can surface a failed-run notification according to the user's GitHub notification settings.

## Zero-configuration European routing

The workflow prepares connectivity **before** the step that receives `PIO_LOGIN`, `PIO_PASSWORD`, or `PIO_NUMBER`.

It tries, in order:

1. **Direct GitHub runner access**.
2. **European Tor exit** if direct access fails.
3. **European VPN Gate/OpenVPN relay** if Tor fails.

Because public relays are transient, the automatic fallback performs multiple rounds. Each round starts a fresh Tor circuit and re-fetches VPN Gate's live European relay list. The default is **3 rounds**, with a short delay between failed rounds.

If none of those routes can reach Przybysz after the retries, the workflow sets the egress result to unavailable, skips the authenticated monitor steps, leaves the existing status fingerprint untouched, and finishes successfully. **No status conclusion is made on a skipped run.**

No VPN account, VPS, proxy, or self-hosted runner is required for the default setup.

A trusted private proxy can optionally override the automatic routing with:

- `PIO_PROXY_SERVER`
- `PIO_PROXY_USERNAME` — optional
- `PIO_PROXY_PASSWORD` — optional

Do **not** use random public proxies for an authenticated government portal.

### Privacy trade-off

Tor and VPN Gate are public relay infrastructure. Przybysz is still accessed over HTTPS with normal certificate validation, so the relay does not receive the readable portal password or HTTPS page contents, but it can observe connection metadata. If that distinction matters to you, configure your own trusted European proxy or run the monitor locally from Europe.

## Setup

### 1. Fork this repository

Click **Fork** and create your own copy.

### 2. Add the required secrets

Open:

**Settings → Secrets and variables → Actions → New repository secret**

Create:

| Secret | Value |
|---|---|
| `PIO_LOGIN` | Your Przybysz login/access code |
| `PIO_PASSWORD` | Your Przybysz password |
| `PIO_NUMBER` | The PIO number of the case you want to monitor |

Never put these values in commits, issues, screenshots, workflow files, or this README.

### 3. Enable GitHub Actions and run once

Open **Actions → Karta pobytu status monitor → Run workflow**.

A successful strict run prints structural confirmation only, for example:

```text
Authenticated portal shell detected.
Opening accepted applications…
Opening configured case details…
Configured PIO link found: yes
Case found: yes
PIO matched exactly: yes
Details view opened: yes
Status field found: Etap realizacji
Status fingerprint saved: yes
```

The readable status itself is intentionally not printed.

The first successful strict run creates the baseline. If the workflow cannot obtain a European route, that run is merely skipped and does **not** create or replace the baseline.

## One-time strict verification

If you want to prove that the scraper extracted the **same literal status you see manually in Przybysz**, create one temporary repository secret:

`PIO_EXPECTED_STATUS`

Set it to the exact current status/stage shown in the portal, then manually run the workflow once.

The monitor normalizes whitespace/case and compares the expected value with the extracted explicit status **without printing either value**.

Successful verification prints:

```text
Expected status match: yes
```

and the job summary confirms that extraction was independently verified.

If the values do not match, the workflow fails with a strict-verification error. Verification happens before the state is written, so a parser mistake cannot replace the trusted baseline.

Delete `PIO_EXPECTED_STATUS` after successful validation. It is not required for normal daily monitoring.

## What is stored

The private Actions cache contains only a structure similar to:

```json
{
  "version": 2,
  "statusFingerprint": "<keyed HMAC>"
}
```

It does not store readable page HTML, screenshots, the PIO number, or the readable status.

Because the fingerprint is keyed using the Przybysz password, changing that password changes the fingerprint key.

A skipped connectivity run does not save a new cache state and therefore cannot alter the last known fingerprint.

## Notifications

When an explicit status change is detected, the monitor intentionally marks that run as **failed**. GitHub may surface the failed run through email, GitHub notifications, or GitHub Mobile according to the account's notification preferences.

The project itself does **not** send email and does not assume that email notifications are enabled for every account.

A temporary inability to obtain European egress is **not** treated as a failure. After the automatic retry rounds, the check is skipped and the workflow stays green because lack of a working relay says nothing about the case status.

A failed run can still mean:

- the verified case status changed; or
- after a usable route was established, the monitor encountered a genuine authentication, portal-layout, or other technical error.

If the last failing step is **Status changed**, a verified explicit-status change was detected. If an earlier authenticated-monitor step failed, inspect that step instead.

## How the VPN Gate fallback is constrained

The automatic VPN Gate helper:

- filters the live relay list to European countries;
- tries multiple candidates because volunteer relays can disappear;
- is invoked again on later automatic rounds so the live relay list is refreshed;
- strips OpenVPN directives that could execute hooks or replace the runner's default route;
- forces `script-security 1`;
- uses `route-nopull`;
- adds `/32` routes only for the currently resolved Przybysz IPv4 addresses;
- verifies that Przybysz is reachable before the monitor step receives PIO credentials.

This is a last-resort connectivity fallback, not a claim that a volunteer VPN relay is equivalent to a private VPN you control.

## Portal compatibility

This project currently targets the Przybysz portal used by the **Dolnośląski Urząd Wojewódzki**. Other voivodeships may use different systems.

The scraper deliberately **fails closed on status extraction**: if it cannot identify both the configured case and its explicit status field after authenticated access succeeds, it does not silently treat nearby text as a valid status.

European egress availability is handled differently: an inability to obtain a route after retries is treated as a **neutral skipped check**, because failing the workflow for that condition could look like a status-change notification even though the case was never checked.

If the portal changes, open an issue describing the failure, but **never post passwords, PIO numbers, PESEL numbers, passport details, or authenticated screenshots** in a public issue.

## Schedule

The default schedule is:

```yaml
schedule:
  - cron: '55 13 * * *'
    timezone: 'Europe/Warsaw'
```

GitHub can delay scheduled jobs during periods of high load. Public-repository scheduled workflows may also be disabled by GitHub after a long period without repository activity; if that happens in a fork, re-enable the workflow from the **Actions** tab.

## Local use

Node.js 24 is recommended.

```bash
npm install
npx playwright install chromium
PIO_LOGIN='...' PIO_PASSWORD='...' PIO_NUMBER='...' npm run check
```

For a one-time strict local verification:

```bash
PIO_EXPECTED_STATUS='the status you currently see' \
PIO_LOGIN='...' \
PIO_PASSWORD='...' \
PIO_NUMBER='...' \
npm run check
```

Local state is stored under `.pio-state/` and is ignored by Git.

## Security notes

- Never commit portal credentials.
- Prefer a unique password for Przybysz.
- Rotate a credential immediately if it is exposed.
- PIO credentials are not provided to the automatic egress-preparation step.
- Authenticated page contents are not intentionally logged.
- The monitor does not upload screenshots or HTML by default.
- HTTPS certificate validation remains enabled.

## License

MIT
