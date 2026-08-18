# Karta Pobytu Status Monitor

Automatically checks the **Przybysz** portal of the Dolnośląski Urząd Wojewódzki (Wrocław / Lower Silesia) and notifies you when the status of your residence-permit case changes.

The monitor runs in **GitHub Actions**, so your computer does not need to stay on.

> This project is unofficial and is not affiliated with the Dolnośląski Urząd Wojewódzki. It only automates the same authenticated status page that a user can normally check manually.

## What it does

- Logs in to `pio-przybysz.duw.pl` with Playwright.
- Opens **Wnioski przyjęte**.
- Finds the configured PIO case.
- Creates a keyed fingerprint of the relevant case block.
- Compares it with the previous run.
- Runs every day at **08:17 Europe/Warsaw**.
- Intentionally does **not** print your residence-case details to public GitHub Actions logs.
- On the first successful run, saves a baseline and does not notify.
- If the case changes later, the workflow intentionally fails so GitHub can send a failed-workflow notification.

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

### 2. Add the three secrets

In your fork, open:

**Settings → Secrets and variables → Actions → New repository secret**

Create:

| Secret | Value |
|---|---|
| `PIO_LOGIN` | Your Przybysz login/access code |
| `PIO_PASSWORD` | Your Przybysz password |
| `PIO_NUMBER` | The PIO number of the case you want to monitor |

Do not put these values in `README.md`, workflow files, issues, commits, or screenshots.

### 3. Enable GitHub Actions

Open the **Actions** tab in your fork and enable workflows if GitHub asks you to do so.

Then open **Karta pobytu status monitor** and click **Run workflow** once.

The first successful run establishes the baseline.

### 4. Turn on email notifications

GitHub can email you when a workflow fails. This monitor deliberately marks the workflow as failed when it detects a status change.

In GitHub, open:

**Settings → Notifications → System → Actions**

Choose **Email** and, if available, select **Only notify for failed workflows**.

This means:

- normal daily check with no change → no email;
- detected status change → failed workflow → GitHub email;
- technical/login/site error → failed workflow → GitHub email, so you also know the monitor needs attention.

GitHub's documentation notes that scheduled-workflow notifications are sent to the user associated with the schedule. In a fork, enabling the workflow yourself helps ensure the scheduled notifications belong to your account.

You can also receive GitHub notifications in the GitHub mobile app or web notification inbox depending on your GitHub notification settings.

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
2. **the monitor could not complete** because of login failure, portal downtime, or a Przybysz interface change.

Open the failed workflow. If the last failing step is **Status changed**, the monitor detected a real page change. If an earlier step failed, the automation itself needs attention.

## Portal compatibility

This project currently targets the Przybysz portal used by the **Dolnośląski Urząd Wojewódzki**. Other voivodeships may use different systems and are not automatically supported.

The scraper intentionally uses several fallback selectors because government portals can change their HTML without notice. If the login page or **Wnioski przyjęte** layout changes, please open an issue with a description of the failure. **Never include your password, PIO number, PESEL, passport number, or screenshots containing personal data in a public issue.**

## Schedule

The default schedule is:

```yaml
schedule:
  - cron: '17 8 * * *'
    timezone: 'Europe/Warsaw'
```

The unusual minute (`17`) is intentional. GitHub recommends avoiding the beginning of the hour because scheduled Actions jobs can be delayed during periods of high load.

GitHub may disable scheduled workflows in public repositories after a long period without repository activity. If that happens in your fork, open the **Actions** tab and re-enable the workflow.

## Local use

You can also run it locally:

```bash
npm install
npx playwright install chromium
PIO_LOGIN='...' PIO_PASSWORD='...' PIO_NUMBER='...' npm run check
```

The local state is stored under `.pio-state/` and is ignored by Git.

## Security notes

- Never commit portal credentials.
- Prefer a unique password for Przybysz.
- If you accidentally publish a credential, rotate it immediately.
- The monitor does not upload screenshots or HTML by default.
- The monitor does not send your credentials to any third-party notification provider.

## License

MIT
