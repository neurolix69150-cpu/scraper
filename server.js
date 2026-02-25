const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use('/api/', limiter);

// ─── IN-MEMORY STORES ─────────────────────────────────────────────────────────
const jobs      = new Map();
const results   = new Map();
const schedules = new Map();
const proxies   = [];
let settings = {
  smtp: { host: '', port: 587, user: '', pass: '', from: '' },
  webhook: '',
  notifyEmail: '',
  googleSheets: { credentialsJson: '', spreadsheetId: '' },
};

// ─── PROXY MANAGER ────────────────────────────────────────────────────────────
function addProxy(proxyUrl) {
  if (proxies.find(p => p.url === proxyUrl)) return false;
  proxies.push({ url: proxyUrl, used: 0, errors: 0, lastUsed: null, alive: true });
  return true;
}

function getNextProxy() {
  const alive = proxies.filter(p => p.alive && p.errors < 5);
  if (!alive.length) return null;
  alive.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  const proxy = alive[0];
  proxy.used++;
  proxy.lastUsed = Date.now();
  return proxy;
}

function reportProxyError(url) {
  const p = proxies.find(x => x.url === url);
  if (p) { p.errors++; if (p.errors >= 5) p.alive = false; }
}

function reportProxySuccess(url) {
  const p = proxies.find(x => x.url === url);
  if (p) { p.errors = Math.max(0, p.errors - 1); p.alive = true; }
}

// ─── USER AGENTS POOL ─────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// ─── DATA EXTRACTOR ───────────────────────────────────────────────────────────
function extractData(html, selectors) {
  const $ = cheerio.load(html);
  const extracted = {};

  for (const [key, selector] of Object.entries(selectors)) {
    const items = [];
    $(selector).each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      const src  = $(el).attr('src');
      const val  = $(el).val();
      if (text || href || src || val) items.push({ text, href, src, value: val });
    });
    extracted[key] = items;
  }

  if (Object.keys(selectors).length === 0) {
    extracted['title']    = [{ text: $('title').text().trim() }];
    extracted['headings'] = [];
    $('h1,h2,h3').each((_, el) => extracted['headings'].push({ text: $(el).text().trim(), tag: el.tagName }));
    extracted['links']    = [];
    $('a[href]').each((_, el) => extracted['links'].push({ text: $(el).text().trim(), href: $(el).attr('href') }));
    extracted['images']   = [];
    $('img[src]').each((_, el) => extracted['images'].push({ src: $(el).attr('src'), alt: $(el).attr('alt') }));
    extracted['paragraphs'] = [];
    $('p').each((_, el) => { const t = $(el).text().trim(); if (t.length > 10) extracted['paragraphs'].push({ text: t }); });
    extracted['meta'] = {};
    $('meta').each((_, el) => {
      const name = $(el).attr('name') || $(el).attr('property');
      const content = $(el).attr('content');
      if (name && content) extracted['meta'][name] = content;
    });
  }
  return extracted;
}

// ─── SCRAPERS ─────────────────────────────────────────────────────────────────
async function scrapeWithAxios(url, selectors, options = {}) {
  const proxy = options.useProxy ? getNextProxy() : null;
  const ua = randomUA();
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
  };
  if (options.headers) Object.assign(headers, options.headers);

  const config = { headers, timeout: 15000, maxRedirects: 5 };
  if (proxy) { config.httpsAgent = new HttpsProxyAgent(proxy.url); }

  try {
    const response = await axios.get(url, config);
    if (proxy) reportProxySuccess(proxy.url);
    return { data: extractData(response.data, selectors), proxyUsed: proxy?.url || null, ua };
  } catch (err) {
    if (proxy) reportProxyError(proxy.url);
    throw err;
  }
}

async function scrapeWithPuppeteer(url, selectors, options = {}) {
  const puppeteer = require('puppeteer');
  const proxy = options.useProxy ? getNextProxy() : null;
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled',
  ];
  if (proxy) args.push(`--proxy-server=${proxy.url}`);

  const browser = await puppeteer.launch({ headless: 'new', args });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(randomUA());
    await page.setViewport({ width: 1280 + Math.floor(Math.random() * 100), height: 800 });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      window.chrome = { runtime: {} };
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    if (options.waitFor) { try { await page.waitForSelector(options.waitFor, { timeout: 8000 }); } catch {} }
    if (options.scrollToBottom) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          let total = 0;
          const timer = setInterval(() => {
            window.scrollBy(0, 400); total += 400;
            if (total >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
          }, 80);
        });
      });
      await new Promise(r => setTimeout(r, 1200));
    }
    const html = await page.content();
    if (proxy) reportProxySuccess(proxy.url);
    return { data: extractData(html, selectors), proxyUsed: proxy?.url || null };
  } catch (err) {
    if (proxy) reportProxyError(proxy.url);
    throw err;
  } finally {
    await browser.close();
  }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────
async function sendEmailNotification(job, result) {
  if (!settings.smtp.host || !settings.notifyEmail) return;
  try {
    const transporter = nodemailer.createTransport({
      host: settings.smtp.host, port: settings.smtp.port || 587,
      secure: settings.smtp.port == 465,
      auth: { user: settings.smtp.user, pass: settings.smtp.pass },
    });
    const itemCount = result ? Object.values(result.data).reduce((s, v) => s + (Array.isArray(v) ? v.length : 1), 0) : 0;
    await transporter.sendMail({
      from: settings.smtp.from || settings.smtp.user,
      to: settings.notifyEmail,
      subject: `[WebCrawlr] Scrape ${job.status === 'done' ? '✅ terminé' : '❌ erreur'} — ${job.url}`,
      html: `<div style="font-family:sans-serif;max-width:600px;background:#0a0a0f;color:#e8e8f0;padding:32px;border-radius:12px;">
        <h2 style="color:${job.status==='done'?'#00ff88':'#ef4444'};font-family:monospace;">
          🕷️ WebCrawlr — Scrape ${job.status === 'done' ? 'terminé' : 'échoué'}
        </h2>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;">
          <tr><td style="padding:8px;color:#9999bb;width:140px;">URL</td><td style="padding:8px;"><a href="${job.url}" style="color:#7c3aed;">${job.url}</a></td></tr>
          <tr><td style="padding:8px;color:#9999bb;">Mode</td><td style="padding:8px;">${job.mode}</td></tr>
          <tr><td style="padding:8px;color:#9999bb;">Statut</td><td style="padding:8px;color:${job.status==='done'?'#00ff88':'#ef4444'};">${job.status}</td></tr>
          ${job.status === 'done' ? `<tr><td style="padding:8px;color:#9999bb;">Éléments</td><td style="padding:8px;">${itemCount}</td></tr>` : ''}
          ${job.status === 'error' ? `<tr><td style="padding:8px;color:#9999bb;">Erreur</td><td style="padding:8px;color:#ef4444;">${job.error}</td></tr>` : ''}
          <tr><td style="padding:8px;color:#9999bb;">Job ID</td><td style="padding:8px;font-family:monospace;font-size:12px;">${job.id}</td></tr>
          <tr><td style="padding:8px;color:#9999bb;">Date</td><td style="padding:8px;">${new Date().toLocaleString('fr-FR')}</td></tr>
        </table>
      </div>`,
    });
    console.log('📧 Email envoyé pour job', job.id);
  } catch (e) { console.error('Email error:', e.message); }
}

async function sendWebhookNotification(job, result) {
  if (!settings.webhook) return;
  try {
    const itemCount = result ? Object.values(result.data).reduce((s, v) => s + (Array.isArray(v) ? v.length : 1), 0) : 0;
    await axios.post(settings.webhook, {
      event: 'scrape_finished',
      jobId: job.id,
      url: job.url,
      status: job.status,
      mode: job.mode,
      itemsCount: itemCount,
      error: job.error || null,
      finishedAt: job.finishedAt,
      proxyUsed: job.proxyUsed || null,
    }, { timeout: 10000 });
    console.log('🔔 Webhook envoyé pour job', job.id);
  } catch (e) { console.error('Webhook error:', e.message); }
}

async function sendNotifications(job, result) {
  await Promise.allSettled([sendEmailNotification(job, result), sendWebhookNotification(job, result)]);
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
async function exportToGoogleSheets(result, sheetName) {
  if (!settings.googleSheets.credentialsJson || !settings.googleSheets.spreadsheetId) {
    throw new Error('Google Sheets non configuré.');
  }
  const { google } = require('googleapis');
  let credentials;
  try { credentials = JSON.parse(settings.googleSheets.credentialsJson); } catch { throw new Error('JSON credentials invalide'); }

  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = settings.googleSheets.spreadsheetId;
  const tabName = (sheetName || `Scrape_${new Date().toISOString().slice(0,16).replace('T','_').replace(':','-')}`).slice(0, 100);

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
    });
  } catch {}

  const allItems = Object.entries(result.data).flatMap(([key, items]) =>
    Array.isArray(items) ? items.map(i => ({ _categorie: key, ...i })) : []
  );
  if (!allItems.length) throw new Error('Aucune donnée tableau à exporter');

  const headers = [...new Set(allItems.flatMap(Object.keys))];
  const rows = [
    [`URL: ${result.url}`, `Scraped: ${new Date(result.scrapedAt).toLocaleString('fr-FR')}`],
    headers,
    ...allItems.map(item => headers.map(h => item[h] ?? '')),
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows },
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

// ─── CORE JOB RUNNER ──────────────────────────────────────────────────────────
async function runScrapeJob(jobConfig) {
  const { url, selectors = {}, mode = 'axios', options = {}, notify = true } = jobConfig;
  const jobId = jobConfig.jobId || uuidv4();

  const job = { id: jobId, url, mode, selectors, options, status: 'running', createdAt: new Date().toISOString(), finishedAt: null, error: null, proxyUsed: null };
  jobs.set(jobId, job);

  try {
    const scraped = mode === 'puppeteer'
      ? await scrapeWithPuppeteer(url, selectors, options)
      : await scrapeWithAxios(url, selectors, options);

    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.proxyUsed = scraped.proxyUsed;

    const result = {
      jobId, url, scrapedAt: new Date().toISOString(), mode,
      data: scraped.data,
      stats: {
        totalKeys: Object.keys(scraped.data).length,
        totalItems: Object.values(scraped.data).reduce((s, v) => s + (Array.isArray(v) ? v.length : 1), 0),
      },
    };
    results.set(jobId, result);
    if (notify) await sendNotifications(job, result);
    return result;
  } catch (err) {
    job.status = 'error'; job.error = err.message; job.finishedAt = new Date().toISOString();
    if (notify) await sendNotifications(job, null);
    throw err;
  }
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({
  status: 'ok', uptime: process.uptime(), version: '2.0.0',
  jobs: jobs.size, proxies: proxies.length, proxiesAlive: proxies.filter(p=>p.alive).length,
  schedules: schedules.size,
}));

// Scrape
app.post('/api/scrape', async (req, res) => {
  const { url, selectors = {}, mode = 'axios', options = {}, notify = true } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requise' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'URL invalide' }); }
  const jobId = uuidv4();
  res.json({ jobId, status: 'running' });
  runScrapeJob({ jobId, url, selectors, mode, options, notify }).catch(() => {});
});

// Jobs
app.get('/api/jobs', (req, res) => res.json(Array.from(jobs.values()).sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))));
app.get('/api/jobs/:id', (req, res) => { const j = jobs.get(req.params.id); j ? res.json(j) : res.status(404).json({ error: 'Not found' }); });
app.delete('/api/jobs/:id', (req, res) => { jobs.delete(req.params.id); results.delete(req.params.id); res.json({ success: true }); });
app.delete('/api/jobs', (req, res) => { jobs.clear(); results.clear(); res.json({ success: true }); });

// Results
app.get('/api/results/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status === 'running') return res.json({ status: 'running' });
  if (job.status === 'error')   return res.json({ status: 'error', error: job.error });
  res.json({ status: 'done', result: results.get(req.params.id) });
});

app.get('/api/results/:id/csv', (req, res) => {
  const result = results.get(req.params.id);
  if (!result) return res.status(404).json({ error: 'Not found' });
  const allItems = Object.entries(result.data).flatMap(([key, items]) =>
    Array.isArray(items) ? items.map(i => ({ _categorie: key, ...i })) : []
  );
  if (!allItems.length) return res.status(400).json({ error: 'No data' });
  const headers = [...new Set(allItems.flatMap(Object.keys))];
  const csv = [headers.join(','), ...allItems.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="scrape-${req.params.id}.csv"`);
  res.send('\uFEFF' + csv);
});

app.post('/api/results/:id/export-sheets', async (req, res) => {
  const result = results.get(req.params.id);
  if (!result) return res.status(404).json({ error: 'Not found' });
  try {
    const url = await exportToGoogleSheets(result, req.body.sheetName);
    res.json({ success: true, url });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Bulk
app.post('/api/bulk-scrape', async (req, res) => {
  const { urls, selectors = {}, mode = 'axios', options = {}, notify = false } = req.body;
  if (!urls?.length) return res.status(400).json({ error: 'URLs requises' });
  if (urls.length > 20) return res.status(400).json({ error: 'Max 20 URLs' });
  const jobIds = urls.map(() => uuidv4());
  res.json({ jobIds, count: jobIds.length });
  const queue = urls.map((url, i) => ({ url, jobId: jobIds[i] }));
  const CONCURRENCY = 5;
  (async () => {
    while (queue.length) {
      const batch = queue.splice(0, CONCURRENCY);
      await Promise.allSettled(batch.map(({ url, jobId }) => runScrapeJob({ jobId, url, selectors, mode, options, notify })));
    }
  })().catch(() => {});
});

// Proxies
app.get('/api/proxies', (req, res) => res.json(proxies));
app.post('/api/proxies', (req, res) => {
  const { proxyUrls } = req.body;
  if (!proxyUrls?.length) return res.status(400).json({ error: 'proxyUrls requis' });
  let added = 0;
  (Array.isArray(proxyUrls) ? proxyUrls : [proxyUrls]).forEach(u => { if (addProxy(u.trim())) added++; });
  res.json({ added, total: proxies.length });
});
app.delete('/api/proxies/:idx', (req, res) => {
  const i = parseInt(req.params.idx);
  if (i >= 0 && i < proxies.length) { proxies.splice(i, 1); res.json({ success: true }); }
  else res.status(404).json({ error: 'Not found' });
});
app.delete('/api/proxies', (req, res) => { proxies.length = 0; res.json({ success: true }); });
app.post('/api/proxies/test', async (req, res) => {
  try {
    const agent = new HttpsProxyAgent(req.body.proxyUrl);
    const r = await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 8000 });
    res.json({ success: true, ip: r.data.ip });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Schedules
app.get('/api/schedules', (req, res) => res.json(
  Array.from(schedules.entries()).map(([id, s]) => ({
    id, url: s.config.url, cronExpr: s.config.cronExpr, cronHuman: s.config.cronHuman,
    mode: s.config.mode, selectors: s.config.selectors, active: s.active,
    lastRun: s.lastRun, runCount: s.runCount,
  }))
));
app.post('/api/schedules', (req, res) => {
  const { url, cronExpr, cronHuman, mode = 'axios', selectors = {}, options = {} } = req.body;
  if (!url || !cronExpr) return res.status(400).json({ error: 'url et cronExpr requis' });
  if (!cron.validate(cronExpr)) return res.status(400).json({ error: 'Expression cron invalide' });
  const id = uuidv4();
  const config = { url, cronExpr, cronHuman: cronHuman || cronExpr, mode, selectors, options };
  const entry = { config, active: true, lastRun: null, runCount: 0 };
  entry.task = cron.schedule(cronExpr, async () => {
    console.log(`⏰ Cron: ${url}`);
    entry.lastRun = new Date().toISOString();
    entry.runCount++;
    runScrapeJob({ url, selectors, mode, options, notify: true }).catch(e => console.error('Cron error:', e.message));
  });
  schedules.set(id, entry);
  res.json({ id, ...config, active: true });
});
app.patch('/api/schedules/:id/toggle', (req, res) => {
  const s = schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.active ? s.task.stop() : s.task.start();
  s.active = !s.active;
  res.json({ active: s.active });
});
app.delete('/api/schedules/:id', (req, res) => {
  const s = schedules.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.task.destroy(); schedules.delete(req.params.id);
  res.json({ success: true });
});

// Settings
app.get('/api/settings', (req, res) => {
  const safe = JSON.parse(JSON.stringify(settings));
  if (safe.smtp?.pass) safe.smtp.pass = '••••••••';
  if (safe.googleSheets?.credentialsJson && safe.googleSheets.credentialsJson.length > 5)
    safe.googleSheets.credentialsJson = '[configuré ✓]';
  res.json(safe);
});
app.put('/api/settings', (req, res) => {
  const { smtp, webhook, notifyEmail, googleSheets } = req.body;
  if (smtp) {
    const prevPass = settings.smtp.pass;
    settings.smtp = { ...settings.smtp, ...smtp };
    if (smtp.pass === '••••••••') settings.smtp.pass = prevPass;
  }
  if (webhook !== undefined) settings.webhook = webhook;
  if (notifyEmail !== undefined) settings.notifyEmail = notifyEmail;
  if (googleSheets) settings.googleSheets = { ...settings.googleSheets, ...googleSheets };
  res.json({ success: true });
});
app.post('/api/settings/test-email', async (req, res) => {
  try {
    const t = nodemailer.createTransport({ host: settings.smtp.host, port: settings.smtp.port || 587, secure: settings.smtp.port == 465, auth: { user: settings.smtp.user, pass: settings.smtp.pass } });
    await t.sendMail({ from: settings.smtp.from || settings.smtp.user, to: settings.notifyEmail, subject: '[WebCrawlr] Test ✅', text: 'Configuration email OK !' });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/settings/test-webhook', async (req, res) => {
  try {
    await axios.post(settings.webhook, { event: 'test', message: 'WebCrawlr OK', timestamp: new Date().toISOString() }, { timeout: 8000 });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🕷️  WebCrawlr v2.0 → port ${PORT}`);
  console.log('   Proxy rotation ✓  Scheduler ✓  Notifications ✓  Google Sheets ✓');
});
