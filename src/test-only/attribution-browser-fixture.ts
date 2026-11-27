import assert from 'node:assert/strict';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import express from 'express';
import { AddressInfo } from 'node:net';
import ts from 'typescript';
import { createAttributionRouter } from '../attribution-router';
import { LocalAttributionStore } from '../attribution-store';

type Observation = {
  method: string;
  path: string;
  origin: string | null;
  requestedMethod: string | null;
  requestedHeaders: string | null;
  contentType: string | null;
  idempotencyKey: string | null;
  cookie: string | null;
  statusCode: number;
};

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type PendingCommand = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const websiteOrigin = 'https://lksdisplaybox.online';
const apiOrigin = 'https://quote.lksdisplaybox.online';
const disallowedOrigin = 'https://evil.example.test';
const handoffPath = '/api/attribution/v1/handoffs';
const revokePath = '/api/attribution/v1/revoke';
const requestId = `ar_v1_${'a'.repeat(32)}`;
const browserFlags = (profile: string): string[] => [
  '--headless=new',
  '--disable-gpu',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-proxy-server',
  '--host-resolver-rules=MAP lksdisplaybox.online 127.0.0.1,MAP quote.lksdisplaybox.online 127.0.0.1,MAP evil.example.test 127.0.0.1,MAP * ~NOTFOUND',
  `--user-data-dir=${profile}`,
  '--remote-debugging-pipe',
  'about:blank',
];

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

const pageSource = (): string => `<html><body data-result="pending" data-revoke="pending" data-opaque-guard="pending" data-opaque="pending" data-bad-header="pending" data-bad-path="pending" data-done="false">
  <script type="module">
    import {createAttributionBrowserAdapter} from '/adapter.js';
    const request=${JSON.stringify(request)};
    const api=createAttributionBrowserAdapter(window,window.fetch.bind(window));
    try {
      const result=await api.create('${handoffPath}',request,{'Idempotency-Key':request.requestId});
      document.body.dataset.result=result.shortCode?'accepted':'invalid-response';
      await api.revoke('${revokePath}',{
        contractVersion:'1.0.0',attributionId:request.attributionId,revocationProof:result.revocationProof,
      });
      document.body.dataset.revoke='accepted';
      try { await api.create('/api/attribution/v1/invalid',request,{'Idempotency-Key':request.requestId}); }
      catch { document.body.dataset.badPath='blocked'; }
      try {
        await fetch('${apiOrigin}${handoffPath}',{method:'POST',mode:'cors',credentials:'omit',
          headers:{'Content-Type':'application/json','X-Unexpected':'x'},body:JSON.stringify(request)});
        document.body.dataset.badHeader='unexpectedly-allowed';
      } catch { document.body.dataset.badHeader='blocked'; }
    } catch { document.body.dataset.result='failed'; }
    const frame=document.createElement('iframe');
    frame.sandbox='allow-scripts';
    frame.srcdoc=\`<script>
      const request=\${JSON.stringify(request)};
      window.addEventListener('message',async event=>{
        if(event.source!==parent||event.data!=='opaque-start') return;
        try {
          const module=await import('${websiteOrigin}/adapter.js');
          let calls=0;
          const api=module.createAttributionBrowserAdapter(window,()=>{calls++;throw new Error('unexpected fetch');});
          try { await api.create('${handoffPath}',request,{'Idempotency-Key':request.requestId}); }
          catch { parent.postMessage(calls===0?'opaque-guard-blocked':'opaque-guard-fetched','*'); }
        } catch { parent.postMessage('opaque-guard-failed','*'); }
        fetch('${apiOrigin}${handoffPath}',{method:'POST',mode:'cors',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json','Idempotency-Key':request.requestId},body:JSON.stringify(request)})
          .then(()=>parent.postMessage('opaque-accepted','*'))
          .catch(()=>parent.postMessage('opaque-blocked','*'));
      },{once:true});
      parent.postMessage('opaque-ready','*');
    <\\/script>\`;
    const opaqueResult=await new Promise(resolve=>{
      const timer=setTimeout(()=>resolve('timeout'),3000);
      let frameReady=false;
      let started=false;
      window.__lksStartOpaque=()=>{
        if(frameReady&&window.__lksInterceptReady&&!started){
          started=true;
          frame.contentWindow.postMessage('opaque-start','*');
        }
      };
      window.addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.origin!=='null') return;
        if(event.data==='opaque-ready'){frameReady=true;window.__lksStartOpaque();return;}
        if(event.data.startsWith('opaque-guard-')){document.body.dataset.opaqueGuard=event.data;return;}
        if(event.data==='opaque-blocked'||event.data==='opaque-accepted'){
          clearTimeout(timer);
          resolve(event.data);
        }
      });
      document.body.appendChild(frame);
    });
    document.body.dataset.opaque=opaqueResult;
    document.body.dataset.done='true';
  </script>
</body></html>`;

const disallowedPage = (): string => `<html><body data-result="pending" data-done="false"><script>
  const request=${JSON.stringify(request)};
  fetch('${apiOrigin}${handoffPath}',{method:'POST',mode:'cors',credentials:'omit',redirect:'error',headers:{'Content-Type':'application/json','Idempotency-Key':request.requestId},body:JSON.stringify(request)})
    .then(()=>document.body.dataset.result='unexpectedly-allowed')
    .catch(()=>document.body.dataset.result='blocked')
    .finally(()=>document.body.dataset.done='true');
</script></body></html>`;

export class CdpPipe {
  private nextId = 0;
  private buffer = '';
  private startupStderr = '';
  private failure: Error | null = null;
  private receivedMessages = 0;
  private readonly pending = new Map<number, PendingCommand>();
  onEvent: (message: CdpMessage) => void = () => undefined;

  constructor(private readonly input: Writable, output: Readable, browser?: ChildProcess) {
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => this.receive(chunk));
    output.on('error', error => this.failAll(error));
    input.on('error', error => this.failAll(error));
    if (browser) {
      // This child has only the fixture HOME/PATH and synthetic network. Keep a
      // bounded startup diagnostic, never inherited credentials/environment.
      browser.stderr?.setEncoding('utf8');
      browser.stderr?.on('data', (chunk: string) => {
        this.startupStderr = (this.startupStderr + chunk).slice(-8192);
      });
      browser.once('error', error => this.failAll(this.diagnostic(`Chrome launch failed: ${error.message}`)));
      browser.once('close', (code, signal) => {
        this.failAll(this.diagnostic(`Chrome exited (code=${code}, signal=${signal})`));
      });
    } else {
      output.once('end', () => this.failAll(new Error('Chrome DevTools output pipe closed.')));
    }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.diagnostic(`Chrome DevTools command timed out: ${method}`));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }

  private diagnostic(message: string): Error {
    return new Error(`${message}; receivedCDPMessages=${this.receivedMessages}${this.startupStderr.trim() ? `\nChrome startup stderr:\n${this.startupStderr.trim()}` : ''}`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let separator = this.buffer.indexOf('\0');
    while (separator !== -1) {
      const text = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + 1);
      separator = this.buffer.indexOf('\0');
      if (!text) continue;
      const message = JSON.parse(text) as CdpMessage;
      this.receivedMessages++;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'Chrome DevTools command failed.'));
        else pending.resolve(message.result || {});
      } else {
        this.onEvent(message);
      }
    }
  }

  private failAll(error: Error): void {
    this.failure = this.failure || error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
      this.pending.delete(id);
    }
  }
}

const getHeader = (headers: Record<string, unknown>, name: string): string | null => {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry && typeof entry[1] === 'string' ? entry[1] : null;
};

const fulfill = async (
  cdp: CdpPipe,
  requestId: string,
  status: number,
  headers: Array<{ name: string; value: string }>,
  body = '',
  sessionId?: string,
): Promise<void> => {
  await cdp.send('Fetch.fulfillRequest', {
    requestId,
    responseCode: status,
    responseHeaders: headers,
    ...(body ? { body: Buffer.from(body).toString('base64') } : {}),
  }, sessionId);
};

const fail = async (cdp: CdpPipe, requestId: string, sessionId?: string): Promise<void> => {
  await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
};

const pageDone = async (cdp: CdpPipe, sessionId: string): Promise<string> => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await cdp.send('Runtime.evaluate', {
      expression: 'document.body && document.body.dataset.done === "true"',
      returnByValue: true,
    }, sessionId);
    const value = (result.result as { value?: unknown } | undefined)?.value;
    if (value === true) {
      const html = await cdp.send('Runtime.evaluate', {
        expression: 'document.body.outerHTML',
        returnByValue: true,
      }, sessionId);
      return String((html.result as { value?: unknown } | undefined)?.value || '');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Synthetic browser page did not complete its bounded request promises.');
};

const main = async (): Promise<void> => {
  const [browserPath] = process.argv.slice(2);
  if (!browserPath || browserPath.startsWith('-')) throw new Error('Provide the local browser executable as a CLI argument.');
  const dir = mkdtempSync(join(tmpdir(), 'attribution-browser-'));
  chmodSync(dir, 0o711);
  const profile = join(dir, 'chrome-profile');
  mkdirSync(profile, { mode: 0o700 });
  if (process.platform !== 'linux') throw new Error('The normal-sandbox browser fixture requires Linux.');
  const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  let rootDropIdentity: { uid: number; gid: number } | null = null;
  if (runningAsRoot) {
    const uidResult = spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' });
    const gidResult = spawnSync('id', ['-g', 'nobody'], { encoding: 'utf8' });
    if (uidResult.status !== 0 || gidResult.status !== 0) throw new Error('An existing unprivileged browser account is required.');
    const uid = Number(uidResult.stdout.trim());
    const gid = Number(gidResult.stdout.trim());
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('Invalid unprivileged browser account.');
    chownSync(profile, uid, gid);
    rootDropIdentity = { uid, gid };
  }

  const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 9));
  const observations: Observation[] = [];
  const intercepted: Array<{ method: string; url: string; origin: string | null; headerNames: string[] }> = [];
  const browserNetwork: Array<Record<string, unknown>> = [];
  const routingErrors: string[] = [];
  const app = express();
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/attribution/')) {
      const observation: Observation = {
        method: req.method,
        path: req.originalUrl,
        origin: req.get('origin') || null,
        requestedMethod: req.get('access-control-request-method') || null,
        requestedHeaders: req.get('access-control-request-headers') || null,
        contentType: req.get('content-type') || null,
        idempotencyKey: req.get('Idempotency-Key') || null,
        cookie: req.get('cookie') || null,
        statusCode: 0,
      };
      observations.push(observation);
      res.once('finish', () => { observation.statusCode = res.statusCode; });
    }
    next();
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
  const server = createServer(app);
  let browser: ChildProcess | null = null;
  let cdp: CdpPipe | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const adapterSource = readFileSync(join(__dirname, '../attribution-browser-adapter.ts'), 'utf8');
    const adapterModule = ts.transpileModule(adapterSource, {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const websiteHtml = pageSource();
    const allowedOrigins = new Set([websiteOrigin, disallowedOrigin]);

    const executable = rootDropIdentity ? '/usr/bin/setpriv' : browserPath;
    const args = rootDropIdentity
      ? [`--reuid=${rootDropIdentity.uid}`, `--regid=${rootDropIdentity.gid}`, '--init-groups', '--', browserPath, ...browserFlags(profile)]
      : browserFlags(profile);
    browser = spawn(executable, args, {
      env: { HOME: profile, PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    const input = browser.stdio[3];
    const output = browser.stdio[4];
    if (!(input instanceof Writable) || !(output instanceof Readable)) {
      throw new Error('Chrome DevTools pipe was not created.');
    }
    cdp = new CdpPipe(input, output, browser);
    cdp.onEvent = message => {
      if (message.method === 'Target.attachedToTarget' && message.params) {
        const childSessionId = String(message.params.sessionId || '');
        const info = message.params.targetInfo as { type?: string } | undefined;
        browserNetwork.push({
          event: message.method, type: info?.type || '',
          waitingForDebugger: message.params.waitingForDebugger === true,
        });
        if (!childSessionId || info?.type !== 'iframe') return;
        void (async () => {
          await cdp!.send('Network.enable', {}, childSessionId);
          await cdp!.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, childSessionId);
          await cdp!.send('Runtime.runIfWaitingForDebugger', {}, childSessionId);
          if (!message.sessionId) throw new Error('Missing parent session for iframe interception.');
          await cdp!.send('Runtime.evaluate', {
            expression: 'window.__lksInterceptReady=true;window.__lksStartOpaque?.()',
          }, message.sessionId);
        })().catch(error => {
          routingErrors.push(error instanceof Error ? error.message : 'Unable to enable child-target interception.');
        });
        return;
      }
      if (message.method === 'Network.loadingFailed' && message.params) {
        const p = message.params as {
          requestId?: string; errorText?: string; blockedReason?: string;
          corsErrorStatus?: { corsError?: string; failedParameter?: string };
        };
        browserNetwork.push({
          event: message.method, sessionId: message.sessionId || '', requestId: p.requestId || '', errorText: p.errorText || '',
          blockedReason: p.blockedReason || '', corsErrorStatus: p.corsErrorStatus || null,
        });
        return;
      }
      if (message.method === 'Network.requestWillBeSent' && message.params) {
        const p = message.params as { requestId?: string; frameId?: string; type?: string; request?: { url?: string; method?: string } };
        const url = String(p.request?.url || '').split('?')[0];
        browserNetwork.push({
          event: message.method, sessionId: message.sessionId || '', requestId: p.requestId || '', frameId: p.frameId || '',
          type: p.type || '', method: p.request?.method || '', url,
        });
        return;
      }
      if ((message.method === 'Page.frameAttached' || message.method === 'Page.frameNavigated') && message.params) {
        const p = message.params as { frameId?: string; parentFrameId?: string; frame?: { id?: string; parentId?: string; securityOrigin?: string; url?: string } };
        browserNetwork.push({
          event: message.method, sessionId: message.sessionId || '', frameId: p.frameId || p.frame?.id || '',
          parentFrameId: p.parentFrameId || p.frame?.parentId || '',
          origin: p.frame?.securityOrigin || '', url: p.frame?.url || '',
        });
        return;
      }
      if (message.method !== 'Fetch.requestPaused' || !message.params) return;
      const params = message.params as {
        requestId: string;
        request: { url: string; method: string; headers: Record<string, unknown>; postData?: string };
      };
      const sessionId = message.sessionId;
      void (async () => {
        const url = new URL(params.request.url);
        const method = params.request.method;
        intercepted.push({
          method,
          url: `${url.origin}${url.pathname}`,
          origin: getHeader(params.request.headers, 'origin'),
          headerNames: Object.keys(params.request.headers).map(name => name.toLowerCase()).sort(),
        });
        if (method === 'GET' && allowedOrigins.has(url.origin) && url.pathname === '/' && !url.search && !url.hash) {
          await fulfill(cdp!, params.requestId, 200, [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            url.origin === websiteOrigin ? websiteHtml : disallowedPage(), sessionId);
          return;
        }
        if (method === 'GET' && url.origin === websiteOrigin && url.pathname === '/adapter.js' && !url.search && !url.hash) {
          const headers = [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }];
          if (getHeader(params.request.headers, 'origin') === 'null') {
            headers.push({ name: 'Access-Control-Allow-Origin', value: 'null' });
          }
          await fulfill(cdp!, params.requestId, 200, headers,
            adapterModule, sessionId);
          return;
        }
        const apiPaths = new Set([handoffPath, revokePath]);
        const isApiRequest = url.origin === apiOrigin && apiPaths.has(url.pathname)
          && !url.search && !url.hash && (method === 'OPTIONS' || method === 'POST');
        if (!isApiRequest) {
          await fail(cdp!, params.requestId, sessionId);
          return;
        }
        const headers: Record<string, string> = {};
        const permittedHeaders = method === 'OPTIONS'
          ? ['origin', 'access-control-request-method', 'access-control-request-headers']
          : ['origin', 'content-type', 'idempotency-key'];
        for (const name of permittedHeaders) {
          const value = getHeader(params.request.headers, name);
          if (value !== null) headers[name] = value;
        }
        let body = params.request.postData;
        if (method === 'POST' && body === undefined) {
          const postData = await cdp!.send('Fetch.getRequestPostData', { requestId: params.requestId }, sessionId);
          body = typeof postData.postData === 'string' ? postData.postData : '';
        }
        const response = await fetch(`http://127.0.0.1:${port}${url.pathname}`, {
          method,
          headers,
          ...(method === 'POST' ? { body: body || '' } : {}),
        });
        const responseHeaders = [...response.headers.entries()]
          .filter(([name]) => !['connection', 'content-length', 'transfer-encoding'].includes(name.toLowerCase()))
          .map(([name, value]) => ({ name, value }));
        const responseBody = method === 'OPTIONS' || response.status === 204 ? '' : await response.text();
        await fulfill(cdp!, params.requestId, response.status, responseHeaders, responseBody, sessionId);
      })().catch(error => {
        routingErrors.push(error instanceof Error ? error.message : 'Unknown synthetic request routing failure.');
        void fail(cdp!, params.requestId, sessionId);
      });
    };

    const version = await cdp.send('Browser.getVersion');
    process.stdout.write(JSON.stringify({ event: 'BROWSER_CONTROL_READY', product: version.product,
      protocolVersion: version.protocolVersion }) + '\n');
    const targets = await cdp.send('Target.getTargets');
    const targetInfos = targets.targetInfos as Array<{ targetId: string; type: string; url: string }> | undefined;
    const target = targetInfos?.find(item => item.type === 'page' && item.url === 'about:blank');
    if (!target) throw new Error('Chrome did not create its initial synthetic page target.');
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = String(attached.sessionId || '');
    if (!sessionId) throw new Error('Unable to attach to the synthetic Chrome page.');
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
    await cdp.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    }, sessionId);

    await cdp.send('Page.navigate', { url: websiteOrigin }, sessionId);
    const website = await pageDone(cdp, sessionId);
    assert.match(website, /data-result="accepted"/);
    assert.match(website, /data-revoke="accepted"/);
    assert.match(website, /data-bad-header="blocked"/);
    assert.match(website, /data-bad-path="blocked"/);
    assert.match(website, /data-opaque-guard="opaque-guard-blocked"/);
    assert.match(website, /data-opaque="opaque-blocked"/);

    await cdp.send('Page.navigate', { url: disallowedOrigin }, sessionId);
    const disallowed = await pageDone(cdp, sessionId);
    assert.match(disallowed, /data-result="blocked"/);

    assert.ok(observations.some(item => item.method === 'OPTIONS'
      && item.origin === websiteOrigin && item.statusCode === 204
      && item.requestedMethod === 'POST'
      && item.requestedHeaders === 'content-type,idempotency-key'));
    assert.ok(observations.some(item => item.method === 'OPTIONS'
      && item.origin === 'null' && item.statusCode === 403),
    JSON.stringify({ observations: observations.map(({ method, path, origin, statusCode }) => ({ method, path, origin, statusCode })), intercepted, browserNetwork, routingErrors }));
    assert.ok(observations.some(item => item.method === 'OPTIONS'
      && item.origin === disallowedOrigin && item.statusCode === 403));
    assert.ok(observations.some(item => item.method === 'OPTIONS'
      && item.origin === websiteOrigin && item.requestedHeaders === 'content-type,x-unexpected' && item.statusCode === 403));
    assert.ok(observations.some(item => item.method === 'OPTIONS'
      && item.origin === websiteOrigin && item.path === revokePath && item.statusCode === 204));
    const posts = observations.filter(item => item.method === 'POST');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].origin, websiteOrigin);
    assert.equal(posts[0].path, handoffPath);
    assert.equal(posts[0].contentType, 'application/json');
    assert.equal(posts[0].idempotencyKey, requestId);
    assert.equal(posts[0].cookie, null);
    assert.equal(posts[1].origin, websiteOrigin);
    assert.equal(posts[1].path, revokePath);
    assert.equal(posts[1].statusCode, 204);
    assert.equal(posts[1].cookie, null);
    const missingOrigin = await fetch(`http://127.0.0.1:${port}${handoffPath}`, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(missingOrigin.status, 403);
    process.stdout.write('Synthetic Chrome origin/CORS fixture passed through local CDP interception; this is not real TLS validation.\n');
  } finally {
    if (cdp) await cdp.send('Browser.close').catch(() => {
      if (browser && browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM');
    });
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      await new Promise<void>(resolve => browser!.once('close', () => resolve()));
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
