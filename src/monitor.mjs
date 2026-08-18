import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = (process.env.PIO_BASE_URL || 'https://pio-przybysz.duw.pl').replace(/\/$/, '');
const LOGIN = process.env.PIO_LOGIN;
const PASSWORD = process.env.PIO_PASSWORD;
const PIO_NUMBER = process.env.PIO_NUMBER;
const STATE_DIR = process.env.PIO_STATE_DIR || '.pio-state';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const RESULT_FILE = path.join(STATE_DIR, 'result.json');

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

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
});
const page = await context.newPage();
page.setDefaultTimeout(15000);

try {
  console.log('Opening Przybysz…');
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await fillLogin(page);

  console.log('Opening accepted applications…');
  await page.goto(`${BASE_URL}/wnioski-przyjete`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);

  if (/\/login(?:$|[/?#])/.test(new URL(page.url()).pathname + new URL(page.url()).search)) {
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
