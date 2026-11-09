// Local-only integrated browser harness. Uses a disposable real PostgreSQL server.
import EmbeddedPostgres from 'embedded-postgres';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { postgres } from '../src/db/client.ts';
import { migrate } from '../src/db/migrate.ts';
import { buildApp } from '../src/app.ts';
import { Marketing } from '../src/marketing/service.ts';
import { SandboxProvider } from '../src/email/provider.ts';
import { runOne } from '../src/email/outbox.ts';
import { testConfig } from '../tests/helpers.ts';
const require = createRequire(resolve('../1pass/package.json'));
const { chromium, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const root = resolve('.test-postgres');
await mkdir(root, { recursive: true });
const dir = await mkdtemp(resolve(root, 'browser-'));
const listener = createServer();
await new Promise((r) => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const password = randomBytes(24).toString('hex');
const pg = new EmbeddedPostgres({
  databaseDir: resolve(dir, 'db'),
  user: 'test',
  password,
  port,
  persistent: true,
  createPostgresUser: false,
  autoRehydrateSymlinks: true,
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: () => {},
});
let db,
  app,
  browser,
  frontend,
  started = false;
const results = [];
console.log('Starting disposable PostgreSQL and local previews');
const out = resolve('../1pass/docs/prelaunch/qa');
await mkdir(out, { recursive: true });
try {
  await pg.initialise();
  await pg.start();
  started = true;
  await pg.createDatabase('marketing_browser');
  db = postgres(
    `postgresql://test:${password}@127.0.0.1:${port}/marketing_browser`,
  );
  await migrate(db);
  const c = {
    ...testConfig(),
    PUBLIC_API_ORIGIN: 'http://127.0.0.1:4100',
    MARKETING_SITE_ORIGIN: 'http://127.0.0.1:3100',
    CORS_ALLOWED_ORIGINS: 'http://127.0.0.1:3100',
    SANDBOX_MAIL_DIR: resolve(dir, 'mail'),
  };
  const m = new Marketing(db, c),
    provider = new SandboxProvider(c, m.protection);
  app = buildApp(c, db);
  await app.listen({ host: '127.0.0.1', port: 4100 });
  frontend = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3100',
    ],
    {
      cwd: resolve('../1pass'),
      env: {
        ...process.env,
        NEXT_PUBLIC_MARKETING_MODE: 'local-sandbox',
        NEXT_PUBLIC_MARKETING_API_BASE_URL: c.PUBLIC_API_ORIGIN,
        NEXT_PUBLIC_SITE_URL: c.MARKETING_SITE_ORIGIN,
        NEXT_DIST_DIR: '.next-qa',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverOutput = '';
  frontend.stdout.on('data', (b) => {
    serverOutput = (serverOutput + b).slice(-3000);
  });
  frontend.stderr.on('data', (b) => {
    serverOutput = (serverOutput + b).slice(-3000);
  });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(c.MARKETING_SITE_ORIGIN + '/api/health');
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('Frontend startup failed: ' + serverOutput);
  browser = await chromium.launch({
    channel: process.platform === 'win32' ? 'msedge' : undefined,
  });
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const requests = [];
  page.on('request', (r) =>
    requests.push({ url: r.url(), headers: r.headers() }),
  );
  async function mail(event) {
    while (await runOne(m, provider)) {}
    const files = await readdir(c.SANDBOX_MAIL_DIR);
    const all = await Promise.all(
      files.map(async (f) =>
        m.protection.open(
          await readFile(resolve(c.SANDBOX_MAIL_DIR, f), 'utf8'),
        ),
      ),
    );
    return all.filter((v) => v.event === event).at(-1);
  }
  async function signup(email) {
    await page.goto(c.MARKETING_SITE_ORIGIN + '/launch');
    await page.getByLabel('Email address', { exact: true }).fill(email);
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Get launch updates' }).click();
    await expect(page.getByRole('status')).toContainText('If eligible');
  }
  await signup('browser@example.com');
  expect(
    (await db.query('SELECT status FROM marketing_subscribers')).rows[0].status,
  ).toBe('pending');
  const confirmation = await mail('confirmation');
  expect(confirmation.links.confirm).toContain('#token=');
  await signup('browser@example.com');
  expect(
    (await db.query('SELECT id FROM marketing_subscribers')).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT id FROM marketing_email_outbox WHERE event_type='confirmation'",
      )
    ).rows,
  ).toHaveLength(1);
  await page.goto(confirmation.links.confirm);
  await expect(page).toHaveURL(c.MARKETING_SITE_ORIGIN + '/launch/confirm');
  expect(
    (await db.query('SELECT status FROM marketing_subscribers')).rows[0].status,
  ).toBe('pending');
  await page.getByRole('button', { name: 'Confirm launch updates' }).click();
  await expect(page.getByRole('status')).toContainText("You're subscribed");
  expect(
    (await db.query('SELECT status FROM marketing_subscribers')).rows[0].status,
  ).toBe('confirmed');
  console.log('Integration checkpoint');
  results.push(
    'Real browser signup → pending → sandbox email → explicit confirmation; duplicate creates no extra subscriber/mail; GET does not consume token',
  );
  await page.screenshot({
    path: resolve(out, 'confirmed.png'),
    fullPage: true,
  });
  const management = await mail('management');
  await page.goto(confirmation.links.confirm);
  await page.getByRole('button', { name: 'Confirm launch updates' }).click();
  await expect(page.getByRole('status')).toContainText(
    'invalid or already used',
  );
  await page.goto(management.links.preferences);
  await page.getByRole('button', { name: 'Load my preferences' }).click();
  await expect(page.getByRole('status')).toContainText('Choose the topics');
  await page.getByLabel('Family', { exact: true }).check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByRole('status')).toContainText('updated');
  expect(
    (
      await db.query(
        "SELECT interest FROM marketing_subscriber_interests WHERE interest='family'",
      )
    ).rows,
  ).toHaveLength(1);
  await page.goto(management.links.unsubscribe);
  await page.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await expect(page.getByRole('status')).toContainText("You're unsubscribed");
  await page.goto(management.links.unsubscribe);
  await page.getByRole('button', { name: 'Unsubscribe', exact: true }).click();
  await expect(page.getByRole('status')).toContainText("You're unsubscribed");
  console.log('Integration checkpoint');
  results.push(
    'Replay rejected; preferences persisted; unsubscribe repeatable',
  );
  await signup('expired@example.com');
  const expired = await mail('confirmation');
  await db.query(
    "UPDATE marketing_capability_tokens SET expires_at=now()-interval '1 minute' WHERE purpose='confirm'",
  );
  await page.goto(expired.links.confirm);
  await page.getByRole('button', { name: 'Confirm launch updates' }).click();
  await expect(page.getByRole('status')).toContainText('expired');
  await page.goto(
    c.MARKETING_SITE_ORIGIN + '/launch/confirm#token=' + 'A'.repeat(43),
  );
  await page.getByRole('button', { name: 'Confirm launch updates' }).click();
  await expect(page.getByRole('status')).toContainText(
    'invalid or already used',
  );
  console.log('Integration checkpoint');
  results.push('Expired and wrong-token states verified');
  await page.goto(c.MARKETING_SITE_ORIGIN + '/contact');
  await page.getByLabel('Email address').fill('contact@example.com');
  await page
    .getByLabel('Your message')
    .fill('Fictional local enquiry about development progress.');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('status')).toContainText('received');
  expect(
    (await db.query('SELECT id FROM marketing_contact_requests')).rows,
  ).toHaveLength(1);
  await page.goto(c.MARKETING_SITE_ORIGIN + '/business');
  const form = page.locator('#research-conversation form');
  await form.getByLabel('Name', { exact: true }).fill('Example Person');
  await form.getByLabel('Work email').fill('business@example.com');
  await form.getByLabel('Your role').fill('Operations');
  await form.getByLabel('Organization size').selectOption('11-50');
  await form
    .getByLabel('How does your team')
    .selectOption('Passwords saved in browsers');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Send research request' }).click();
  await expect(form.getByRole('status')).toContainText('received');
  expect(
    (await db.query('SELECT id FROM marketing_business_inquiries')).rows,
  ).toHaveLength(1);
  console.log('Integration checkpoint');
  results.push(
    'Contact and business forms persisted independently of marketing consent',
  );
  await page.goto(c.MARKETING_SITE_ORIGIN + '/feedback');
  await page.getByLabel('Which problem matters most?').selectOption('sharing');
  await page
    .getByLabel('What is difficult today? (optional)')
    .fill('Finding the right shared account is difficult.');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.getByRole('status')).toContainText('received locally');
  expect(
    (await db.query('SELECT id FROM marketing_feedback')).rows,
  ).toHaveLength(1);
  expect(
    (await db.query('SELECT id FROM marketing_subscribers')).rows,
  ).toHaveLength(2);
  for (const width of [320, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: resolve(out, `feedback-${width}.png`),
      fullPage: true,
    });
  }
  results.push(
    'Anonymous feedback persists independently; feedback axe and overflow pass at four widths',
  );
  await page.goto(c.MARKETING_SITE_ORIGIN + '/launch');
  await page
    .getByLabel('Email address', { exact: true })
    .fill('outage@example.com');
  await page.getByRole('checkbox').check();
  await page.route('**/api/v1/marketing/subscriptions', (route) =>
    route.abort(),
  );
  await page.getByRole('button', { name: 'Get launch updates' }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText(
    'could not verify',
  );
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(
    'outage@example.com',
  );
  await page.unroute('**/api/v1/marketing/subscriptions');
  await page.route('**/api/v1/marketing/subscriptions', (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'RATE_LIMITED' }),
    }),
  );
  await page.getByRole('button', { name: 'Get launch updates' }).click();
  await expect(page.locator('form').getByRole('alert')).toContainText(
    'Too many',
  );
  await page.unroute('**/api/v1/marketing/subscriptions');
  console.log('Integration checkpoint');
  results.push(
    'Outage and 429 preserve entered data and show actionable errors',
  );
  for (const width of [320, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(c.MARKETING_SITE_ORIGIN + '/launch');
    await expect(page.locator('body')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: resolve(out, `launch-${width}.png`),
      fullPage: true,
    });
  }
  expect(
    requests.some(
      (r) =>
        r.url.includes('token=') ||
        r.url.includes('browser@example.com') ||
        Object.values(r.headers).some((v) => v.includes('#token=')),
    ),
  ).toBe(false);
  const response = await page.request.get(
    c.MARKETING_SITE_ORIGIN + '/launch/confirm',
  );
  expect(response.headers()['referrer-policy']).toBe('no-referrer');
  expect(response.headers()['x-robots-tag']).toContain('noindex');
  console.log('Integration checkpoint');
  results.push(
    'Launch axe/overflow/screenshots at 320/768/1440/1920; no tokens/emails in request URLs/referrers; action-page noindex/no-referrer',
  );
  await writeFile(
    resolve(out, 'integrated-results.json'),
    JSON.stringify(
      {
        date: '2026-11-09',
        database: 'disposable PostgreSQL',
        email: 'encrypted local SandboxProvider only',
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: results }, null, 2));
} finally {
  if (browser) await browser.close();
  if (frontend) {
    if (process.platform === 'win32')
      await new Promise((r) => {
        const child = spawn(
          'taskkill',
          ['/pid', String(frontend.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        child.on('exit', r);
      });
    else frontend.kill();
  }
  if (app) await app.close();
  if (db) await db.close();
  if (started) await pg.stop();
  const within = relative(root, dir);
  if (!within || within.startsWith('..') || isAbsolute(within))
    throw new Error('Unsafe test cleanup path');
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}
