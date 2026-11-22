import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import vm from 'node:vm';
import express from 'express';
import { createAttributionRouter } from '../attribution-router';
import { LocalAttributionStore } from '../attribution-store';
import { createAttributionBusinessHooks } from '../attribution-business';
import { SyntheticAttributionBusiness } from './attribution-business-fixture';
import { issueAdminSession, verifyAdminSession, isSameOriginWrite, safeEqual } from '../security';
import { attributionOwnerTransferScript } from '../attribution-owner-transfer';

type WebsiteBridge = { setConsent(value: object): void; decorate(anchor: { href: string }): void };
type ConfiguratorBridge = { applyConsent(value: object): void; decorate(anchor: { href: string }): void };
type CreateWebsite = (options: object) => WebsiteBridge;
type CreateConfigurator = (options: object) => ConfiguratorBridge;

const main = async (): Promise<void> => {
  const [websitePath, configuratorPath] = process.argv.slice(2);
  if (!websitePath || !configuratorPath) throw new Error('Provide the two frontend module paths as arguments.');
  const website = require(resolve(websitePath)) as { createBridge: CreateWebsite };
  const configurator = require(resolve(configuratorPath)) as { createAttributionBridge: CreateConfigurator };
  const now = Date.parse('2026-01-01T00:00:00Z');
  const origin = 'https://lksdisplaybox.online';
  const ownerOrigin = 'https://owner.example.test';
  const ownerSecret = 'synthetic-owner-secret';
  const ownerCsrf = 'synthetic-csrf-token';
  const dir = mkdtempSync(join(tmpdir(), 'attribution-peer-'));
  const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 4));
  const business = new SyntheticAttributionBusiness(new Map([
    ['demo-paid', { source: 'instagram', recordId: 'campaign-demo' }],
  ]));
  const hooks = createAttributionBusinessHooks(store, business, () => now, message => { throw new Error(message); });
  const app = express();
  app.use(createAttributionRouter({
    enabled: true, store, validation: { publicPaths: new Set(['/', '/display-box/', '/configurator/']), campaignKeys: new Set(['demo-paid']) },
    now: () => now, allowRequest: () => true,
    requireOwner: (req, res, next) => {
      if (verifyAdminSession(req.get('x-test-session') || '', 'owner', ownerSecret, now)) next();
      else res.sendStatus(401);
    },
    requireOwnerOriginAndCsrf: (req, res, next) => {
      if (isSameOriginWrite(req.get('origin'), '', ownerOrigin) && safeEqual(req.get('x-csrf-token') || '', ownerCsrf)) next();
      else res.sendStatus(403);
    },
    reportError: message => { throw new Error(message); },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(done => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const create = async (path: string, body: unknown, headers: Record<string, string>) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ shortCode: string }>;
  };
  const revoke = async (body: unknown) => {
    const response = await fetch(base + '/api/attribution/v1/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 204);
  };
  const resolveOwner = async (code: string) => {
    const response = await fetch(base + '/admin/attribution/v1/resolve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', origin: ownerOrigin, 'x-csrf-token': ownerCsrf,
        'x-test-session': issueAdminSession('owner', ownerSecret, now),
      },
      body: JSON.stringify({ contractVersion: '1.0.0', shortCode: code }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { outcome: string }).outcome, 'matched');
  };
  const makeStorage = () => {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
  };
  const grant = { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };
  const scenarios = [
    { href: `${origin}/display-box/?gclid=synthetic123456789012345`, referrer: '', channel: 'google_ads' },
    { href: `${origin}/display-box/`, referrer: 'https://www.google.com/', channel: 'google_organic' },
    { href: `${origin}/display-box/?utm_source=instagram&utm_medium=paid_social&utm_campaign=demo-paid`, referrer: '', channel: 'meta_ads' },
    { href: `${origin}/`, referrer: '', channel: 'direct' },
  ];
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const storage = makeStorage();
      const location = new URL(scenario.href);
      const win = {
        location, document: { referrer: scenario.referrer }, localStorage: storage, crypto: webcrypto,
        addEventListener() {}, removeEventListener() {},
      };
      let registration: Promise<{ shortCode: string }> | undefined;
      const bridge = website.createBridge({
        enabled: true, window: win, now: () => now, publicPaths: ['/', '/display-box/', '/configurator/'],
        campaignKeys: ['demo-paid'], approvedDestinations: ['https://wa.example.test/send'],
        adapter: {
          create: (path: string, body: unknown, headers: Record<string, string>) => {
            registration = create(path, body, headers); return registration;
          },
          revoke: (_path: string, body: unknown) => revoke(body),
        },
      });
      bridge.setConsent(grant);
      await new Promise<void>(done => setImmediate(done));
      if (!registration) throw new Error('Website did not register a handoff.');
      const receipt = await registration;
      await new Promise<void>(done => setImmediate(done));
      assert.equal(store.resolve(receipt.shortCode, now)?.lastTouch.channel, scenario.channel);
      await resolveOwner(receipt.shortCode);
      const inquiryId = `inquiry-${index}`;
      const quoteId = `quote-${index}`;
      const orderId = `order-${index}`;
      let selectedCode = `[${receipt.shortCode}]`;
      if (index === 0) {
        assert.equal(hooks.inquiry(selectedCode, inquiryId).outcome, 'matched');
        const ownerWindow: { sessionStorage: ReturnType<typeof makeStorage>; lksAttributionOwnerSelection?: {
          remember(inquiry: string, code: string): void; take(inquiry: string): string;
        } } = { sessionStorage: makeStorage() };
        vm.runInNewContext(attributionOwnerTransferScript.replace(/^<script>\n|\n<\/script>$/g, ''), {
          window: ownerWindow, console, Date: { now: () => now }, Number, JSON,
        });
        if (!ownerWindow.lksAttributionOwnerSelection) throw new Error('Expected owner selection helper.');
        ownerWindow.lksAttributionOwnerSelection.remember(inquiryId, receipt.shortCode);
        selectedCode = ownerWindow.lksAttributionOwnerSelection.take(inquiryId);
      }
      hooks.quote(selectedCode, inquiryId, quoteId);
      hooks.order(quoteId, orderId);
      assert.equal(business.inquiries.get(inquiryId)?.first.lastTouch.channel, scenario.channel);
      assert.equal(business.quotes.get(quoteId)?.lastTouch.channel, scenario.channel);
      assert.equal(business.orders.get(orderId)?.lastTouch.channel, scenario.channel);
      if (scenario.channel === 'meta_ads') assert.equal(business.attributions.get(receipt.shortCode)?.lastCampaign, 'campaign-demo');
      const anchor = { href: 'https://wa.example.test/send?text=synthetic' };
      bridge.decorate(anchor);
      assert.ok(new URL(anchor.href).searchParams.get('text')?.includes(`[${receipt.shortCode}]`));
      if (index === 0) {
        const before = JSON.parse(storage.getItem('lks_attribution_bridge_v1') || 'null');
        const childLocation = new URL(`${origin}/configurator/`);
        const childWindow = { location: childLocation, localStorage: storage, crypto: webcrypto, addEventListener() {}, parent: null };
        let childRegistration: Promise<{ shortCode: string }> | undefined;
        const child = configurator.createAttributionBridge({
          enabled: true, windowRef: childWindow, documentRef: { referrer: `${origin}/display-box/` },
          now: () => now, approvedCampaignKeys: ['demo-paid'],
          adapter: {
            create: (request: { path: string; body: unknown; headers: Record<string, string> }) => {
              childRegistration = create(request.path, request.body, request.headers); return childRegistration;
            },
            revoke: (request: { body: unknown }) => revoke(request.body),
          },
        });
        child.applyConsent({ marketing: true, statistics: true });
        await new Promise<void>(done => setImmediate(done));
        if (!childRegistration) throw new Error('Configurator did not register a handoff.');
        const childReceipt = await childRegistration;
        const after = JSON.parse(storage.getItem('lks_attribution_bridge_v1') || 'null');
        assert.deepEqual(after, before);
        assert.equal(store.resolve(childReceipt.shortCode, now)?.lastTouch.channel, 'google_ads');
        await resolveOwner(childReceipt.shortCode);
        hooks.quote(childReceipt.shortCode, inquiryId, 'quote-child');
        hooks.order('quote-child', 'order-child');
        assert.equal(business.quotes.get('quote-child')?.lastTouch.channel, 'google_ads');
        assert.equal(business.orders.get('order-child')?.lastTouch.channel, 'google_ads');
      }
      {
        const storage = makeStorage();
        const win = {
          location: new URL(`${origin}/`), document: { referrer: '' }, localStorage: storage, crypto: webcrypto,
          addEventListener() {}, removeEventListener() {},
        };
        let registration: Promise<{ shortCode: string }> | undefined;
        let release: ((response: { shortCode: string }) => void) | undefined;
        let invalidated: (() => void) | undefined;
        const invalidation = new Promise<void>(done => { invalidated = done; });
        const bridge = website.createBridge({
          enabled: true, window: win, now: () => now, publicPaths: ['/'], campaignKeys: [],
          approvedDestinations: ['https://wa.example.test/send'],
          adapter: {
            create: (path: string, value: unknown, headers: Record<string, string>) => {
              registration = create(path, value, headers);
              return new Promise<{ shortCode: string }>(done => { release = done; });
            },
            revoke: async (_path: string, value: unknown) => { await revoke(value); invalidated?.(); },
          },
        });
        bridge.setConsent({});
        await new Promise<void>(done => setImmediate(done));
        assert.equal(Boolean(registration), false);
        assert.equal(storage.getItem('lks_attribution_bridge_v1'), null);
        const lateBridge = website.createBridge({
          enabled: true, window: win, now: () => now, publicPaths: ['/'], campaignKeys: [],
          approvedDestinations: ['https://wa.example.test/send'],
          adapter: {
            create: (path: string, value: unknown, headers: Record<string, string>) => {
              registration = create(path, value, headers);
              return new Promise<{ shortCode: string }>(done => { release = done; });
            },
            revoke: async (_path: string, value: unknown) => { await revoke(value); invalidated?.(); },
          },
        });
        lateBridge.setConsent(grant);
        await new Promise<void>(done => setImmediate(done));
        if (!registration || !release) throw new Error('Expected delayed registration.');
        const response = await registration;
        lateBridge.setConsent({});
        release(response);
        await invalidation;
        assert.equal(store.resolve(response.shortCode, now), null);
        const anchor = { href: 'https://wa.example.test/send?text=synthetic' };
        lateBridge.decorate(anchor);
        assert.ok(new URL(anchor.href).searchParams.get('text')?.includes('[LKS-UNKNOWN]'));
      }
    }
    process.stdout.write('Five frontend-to-router-to-business synthetic paths passed.\n');
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

main().catch(error => { console.error(error); process.exitCode = 1; });
