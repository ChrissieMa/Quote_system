import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { AddressInfo } from 'node:net';
import ts from 'typescript';
import { createAttributionRouter } from '../attribution-router';
import { LocalAttributionStore } from '../attribution-store';

type Observation = { method: string; path: string; origin: string | null; cookie: string | null };

const websiteOrigin = 'https://lksdisplaybox.online';
const apiOrigin = 'https://quote.lksdisplaybox.online';
const handoffPath = '/api/attribution/v1/handoffs';
const requestId = `ar_v1_${'a'.repeat(32)}`;
const request = {
  contractVersion: '1.0.0',
  requestId,
  attributionId: `aid_v1_${'b'.repeat(32)}`,
  firstTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  lastTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  entrySurface: 'wordpress',
  consent: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
};

const runBrowser = (binary: string, page: string, profile: string): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--host-resolver-rules=MAP lksdisplaybox.online 127.0.0.1,MAP quote.lksdisplaybox.online 127.0.0.1,MAP evil.example.test 127.0.0.1,MAP * ~NOTFOUND',
    `--user-data-dir=${profile}`, '--virtual-time-budget=5000', '--dump-dom', page,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('close', code => {
    clearTimeout(timeout);
    if (code === 0) resolve(output);
    else reject(new Error(`Synthetic browser exited with ${code}: ${errors.slice(-1000)}`));
  });
});

const main = async (): Promise<void> => {
  const [browserPath] = process.argv.slice(2);
  if (!browserPath || browserPath.startsWith('-')) throw new Error('Provide the local browser executable as a CLI argument.');
  const dir = mkdtempSync(join(tmpdir(), 'attribution-browser-'));
  const keyPath = join(dir, 'fixture-key.pem');
  const certificatePath = join(dir, 'fixture-cert.pem');
  const certificate = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=lksdisplaybox.online',
    '-addext', 'subjectAltName=DNS:lksdisplaybox.online,DNS:quote.lksdisplaybox.online,DNS:evil.example.test',
    '-keyout', keyPath, '-out', certificatePath,
  ], { stdio: 'ignore' });
  if (certificate.status !== 0) throw new Error('Unable to create the temporary synthetic TLS certificate.');

  const clientSource = readFileSync(join(__dirname, '../attribution-browser-adapter.ts'), 'utf8');
  const clientModule = ts.transpileModule(clientSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const observations: Observation[] = [];
  const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 9));
  const app = express();
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/attribution/')) {
      observations.push({
        method: req.method,
        path: req.originalUrl,
        origin: req.get('origin') || null,
        cookie: req.get('cookie') || null,
      });
    }
    next();
  });
  app.get('/adapter.js', (_req, res) => res.type('text/javascript').send(clientModule));
  app.get('/', (req, res) => {
    if (req.hostname === 'evil.example.test') {
      res.type('html').send(`<body data-result="pending"><script>
        const request=${JSON.stringify(request)};
        const url='${apiOrigin}${handoffPath}';
        fetch(url,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json','Idempotency-Key':request.requestId},body:JSON.stringify(request)})
          .then(()=>document.body.dataset.result='unexpectedly-allowed')
          .catch(()=>document.body.dataset.result='blocked');
      </script></body>`);
      return;
    }
    res.type('html').send(`<body data-result="pending" data-opaque="pending"><script type="module">
      import {createAttributionBrowserAdapter} from '/adapter.js';
      const request=${JSON.stringify(request)};
      document.cookie='attribution-probe=present; Domain=lksdisplaybox.online; Secure; SameSite=None; Path=/';
      try {
        const api=createAttributionBrowserAdapter(window,window.fetch.bind(window));
        const result=await api.create('${handoffPath}',request,{'Idempotency-Key':request.requestId});
        document.body.dataset.result=result.shortCode?'accepted':'invalid-response';
      } catch { document.body.dataset.result='failed'; }
      const frame=document.createElement('iframe');
      frame.sandbox='allow-scripts';
      frame.srcdoc=\`<script>
        const request=\${JSON.stringify(request)};
        fetch('${apiOrigin}${handoffPath}',{method:'POST',mode:'cors',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json','Idempotency-Key':request.requestId},body:JSON.stringify(request)})
          .then(()=>parent.postMessage('opaque-accepted','*'))
          .catch(()=>parent.postMessage('opaque-blocked','*'));
      <\\/script>\`;
      window.addEventListener('message',event=>{if(event.data==='opaque-blocked'||event.data==='opaque-accepted')document.body.dataset.opaque=event.data;});
      document.body.appendChild(frame);
    </script></body>`);
  });
  app.use(createAttributionRouter({
    enabled: true,
    store,
    validation: { publicPaths: new Set(['/']), campaignKeys: new Set() },
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    allowRequest: () => true,
    requireOwner: (_req, _res, next) => next(),
    requireOwnerOriginAndCsrf: (_req, _res, next) => next(),
    reportError: () => { throw new Error('Synthetic backend route failed.'); },
  }));
  const server = createServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certificatePath),
  }, app);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(443, '127.0.0.1', () => resolve());
    });
    const website = await runBrowser(browserPath, websiteOrigin, join(dir, 'chrome-website'));
    assert.match(website, /data-result="accepted"/);
    assert.match(website, /data-opaque="opaque-blocked"/);
    const disallowed = await runBrowser(browserPath, 'https://evil.example.test/', join(dir, 'chrome-disallowed'));
    assert.match(disallowed, /data-result="blocked"/);
    assert.ok(observations.some(item => item.method === 'OPTIONS' && item.origin === websiteOrigin));
    assert.ok(observations.some(item => item.method === 'OPTIONS' && item.origin === 'null'));
    assert.ok(observations.some(item => item.method === 'OPTIONS' && item.origin === 'https://evil.example.test'));
    const posts = observations.filter(item => item.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].origin, websiteOrigin);
    assert.equal(posts[0].path, handoffPath);
    assert.equal(posts[0].cookie, null);
    process.stdout.write('Synthetic Chrome CORS/preflight passed: Website allowed; opaque and disallowed origins blocked; one credential-free fixed-path POST.\n');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

main().catch(error => { console.error(error); process.exitCode = 1; });
