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
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function normalizeComparableStatus(value) {
  return normalizeText(value)
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('pl-PL');
}

function fingerprintStatus(value) {
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
  const context = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return { browser, page };
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

  const hint = PROXY_SERVER
    ? 'The configured relay/proxy also could not reach the portal.'
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
    } catch {}
  }
  return false;
}

async function safePublicPageDiagnostics(page) {
  let title = '';
  let bodyPreview = '';
  try { title = await page.title(); } catch {}
  try { bodyPreview = normalizeText(await page.locator('body').innerText()).slice(0, 700); } catch {}

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
  let form = null;
  for (let i = 0; i < 15 && !form; i += 1) {
    form = await findLoginForm(page);
    if (!form) await page.waitForTimeout(500);
  }

  if (!form && await clickLoginEntryPoint(page)) {
    for (let i = 0; i < 12 && !form; i += 1) {
      form = await findLoginForm(page);
      if (!form) await page.waitForTimeout(500);
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
  if (await submit.count()) await submit.click();
  else await form.passwordInput.press('Enter');

  await page.waitForTimeout(1800);
}

async function openAcceptedApplications(page) {
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
      const currentUrl = new URL(page.url());
      if (!/\/login(?:$|[/?#])/.test(currentUrl.pathname + currentUrl.search)) return;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
}

const STATUS_FIELD_SOURCE = 'etap\\s+realizacji|status(?:\\s+sprawy)?|etap\\s+sprawy|stan\\s+sprawy';
const FOLLOWING_FIELD_SOURCE = [
  'sprawę\\s+prowadzi',
  'osoba\\s+prowadząca',
  'data\\s+przyjęcia(?:\\s+wniosku)?',
  'data\\s+złożenia(?:\\s+wniosku)?',
  'nr\\.?\\s*pio',
  'numer\\s+(?:wniosku|pio)',
  'rodzaj\\s+wniosku',
  'typ\\s+wniosku',
  'podgląd\\s+wniosku',
  'komunikaty',
].join('|');

const STATUS_LABEL_PATTERN = new RegExp(`^(?:${STATUS_FIELD_SOURCE})\\b`, 'i');
const STATUS_LINE_PATTERN = new RegExp(`^(?<label>${STATUS_FIELD_SOURCE})\\s*[:\\-–—]?\\s*(?<value>.*)$`, 'i');
const NEXT_FIELD_PATTERN = new RegExp(`\\s+(?:${FOLLOWING_FIELD_SOURCE})\\s*[:\\-–—]?`, 'i');
const OTHER_FIELD_LINE_PATTERN = new RegExp(`^(?:${FOLLOWING_FIELD_SOURCE})\\b`, 'i');
const INLINE_STATUS_PATTERN = new RegExp(
  `(?:^|\\s)(?<label>${STATUS_FIELD_SOURCE})\\s*[:\\-–—]?\\s*(?<value>.+?)(?=\\s+(?:${FOLLOWING_FIELD_SOURCE})\\s*[:\\-–—]?|$)`,
  'i',
);

function cleanStatusValue(value) {
  let cleaned = String(value || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
  const nextField = cleaned.search(NEXT_FIELD_PATTERN);
  if (nextField > 0) cleaned = cleaned.slice(0, nextField).trim();
  return cleaned.replace(/^[:\-–—\s]+/, '').trim();
}

function validExtractedStatus(field, value) {
  const cleaned = cleanStatusValue(value);
  if (!cleaned || cleaned.length > 1000 || STATUS_LABEL_PATTERN.test(cleaned)) return null;
  return { field: field.replace(/\s+/g, ' ').trim(), value: cleaned };
}

function extractStatusFromText(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');

  // Handle the conventional representation where the label begins a line and
  // the value is either on that line or in one or more following grid cells.
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(STATUS_LINE_PATTERN);
    if (!match?.groups) continue;

    let value = cleanStatusValue(match.groups.value);
    if (!value) {
      const collected = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 6); j += 1) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        if (STATUS_LABEL_PATTERN.test(candidate) || OTHER_FIELD_LINE_PATTERN.test(candidate)) break;
        collected.push(candidate);
      }
      value = cleanStatusValue(collected.join(' '));
    }

    const result = validExtractedStatus(match.groups.label, value);
    if (result) return result;
  }

  // Przybysz renders the application summary as a responsive grid. In some
  // viewport/DOM combinations innerText flattens several label/value cells onto
  // one line: "... Etap realizacji: VALUE Sprawę prowadzi: ...". Search that
  // representation too and stop strictly at the next known field label.
  const flat = normalized.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const inline = flat.match(INLINE_STATUS_PATTERN);
  if (inline?.groups) {
    const result = validExtractedStatus(inline.groups.label, inline.groups.value);
    if (result) return result;
  }

  return null;
}

async function extractStrictStatus(page) {
  const pio = page.getByText(PIO_NUMBER, { exact: true }).first();
  const exactPioFound = (await pio.count()) > 0;

  if (exactPioFound) {
    // Start at the exact PIO value and walk outward. The first ancestor that
    // contains both the PIO and an explicit status is the safest representation
    // of this application card, even when multiple applications exist.
    let current = pio;
    for (let depth = 0; depth < 14; depth += 1) {
      let text = '';
      try { text = normalizeText(await current.innerText()); } catch {}

      if (text.includes(PIO_NUMBER) && text.length >= 20 && text.length <= 30000) {
        const status = extractStatusFromText(text);
        if (status) return { ...status, pioMatchedExactly: true };
      }

      current = current.locator('..');
    }
  }

  // Fallback for portals that split the PIO into nested spans. Keep extraction
  // bounded around the configured PIO instead of accepting any account status.
  const bodyText = normalizeText(await page.locator('body').innerText());
  if (!bodyText.includes(PIO_NUMBER)) {
    throw new Error('The configured PIO number was not found after login. Refusing to create a baseline.');
  }

  const lines = bodyText.split('\n');
  const index = lines.findIndex((line) => line.includes(PIO_NUMBER));
  let windowText;
  if (lines.length === 1) {
    const flatIndex = bodyText.indexOf(PIO_NUMBER);
    windowText = bodyText.slice(Math.max(0, flatIndex - 1500), Math.min(bodyText.length, flatIndex + 3500));
  } else {
    windowText = lines.slice(Math.max(0, index - 12), Math.min(lines.length, index + 36)).join('\n');
  }

  const status = extractStatusFromText(windowText);
  if (!status) {
    throw new Error(
      'The case was found, but no explicit status/stage field (for example "Etap realizacji" or "Status sprawy") could be identified. Refusing to save a false baseline.',
    );
  }

  return { ...status, pioMatchedExactly: false };
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

function writeResult({ outcome, statusFingerprint, statusField, pioMatchedExactly, expectedStatusChecked, expectedStatusMatch }) {
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
      pio_matched_exactly: pioMatchedExactly,
      status_field_found: true,
      status_fingerprint_saved: true,
      status_field: statusField,
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

  const currentUrlAfterLogin = new URL(page.url());
  if (/\/login(?:$|[/?#])/.test(currentUrlAfterLogin.pathname + currentUrlAfterLogin.search)) {
    await page.waitForTimeout(2200);
  }

  console.log('Opening accepted applications…');
  await openAcceptedApplications(page);

  const currentUrl = new URL(page.url());
  if (/\/login(?:$|[/?#])/.test(currentUrl.pathname + currentUrl.search)) {
    throw new Error('Login did not succeed. Check PIO_LOGIN and PIO_PASSWORD.');
  }

  const { field: statusField, value: statusValue, pioMatchedExactly } = await extractStrictStatus(page);
  const normalizedStatus = normalizeComparableStatus(statusValue);
  if (!normalizedStatus) throw new Error('An explicit status field was found but its value was empty.');

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

  writeResult({
    outcome,
    statusFingerprint: currentFingerprint,
    statusField,
    pioMatchedExactly,
    expectedStatusChecked,
    expectedStatusMatch,
  });

  console.log('Case found: yes');
  console.log('PIO matched: yes');
  console.log(`PIO matched exactly: ${pioMatchedExactly ? 'yes' : 'no'}`);
  console.log('Status field found: yes');
  console.log(`Status field: ${statusField}`);
  console.log('Status fingerprint saved: yes');

  if (expectedStatusChecked) {
    console.log(`Expected status match: ${expectedStatusMatch ? 'yes' : 'no'}`);
    if (!expectedStatusMatch) {
      throw new Error('Strict verification failed: the extracted status does not match PIO_EXPECTED_STATUS. No readable status was printed.');
    }
  }

  if (outcome === 'baseline') console.log('Strict status baseline saved. Future checks will compare the explicit status value only.');
  if (outcome === 'unchanged') console.log('No explicit case status change detected.');
  if (outcome === 'changed') console.log('Explicit case status change detected.');
} finally {
  await browser.close();
}
