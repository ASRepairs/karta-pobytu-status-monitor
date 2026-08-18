import { chromium } from 'playwright';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.PIO_BASE_URL || 'https://pio-przybysz.duw.pl').replace(/\/$/, '');
const LOGIN = process.env.PIO_LOGIN;
const PASSWORD = process.env.PIO_PASSWORD;
const PIO_NUMBER = process.env.PIO_NUMBER;
const EXPECTED_STATUS = process.env.PIO_EXPECTED_STATUS || '';
const STATE_DIR = process.env.PIO_STATE_DIR || '.pio-state';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const RESULT_FILE = path.join(STATE_DIR, 'result.json');
const PORTAL_HOST = new URL(BASE_URL).hostname;

const PROXY_SERVER = process.env.PIO_PROXY_SERVER || '';
const PROXY_USERNAME = process.env.PIO_PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PIO_PROXY_PASSWORD || '';

for (const [name, value] of Object.entries({ PIO_LOGIN: LOGIN, PIO_PASSWORD: PASSWORD, PIO_NUMBER })) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

fs.mkdirSync(STATE_DIR, { recursive: true });

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function normalizeComparableStatus(value) {
  return normalizeText(value).toLocaleLowerCase('pl-PL');
}

function fingerprintStatus(value) {
  return crypto.createHmac('sha256', PASSWORD).update(value, 'utf8').digest('hex');
}

function isNetworkError(error) {
  const text = String(error?.message || error);
  return error?.name === 'TimeoutError'
    || /Timeout\s+\d+ms\s+exceeded/i.test(text)
    || /ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED)/i.test(text);
}

async function resolveCandidateIpv4s(hostname) {
  const addresses = new Set();

  try {
    for (const address of await dns.resolve4(hostname)) addresses.add(address);
  } catch (error) {
    console.log(`System DNS lookup failed: ${error.code || error.message}`);
  }

  try {
    const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const payload = await response.json();
      for (const answer of payload.Answer || []) {
        if (answer.type === 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(answer.data)) addresses.add(answer.data);
      }
    }
  } catch (error) {
    console.log(`Public DNS fallback failed: ${error.message}`);
  }

  return [...addresses];
}

function launchOptions(forcedIpv4 = null) {
  const args = ['--disable-dev-shm-usage'];
  if (forcedIpv4) args.push(`--host-resolver-rules=MAP ${PORTAL_HOST} ${forcedIpv4},EXCLUDE localhost`);

  const options = { headless: true, args };
  if (PROXY_SERVER) {
    options.proxy = {
      server: PROXY_SERVER,
      ...(PROXY_USERNAME ? { username: PROXY_USERNAME } : {}),
      ...(PROXY_PASSWORD ? { password: PROXY_PASSWORD } : {}),
    };
  }
  return options;
}

async function createPage(forcedIpv4 = null) {
  const browser = await chromium.launch(launchOptions(forcedIpv4));
  const context = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1280, height: 1200 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return { browser, page };
}

async function gotoWithRetry(page, url, attempts = PROXY_SERVER ? 4 : 3) {
  let lastError;
  const navigationTimeout = PROXY_SERVER ? 60000 : 45000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeout });
    } catch (error) {
      lastError = error;
      if (!isNetworkError(error) || attempt === attempts) throw error;
      console.log(`Portal navigation attempt ${attempt}/${attempts} timed out or failed transiently; retrying…`);
      try { await page.goto('about:blank', { waitUntil: 'commit', timeout: 5000 }); } catch {}
      await page.waitForTimeout(Math.min(6000, attempt * 2000));
    }
  }

  throw lastError;
}

async function openPortalSession() {
  const candidateIps = await resolveCandidateIpv4s(PORTAL_HOST);
  const routes = [null, ...candidateIps];
  let lastError;

  for (const forcedIpv4 of routes) {
    const session = await createPage(forcedIpv4);
    try {
      if (forcedIpv4) console.log('Retrying Przybysz with an independently resolved IPv4 route…');
      await gotoWithRetry(session.page, `${BASE_URL}/login`);
      return session;
    } catch (error) {
      lastError = error;
      await session.browser.close();
      if (!isNetworkError(error)) throw error;
    }
  }

  const hint = PROXY_SERVER
    ? 'The configured relay/proxy also could not reach the portal reliably.'
    : 'No usable route to Przybysz was available.';
  throw new Error(`Could not connect to ${PORTAL_HOST}. ${hint}\nLast error: ${lastError?.message || lastError}`);
}

async function firstVisible(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (!(await locator.count())) continue;
    try {
      if (await locator.isVisible({ timeout: 700 })) return locator;
    } catch {}
  }
  return null;
}

const LOGIN_SELECTORS = [
  'input[name="login"]',
  'input[name="username"]',
  'input[name*="login" i]',
  'input[name*="user" i]',
  'input[id*="login" i]',
  'input[id*="user" i]',
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[type="tel"]',
  'input[type="text"]',
  'input[type="number"]',
];

const PASSWORD_SELECTORS = [
  'input[name="password"]',
  'input[name*="pass" i]',
  'input[id*="password" i]',
  'input[id*="pass" i]',
  'input[autocomplete="current-password"]',
  'input[type="password"]',
];

async function findLoginForm(page) {
  for (const frame of page.frames()) {
    const passwordInput = await firstVisible(frame, PASSWORD_SELECTORS);
    if (!passwordInput) continue;

    const loginInput = await firstVisible(frame, [
      ...LOGIN_SELECTORS,
      'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])',
    ]);
    if (loginInput) return { frame, loginInput, passwordInput };
  }
  return null;
}

async function safePublicPageDiagnostics(page) {
  let title = '';
  try { title = await page.title(); } catch {}
  console.log('--- Safe pre-login diagnostics (public page only) ---');
  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${title}`);
  console.log('--- End diagnostics ---');
}

async function fillLogin(page) {
  let form = null;
  for (let i = 0; i < 20 && !form; i += 1) {
    form = await findLoginForm(page);
    if (!form) await page.waitForTimeout(500);
  }

  if (!form) {
    await safePublicPageDiagnostics(page);
    throw new Error('Could not identify the Przybysz login form.');
  }

  await form.loginInput.fill(LOGIN);
  await form.passwordInput.fill(PASSWORD);

  let submit = form.frame.getByRole('button', { name: /zaloguj|login|sign in/i }).first();
  if (!(await submit.count())) submit = form.frame.locator('button[type="submit"], input[type="submit"]').first();

  if (await submit.count()) await submit.click();
  else await form.passwordInput.press('Enter');

  await page.waitForTimeout(1800);
}

async function openAcceptedApplications(page) {
  // Prefer the canonical route. The portal is an Angular SPA, so the route may
  // render before all application rows have arrived; the next step waits for the
  // configured PIO explicitly.
  await gotoWithRetry(page, `${BASE_URL}/wnioski-przyjete`);

  const currentUrl = new URL(page.url());
  if (/\/login(?:$|[/?#])/.test(currentUrl.pathname + currentUrl.search)) {
    throw new Error('Login did not succeed. Check PIO_LOGIN and PIO_PASSWORD.');
  }
}

async function waitForExactPio(page, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const exact = page.getByText(PIO_NUMBER, { exact: true }).first();
    try {
      if ((await exact.count()) && (await exact.isVisible({ timeout: 300 }))) return exact;
    } catch {}
    await page.waitForTimeout(500);
  }
  return null;
}

async function openConfiguredCaseDetails(page) {
  console.log('Opening configured case details…');
  const pio = await waitForExactPio(page);
  if (!pio) {
    throw new Error('The configured PIO number was not found in Wnioski przyjęte.');
  }

  const beforeUrl = page.url();

  // The current Przybysz UI makes the application number itself the entry point
  // to the details view. Depending on Angular's template, the number can be an
  // <a>, a child of an <a>, or text inside a row carrying the click handler.
  const link = pio.locator('xpath=ancestor-or-self::a[1]');
  if (await link.count()) {
    await link.click();
  } else {
    await pio.click();
  }

  const details = page.locator('app-applications-details').first();
  try {
    await details.waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    // If Angular changed the custom-element visibility semantics, accept a route
    // change only when the details table is actually present.
    if (page.url() === beforeUrl || !(await page.locator('app-applications-details table').count())) {
      throw new Error('The PIO was found, but clicking it did not open the application details view.');
    }
  }

  await page.locator('app-applications-details table').first().waitFor({ state: 'visible', timeout: 15000 });
}

async function extractStatusFromDetailsTable(page) {
  const details = page.locator('app-applications-details').first();
  if (!(await details.count())) {
    throw new Error('Application details component was not found after opening the configured PIO.');
  }

  const detailText = normalizeText(await details.innerText());
  if (!detailText.includes(PIO_NUMBER)) {
    throw new Error('The opened details view does not contain the configured PIO number. Refusing to monitor the wrong case.');
  }

  const rows = details.locator('table tbody tr, table tr');
  const rowCount = await rows.count();

  for (let i = 0; i < rowCount; i += 1) {
    const row = rows.nth(i);
    const cells = row.locator('td');
    if ((await cells.count()) < 2) continue;

    const label = normalizeText(await cells.nth(0).innerText()).replace(/:\s*$/, '').trim();
    if (!/^Etap\s+realizacji$/i.test(label)) continue;

    const value = normalizeText(await cells.nth(1).innerText());
    if (!value) throw new Error('Etap realizacji was found, but its value is empty.');

    return { field: 'Etap realizacji', value };
  }

  // Exact fallback for the DOM structure currently used by Przybysz:
  // <tr><td><span translate>Etap realizacji</span>:</td><td>VALUE</td></tr>
  const labelSpan = details.locator('table tr td span[translate]').filter({ hasText: /^Etap\s+realizacji$/i }).first();
  if (await labelSpan.count()) {
    const row = labelSpan.locator('xpath=ancestor::tr[1]');
    const cells = row.locator('td');
    if ((await cells.count()) >= 2) {
      const value = normalizeText(await cells.nth(1).innerText());
      if (value) return { field: 'Etap realizacji', value };
    }
  }

  throw new Error('The configured case details were opened, but the Etap realizacji row could not be read from its table.');
}

function readPreviousStatusFingerprint() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (parsed.version !== 2) return null;
    return typeof parsed.statusFingerprint === 'string' ? parsed.statusFingerprint : null;
  } catch {
    return null;
  }
}

function writeResult({ outcome, statusFingerprint, expectedStatusChecked, expectedStatusMatch }) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ version: 2, statusFingerprint }, null, 2) + '\n',
    'utf8',
  );

  fs.writeFileSync(
    RESULT_FILE,
    JSON.stringify({
      version: 2,
      outcome,
      case_found: true,
      pio_matched: true,
      pio_matched_exactly: true,
      details_view_opened: true,
      status_field_found: true,
      status_fingerprint_saved: true,
      status_field: 'Etap realizacji',
      expected_status_checked: expectedStatusChecked,
      expected_status_match: expectedStatusChecked ? expectedStatusMatch : null,
    }, null, 2) + '\n',
    'utf8',
  );
}

console.log('Opening Przybysz…');
const { browser, page } = await openPortalSession();

try {
  await fillLogin(page);

  console.log('Opening accepted applications…');
  await openAcceptedApplications(page);
  await openConfiguredCaseDetails(page);

  const { field: statusField, value: statusValue } = await extractStatusFromDetailsTable(page);
  const normalizedStatus = normalizeComparableStatus(statusValue);
  if (!normalizedStatus) throw new Error('Etap realizacji was found but normalized to an empty value.');

  const currentFingerprint = fingerprintStatus(normalizedStatus);
  const previousFingerprint = readPreviousStatusFingerprint();
  const outcome = previousFingerprint === null
    ? 'baseline'
    : previousFingerprint === currentFingerprint
      ? 'unchanged'
      : 'changed';

  const expectedStatusChecked = Boolean(EXPECTED_STATUS);
  const expectedStatusMatch = expectedStatusChecked
    ? normalizeComparableStatus(EXPECTED_STATUS) === normalizedStatus
    : false;

  // Verification happens before state is persisted. A wrong parser or wrong
  // expected value therefore cannot replace the trusted baseline.
  if (expectedStatusChecked && !expectedStatusMatch) {
    console.log('Case found: yes');
    console.log('PIO matched exactly: yes');
    console.log('Details view opened: yes');
    console.log(`Status field found: ${statusField}`);
    console.log('Expected status match: no');
    throw new Error('Strict verification failed: the extracted Etap realizacji value does not match PIO_EXPECTED_STATUS. No readable status was printed.');
  }

  writeResult({
    outcome,
    statusFingerprint: currentFingerprint,
    expectedStatusChecked,
    expectedStatusMatch,
  });

  console.log('Case found: yes');
  console.log('PIO matched exactly: yes');
  console.log('Details view opened: yes');
  console.log(`Status field found: ${statusField}`);
  console.log('Status fingerprint saved: yes');
  if (expectedStatusChecked) console.log('Expected status match: yes');

  if (outcome === 'baseline') console.log('Strict status baseline saved. Future checks will compare Etap realizacji only.');
  if (outcome === 'unchanged') console.log('No explicit case status change detected.');
  if (outcome === 'changed') console.log('Explicit case status change detected.');
} finally {
  await browser.close();
}
