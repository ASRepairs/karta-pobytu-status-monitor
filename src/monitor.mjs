import { chromium } from 'playwright';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.PIO_BASE_URL || 'https://pio-przybysz.duw.pl').replace(/\/$/, '');
const LOGIN = process.env.PIO_LOGIN;
const PASSWORD = process.env.PIO_PASSWORD;
const PIO_NUMBER = process.env.PIO_NUMBER;
const STATE_DIR = process.env.PIO_STATE_DIR || '.pio-state';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const RESULT_FILE = path.join(STATE_DIR, 'result.json');
const PORTAL_HOST = new URL(BASE_URL).hostname;

const PROXY_SERVER = process.env.PIO_PROXY_SERVER || '';
const PROXY_USERNAME = process.env.PIO_PROXY_USERNAME || '';
const PROXY_PASSWORD = process.env.PIO_PROXY_PASSWORD || '';

for (const [name, value] of Object.entries({ PIO_LOGIN: LOGIN, PIO_PASSWORD: PASSWORD, PIO_NUMBER })) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

fs.mkdirSync(STATE_DIR, { recursive: true });

function normalizeText(value) {
  return value
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function fingerprint(value) {
  // Use a keyed digest so a public/cache-visible state cannot be dictionary-attacked
  // against the relatively small set of possible Polish case status strings.
  return crypto.createHmac('sha256', PASSWORD).update(value, 'utf8').digest('hex');
}

function isNetworkError(error) {
  const text = String(error?.message || error);
  return /ERR_(CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED)/i.test(text);
}

async function resolveCandidateIpv4s(hostname) {
  const addresses = new Set();

  try {
    for (const address of await dns.resolve4(hostname)) addresses.add(address);
  } catch (error) {
    console.log(`System DNS lookup failed: ${error.code || error.message}`);
  }

  // GitHub-hosted runners and the portal can occasionally disagree on DNS/network routing.
  // Resolve through a public DoH endpoint as an independent fallback. Only the hostname is sent.
  try {
    const response = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const payload = await response.json();
      for (const answer of payload.Answer || []) {
        if (answer.type === 1 && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(answer.data)) {
          addresses.add(answer.data);
        }
      }
    }
  } catch (error) {
    console.log(`Public DNS fallback failed: ${error.message}`);
  }

  return [...addresses];
}

function launchOptions(forcedIpv4 = null) {
  const args = ['--disable-dev-shm-usage'];

  if (forcedIpv4) {
    // Keep the HTTPS URL/hostname unchanged for SNI and certificate validation while
    // forcing Chromium to connect to the independently resolved IPv4 address.
    args.push(`--host-resolver-rules=MAP ${PORTAL_HOST} ${forcedIpv4},EXCLUDE localhost`);
  }

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
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return { browser, context, page };
}

async function gotoWithRetry(page, url, attempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (error) {
      lastError = error;
      if (!isNetworkError(error) || attempt === attempts) throw error;
      console.log(`Portal connection attempt ${attempt}/${attempts} failed; retrying…`);
      await page.waitForTimeout(attempt * 1500);
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
      if (forcedIpv4) {
        console.log('Retrying Przybysz with an independently resolved IPv4 route…');
      }
      await gotoWithRetry(session.page, `${BASE_URL}/login`);
      return session;
    } catch (error) {
      lastError = error;
      await session.browser.close();
      if (!isNetworkError(error)) throw error;
    }
  }

  const proxyHint = PROXY_SERVER
    ? 'The configured proxy also could not reach the portal.'
    : 'The portal may be refusing connections from the GitHub-hosted runner network. You can optionally configure PIO_PROXY_SERVER (and proxy credentials if needed), or use a self-hosted runner.';

  throw new Error(`Could not connect to ${PORTAL_HOST} after normal, retry, and IPv4-routing attempts. ${proxyHint}\nLast error: ${lastError?.message || lastError}`);
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible({ timeout: 500 })) return locator;
      } catch {
        // Try the next selector.
      }
    }
  }
  return null;
}

async function fillLogin(page) {
  const loginInput = await firstVisible(page, [
    'input[name="login"]',
    'input[name="username"]',
    'input[id*="login" i]',
    'input[autocomplete="username"]',
    'input[type="text"]',
    'input[type="number"]',
  ]);

  const passwordInput = await firstVisible(page, [
    'input[name="password"]',
    'input[id*="password" i]',
    'input[autocomplete="current-password"]',
    'input[type="password"]',
  ]);

  if (!loginInput || !passwordInput) {
    throw new Error('Could not identify the Przybysz login form. The portal layout may have changed.');
  }

  await loginInput.fill(LOGIN);
  await passwordInput.fill(PASSWORD);

  let submit = page.getByRole('button', { name: /zaloguj|login|sign in/i }).first();
  if (!(await submit.count())) submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if (!(await submit.count())) throw new Error('Could not identify the login submit button.');

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    submit.click(),
  ]);

  // Allow client-side applications to finish navigation/auth state updates.
  await page.waitForTimeout(1500);
}

async function extractCaseBlock(page) {
  const pio = page.getByText(PIO_NUMBER, { exact: true }).first();
  if (!(await pio.count())) {
    const body = normalizeText(await page.locator('body').innerText());
    if (!body.includes(PIO_NUMBER)) {
      throw new Error('The configured PIO number was not found in Wnioski przyjęte.');
    }
  }

  if (await pio.count()) {
    let current = pio;
    let fallback = null;

    for (let depth = 0; depth < 9; depth += 1) {
      let text = '';
      try {
        text = normalizeText(await current.innerText());
      } catch {
        text = '';
      }

      if (text.includes(PIO_NUMBER) && text.length >= 20 && text.length <= 12000) {
        fallback = text;
        if (/etap realizacji|status|sprawę prowadzi|data przyjęcia|decyzj|pismo/i.test(text)) {
          return text;
        }
      }

      current = current.locator('..');
    }

    if (fallback) return fallback;
  }

  // Last-resort extraction: use a small text window around the PIO number rather than
  // hashing the entire account page, which could cause unrelated false alerts.
  const lines = normalizeText(await page.locator('body').innerText()).split('\n');
  const index = lines.findIndex((line) => line.includes(PIO_NUMBER));
  if (index < 0) throw new Error('Unable to isolate the configured case from the page.');
  return lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 24)).join('\n');
}

function readPreviousFingerprint() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}

function writeResult(outcome, currentFingerprint) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ version: 1, fingerprint: currentFingerprint }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    RESULT_FILE,
    JSON.stringify({ version: 1, outcome }, null, 2) + '\n',
    'utf8',
  );
}

console.log('Opening Przybysz…');
const { browser, page } = await openPortalSession();

try {
  await fillLogin(page);

  console.log('Opening accepted applications…');
  await gotoWithRetry(page, `${BASE_URL}/wnioski-przyjete`);
  await page.waitForTimeout(1200);

  const currentUrl = new URL(page.url());
  if (/\/login(?:$|[/?#])/.test(currentUrl.pathname + currentUrl.search)) {
    throw new Error('Login did not succeed. Check PIO_LOGIN and PIO_PASSWORD.');
  }

  const caseText = await extractCaseBlock(page);
  const currentFingerprint = fingerprint(caseText);
  const previousFingerprint = readPreviousFingerprint();

  const outcome = previousFingerprint === null
    ? 'baseline'
    : previousFingerprint === currentFingerprint
      ? 'unchanged'
      : 'changed';

  writeResult(outcome, currentFingerprint);

  if (outcome === 'baseline') console.log('Baseline saved. Future checks will notify on changes.');
  if (outcome === 'unchanged') console.log('No case status change detected.');
  if (outcome === 'changed') console.log('Case status change detected.');
} finally {
  await browser.close();
}
