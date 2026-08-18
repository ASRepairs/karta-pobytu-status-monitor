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
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

fs.mkdirSync(STATE_DIR, { recursive: true });

function normalizeText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function fingerprint(value) {
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
      if (forcedIpv4) console.log('Retrying Przybysz with an independently resolved IPv4 route…');
      await gotoWithRetry(session.page, `${BASE_URL}/login`);
      return session;
    } catch (error) {
      lastError = error;
      await session.browser.close();
      if (!isNetworkError(error)) throw error;
    }
  }

  const proxyHint = PROXY_SERVER
    ? 'The configured relay/proxy also could not reach the portal.'
    : 'No usable route to Przybysz was available.';
  throw new Error(`Could not connect to ${PORTAL_HOST}. ${proxyHint}\nLast error: ${lastError?.message || lastError}`);
}

async function firstVisible(scope, selectors) {
  for (const selector of selectors) {
    const locator = scope.locator(selector).first();
    if (await locator.count()) {
      try {
        if (await locator.isVisible({ timeout: 700 })) return locator;
      } catch {
        // Try the next selector.
      }
    }
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

    let loginInput = await firstVisible(frame, LOGIN_SELECTORS);
    if (!loginInput) {
      // Last-resort fallback: use the first visible non-password, non-hidden input
      // in the same frame as the password field.
      loginInput = await firstVisible(frame, [
        'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])',
      ]);
    }
    if (loginInput) return { frame, loginInput, passwordInput };
  }
  return null;
}

async function clickLoginEntryPoint(page) {
  const candidates = [
    page.getByRole('button', { name: /zaloguj|logowanie|login|sign in/i }).first(),
    page.getByRole('link', { name: /zaloguj|logowanie|login|sign in/i }).first(),
    page.locator('a[href*="login" i], a[href*="logow" i], button[data-target*="login" i]').first(),
  ];

  for (const candidate of candidates) {
    try {
      if ((await candidate.count()) && (await candidate.isVisible({ timeout: 700 }))) {
        await candidate.click();
        await page.waitForTimeout(1200);
        return true;
      }
    } catch {
      // Try another entry point.
    }
  }
  return false;
}

async function safePublicPageDiagnostics(page) {
  // This executes only before credentials are filled. Keep diagnostics structural
  // and bounded so a public Actions log never contains account/case information.
  let title = '';
  let bodyPreview = '';
  try { title = await page.title(); } catch {}
  try {
    bodyPreview = normalizeText(await page.locator('body').innerText()).slice(0, 700);
  } catch {}

  const frameInfo = [];
  for (const frame of page.frames()) {
    let inputs = [];
    let buttons = [];
    try {
      inputs = await frame.locator('input').evaluateAll((nodes) => nodes.slice(0, 12).map((node) => ({
        type: node.getAttribute('type') || '',
        name: node.getAttribute('name') || '',
        id: node.getAttribute('id') || '',
        autocomplete: node.getAttribute('autocomplete') || '',
        placeholder: node.getAttribute('placeholder') || '',
      })));
      buttons = await frame.locator('button, input[type="submit"], a').evaluateAll((nodes) => nodes.slice(0, 12).map((node) => ({
        tag: node.tagName.toLowerCase(),
        type: node.getAttribute('type') || '',
        text: (node.textContent || node.getAttribute('value') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        href: node.getAttribute('href') || '',
      })));
    } catch {}
    frameInfo.push({ url: frame.url(), inputs, buttons });
  }

  console.log('--- Safe pre-login diagnostics (public page only) ---');
  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${title}`);
  console.log(`Body preview: ${bodyPreview}`);
  console.log(`Frames/forms: ${JSON.stringify(frameInfo)}`);
  console.log('--- End diagnostics ---');
}

async function fillLogin(page) {
  // Przybysz is a client-rendered application on some deployments. Give it time
  // to mount the form instead of assuming DOMContentLoaded means the UI is ready.
  let form = null;
  for (let i = 0; i < 15 && !form; i += 1) {
    form = await findLoginForm(page);
    if (!form) await page.waitForTimeout(500);
  }

  if (!form) {
    // Some versions expose a landing page first and render the actual form only
    // after clicking a login entry point.
    if (await clickLoginEntryPoint(page)) {
      for (let i = 0; i < 12 && !form; i += 1) {
        form = await findLoginForm(page);
        if (!form) await page.waitForTimeout(500);
      }
    }
  }

  if (!form) {
    await safePublicPageDiagnostics(page);
    throw new Error('Could not identify the Przybysz login form. See the safe pre-login diagnostics above.');
  }

  await form.loginInput.fill(LOGIN);
  await form.passwordInput.fill(PASSWORD);

  let submit = form.frame.getByRole('button', { name: /zaloguj|login|sign in/i }).first();
  if (!(await submit.count())) submit = form.frame.locator('button[type="submit"], input[type="submit"]').first();
  if (!(await submit.count())) {
    // A few frameworks submit on Enter without rendering a semantic submit button.
    await form.passwordInput.press('Enter');
  } else {
    await submit.click();
  }

  await page.waitForTimeout(1800);
}

async function openAcceptedApplications(page) {
  // Prefer the portal's own navigation label because route names are more likely
  // to change than the visible Polish section name.
  const navCandidates = [
    page.getByRole('link', { name: /wnioski\s+przyjęte/i }).first(),
    page.getByRole('button', { name: /wnioski\s+przyjęte/i }).first(),
    page.getByText(/wnioski\s+przyjęte/i, { exact: false }).first(),
  ];
  for (const candidate of navCandidates) {
    try {
      if ((await candidate.count()) && (await candidate.isVisible({ timeout: 700 }))) {
        await candidate.click();
        await page.waitForTimeout(1500);
        return;
      }
    } catch {}
  }

  const paths = ['/wnioski-przyjete', '/wnioski/przyjete', '/applications/accepted'];
  let lastError;
  for (const route of paths) {
    try {
      await gotoWithRetry(page, `${BASE_URL}${route}`, 1);
      await page.waitForTimeout(1000);
      if (!/\/login(?:$|[/?#])/.test(new URL(page.url()).pathname + new URL(page.url()).search)) return;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
}

async function extractCaseBlock(page) {
  const pio = page.getByText(PIO_NUMBER, { exact: true }).first();
  if (!(await pio.count())) {
    const body = normalizeText(await page.locator('body').innerText());
    if (!body.includes(PIO_NUMBER)) throw new Error('The configured PIO number was not found in Wnioski przyjęte.');
  }

  if (await pio.count()) {
    let current = pio;
    let fallback = null;
    for (let depth = 0; depth < 9; depth += 1) {
      let text = '';
      try { text = normalizeText(await current.innerText()); } catch {}
      if (text.includes(PIO_NUMBER) && text.length >= 20 && text.length <= 12000) {
        fallback = text;
        if (/etap realizacji|status|sprawę prowadzi|data przyjęcia|decyzj|pismo/i.test(text)) return text;
      }
      current = current.locator('..');
    }
    if (fallback) return fallback;
  }

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
  fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, fingerprint: currentFingerprint }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ version: 1, outcome }, null, 2) + '\n', 'utf8');
}

console.log('Opening Przybysz…');
const { browser, page } = await openPortalSession();

try {
  await fillLogin(page);

  const currentUrlAfterLogin = new URL(page.url());
  const loginPath = currentUrlAfterLogin.pathname + currentUrlAfterLogin.search;
  if (/\/login(?:$|[/?#])/.test(loginPath)) {
    // Some SPA logins keep the same URL briefly; allow a little more time before
    // deciding authentication failed.
    await page.waitForTimeout(2200);
  }

  console.log('Opening accepted applications…');
  await openAcceptedApplications(page);

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
