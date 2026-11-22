import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AddressInfo } from 'node:net';
import vm from 'node:vm';
import express from 'express';
import { createAttributionRouter } from '../attribution-router';
import { LocalAttributionStore } from '../attribution-store';
import { createAttributionBusinessHooks } from '../attribution-business';
import { AttributionProjector } from '../attribution-projection';
import { SerializedAirtableProjectionTransport } from '../attribution-airtable';
import { SyntheticAirtableClient, syntheticProjectionMapping } from './attribution-projection-fixture';
import { issueAdminSession, verifyAdminSession, isSameOriginWrite, safeEqual } from '../security';
import { attributionOwnerTransferScript } from '../attribution-owner-transfer';

type WebsiteBridge = { setConsent(value: object): void; decorate(anchor: { href: string }): void; connectChild(child: object): void };
type ConfiguratorBridge = { applyConsent(value: object): void; decorate(anchor: { href: string }): void };
type CreateWebsite = (options: object) => WebsiteBridge;
type CreateConfigurator = (options: object) => ConfiguratorBridge;

const main = async (): Promise<void> => {
  const [websitePath, configuratorPath, vectorsPath, wireOutputPath] = process.argv.slice(2);
  if (!websitePath || !configuratorPath) throw new Error('Provide the two frontend module paths as arguments.');
  type Touch = { channel: string; source: string; medium: string; campaignKey: string | null; evidence: string };
  const website = require(resolve(websitePath)) as { createBridge: CreateWebsite; classify(options: object): Touch };
  const configurator = require(resolve(configuratorPath)) as { createAttributionBridge: CreateConfigurator; classifyAcquisition(options: object): Touch };
  const now = Date.parse('2026-01-01T00:00:00Z');
  const origin = 'https://lksdisplaybox.online';
  const ownerOrigin = 'https://owner.example.test';
  const ownerSecret = 'synthetic-owner-secret';
  const ownerCsrf = 'synthetic-csrf-token';
  const dir = mkdtempSync(join(tmpdir(), 'attribution-peer-'));
  const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 4));
  type Vector = { id: string; marketing: boolean; statistics: boolean; url: string; referrer: string; expectedChannel: string; expectedSource: string; expectedMedium: string; expectedCampaignKey: string | null; expectedEvidence: string };
  const vectors = vectorsPath ? JSON.parse(readFileSync(resolve(vectorsPath), 'utf8')) as {
    publicLandingAllowlist: string[]; approvedCampaignKeys: string[]; scenarios: Vector[];
  } : null;
  const paths = vectors?.publicLandingAllowlist || ['/', '/display-box/', '/configurator/'];
  const campaigns = vectors?.approvedCampaignKeys || ['demo-paid'];
  const transport = new SyntheticAirtableClient();
  const mapping = syntheticProjectionMapping();
  if (vectors) {
    for (const vector of vectors.scenarios) if (vector.expectedCampaignKey) {
      mapping.campaigns = new Map([...mapping.campaigns, [vector.expectedCampaignKey, { source: vector.expectedSource, recordId: `campaign-${vector.expectedChannel}` }]]);
    }
  }
  const projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, transport.table, true), mapping, message => { throw new Error(message); });
  const hooks = createAttributionBusinessHooks(store, () => now, message => { throw new Error(message); });
  const wire: Array<{ definition: string; value: unknown }> = [];
  const app = express();
  app.use(createAttributionRouter({
    enabled: true, store, validation: { publicPaths: new Set(paths), campaignKeys: new Set(campaigns) },
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
    wire.push({ definition: 'createRequest', value: body });
    const response = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 201);
    const result = await response.json() as { shortCode: string };
    wire.push({ definition: 'createResponse', value: result });
    return result;
  };
  const revoke = async (body: unknown) => {
    wire.push({ definition: 'revokeRequest', value: body });
    const response = await fetch(base + '/api/attribution/v1/revoke', {
      method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 204);
  };
  const resolveOwner = async (code: string) => {
    const value = { contractVersion: '1.0.0', shortCode: code };
    wire.push({ definition: 'resolveRequest', value });
    const response = await fetch(base + '/admin/attribution/v1/resolve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', origin: ownerOrigin, 'x-csrf-token': ownerCsrf,
        'x-test-session': issueAdminSession('owner', ownerSecret, now),
      },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { outcome: string };
    wire.push({ definition: 'resolveResponse', value: result });
    assert.equal(result.outcome, 'matched');
  };
  const makeStorage = () => {
    const items = new Map<string, string>();
    return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
  };
  const grant = { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };
  const fallbackScenarios = [
    { href: `${origin}/display-box/?gclid=synthetic123456789012345`, referrer: '', channel: 'google_ads' },
    { href: `${origin}/display-box/`, referrer: 'https://www.google.com/', channel: 'google_organic' },
    { href: `${origin}/display-box/?utm_source=instagram&utm_medium=paid_social&utm_campaign=demo-paid`, referrer: '', channel: 'meta_ads' },
    { href: `${origin}/`, referrer: '', channel: 'direct' },
  ];
  const scenarioIds = ['google-ads', 'google-seo', 'meta-paid', 'direct'];
  const scenarios = vectors ? scenarioIds.map(id => {
    const vector = vectors.scenarios.find(item => item.id === id);
    if (!vector) throw new Error('Missing canonical scenario.');
    return { href: vector.url, referrer: vector.referrer, channel: vector.expectedChannel };
  }) : fallbackScenarios;
  try {
    let vectorsChecked = 0;
    if (vectors) {
      for (const vector of vectors.scenarios) {
        if (!vector.marketing || !vector.statistics || vector.id === '3d-inherits-google-ads') continue;
        const options = { url: vector.url, referrer: vector.referrer, observedAt: new Date(now).toISOString(), publicPaths: paths, campaignKeys: campaigns };
        const actual = website.classify(options);
        const child = configurator.classifyAcquisition({ href: vector.url, referrer: vector.referrer, now, approvedCampaignKeys: campaigns });
        for (const touch of [actual, child]) {
          assert.equal(touch.channel, vector.expectedChannel);
          assert.equal(touch.source, vector.expectedSource);
          assert.equal(touch.medium, vector.expectedMedium);
          assert.equal(touch.campaignKey, vector.expectedCampaignKey);
          assert.equal(touch.evidence, vector.expectedEvidence);
        }
        vectorsChecked += 1;
      }
      for (const id of ['consent-denied', 'statistics-only']) {
        const vector = vectors.scenarios.find(item => item.id === id);
        if (!vector) throw new Error('Missing canonical consent scenario.');
        for (const frontend of ['website', 'configurator'] as const) {
          const storage = makeStorage();
          const win = {
            location: new URL(vector.url), localStorage: storage, crypto: webcrypto,
            document: { referrer: vector.referrer }, addEventListener() {}, removeEventListener() {},
          };
          let registrations = 0;
          if (frontend === 'website') {
            const bridge = website.createBridge({
              enabled: true, window: win, now: () => now, publicPaths: paths, campaignKeys: campaigns,
              adapter: { create: () => { registrations += 1; }, revoke() {} },
            });
            bridge.setConsent({
              ad_storage: vector.marketing ? 'granted' : 'denied',
              analytics_storage: vector.statistics ? 'granted' : 'denied',
              ad_user_data: vector.marketing ? 'granted' : 'denied',
              ad_personalization: vector.marketing ? 'granted' : 'denied',
            });
          } else {
            const bridge = configurator.createAttributionBridge({
              enabled: true, windowRef: win, documentRef: { referrer: vector.referrer }, now: () => now,
              approvedCampaignKeys: campaigns, adapter: { create: () => { registrations += 1; }, revoke() {} },
            });
            bridge.applyConsent({ marketing: vector.marketing, statistics: vector.statistics });
          }
          await new Promise<void>(done => setImmediate(done));
          assert.equal(registrations, 0);
          assert.equal(storage.getItem('lks_attribution_bridge_v1'), null);
        }
        vectorsChecked += 1;
      }
    }
    for (const [index, scenario] of scenarios.entries()) {
      const storage = makeStorage();
      const location = new URL(scenario.href);
      type Message = { origin: string; source: object | null; data: unknown };
      const parentListeners = new Map<string, Array<(event: Message) => void>>();
      const emitParent = (event: Message) => { for (const listener of parentListeners.get('message') || []) listener(event); };
      let childIdentity: object | null = null;
      const win = {
        location, document: { referrer: scenario.referrer }, localStorage: storage, crypto: webcrypto,
        addEventListener(type: string, handler: (event: Message) => void) {
          parentListeners.set(type, [...parentListeners.get(type) || [], handler]);
        },
        removeEventListener() {},
        postMessage(data: unknown, target: string) {
          assert.equal(target, origin);
          queueMicrotask(() => emitParent({ origin, source: childIdentity, data }));
        },
      };
      let registration: Promise<{ shortCode: string }> | undefined;
      const bridge = website.createBridge({
        enabled: true, window: win, now: () => now, publicPaths: paths,
        campaignKeys: campaigns, approvedDestinations: ['https://wa.example.test/send'],
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
      transport.seed(mapping.tables.inquiries, inquiryId);
      transport.seed(mapping.tables.quotes, quoteId);
      transport.seed(mapping.tables.orders, orderId);
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
      assert.equal((await projector.flush()).pending, false);
      const inquiry = await transport.read(mapping.tables.inquiries, inquiryId);
      const quote = await transport.read(mapping.tables.quotes, quoteId);
      const order = await transport.read(mapping.tables.orders, orderId);
      const link = (quote.fields[mapping.quote.snapshot] as string[])[0];
      assert.deepEqual(order.fields[mapping.order.snapshot], [link]);
      assert.deepEqual(inquiry.fields[mapping.inquiry.first], [link]);
      const projected = await transport.read(mapping.tables.attributions, link);
      assert.equal(projected.fields[mapping.attribution.lastChannel], scenario.channel);
      if (scenario.channel === 'meta_ads') assert.ok((projected.fields[mapping.attribution.lastCampaign] as string[]).length === 1);
      const anchor = { href: 'https://wa.example.test/send?text=synthetic' };
      bridge.decorate(anchor);
      assert.ok(new URL(anchor.href).searchParams.get('text')?.includes(`[${receipt.shortCode}]`));
      if (index === 0) {
        const before = JSON.parse(storage.getItem('lks_attribution_bridge_v1') || 'null');
        const childLocation = new URL(`${origin}/configurator/`);
        const childStorage = makeStorage();
        const childListeners = new Map<string, Array<(event: Message) => void>>();
        let parentResponses = 0;
        const childWindow = {
          location: childLocation, localStorage: childStorage, crypto: webcrypto, parent: win,
          addEventListener(type: string, handler: (event: Message) => void) {
            childListeners.set(type, [...childListeners.get(type) || [], handler]);
          },
          postMessage(data: unknown, target: string) {
            assert.equal(target, origin);
            parentResponses += 1;
            queueMicrotask(() => {
              for (const listener of childListeners.get('message') || []) listener({ origin, source: win, data });
            });
          },
        };
        childIdentity = childWindow;
        bridge.connectChild(childWindow);
        emitParent({ origin: 'https://wrong.example.test', source: childWindow, data: { type: 'lks_attribution_bridge_v1_request' } });
        emitParent({ origin, source: {}, data: { type: 'lks_attribution_bridge_v1_request' } });
        assert.equal(parentResponses, 0);
        let resolveInherited: ((receipt: { shortCode: string }) => void) | undefined;
        const inherited = new Promise<{ shortCode: string }>(done => { resolveInherited = done; });
        const child = configurator.createAttributionBridge({
          enabled: true, windowRef: childWindow, documentRef: { referrer: `${origin}/display-box/` },
          now: () => now, approvedCampaignKeys: campaigns,
          adapter: {
            create: (request: { path: string; body: { attributionId: string }; headers: Record<string, string> }) => {
              const registration = create(request.path, request.body, request.headers);
              if (request.body.attributionId === before.attributionId) registration.then(result => resolveInherited?.(result));
              return registration;
            },
            revoke: (request: { body: unknown }) => revoke(request.body),
          },
        });
        child.applyConsent({ marketing: true, statistics: true });
        const childReceipt = await Promise.race([
          inherited,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Iframe context was not registered.')), 5000)),
        ]);
        assert.equal(parentResponses, 1);
        const after = JSON.parse(childStorage.getItem('lks_attribution_bridge_v1') || 'null');
        assert.deepEqual(after, before);
        const badJourney = { ...before, attributionId: `aid_v1_${'f'.repeat(32)}` };
        for (const listener of childListeners.get('message') || []) {
          listener({ origin: 'https://wrong.example.test', source: win, data: { type: 'lks_attribution_bridge_v1_context', journey: badJourney } });
          listener({ origin, source: {}, data: { type: 'lks_attribution_bridge_v1_context', journey: badJourney } });
        }
        assert.deepEqual(JSON.parse(childStorage.getItem('lks_attribution_bridge_v1') || 'null'), before);
        const inheritedTouch = store.resolve(childReceipt.shortCode, now)?.lastTouch;
        assert.equal(inheritedTouch?.channel, 'google_ads');
        if (vectors) {
          const vector = vectors.scenarios.find(item => item.id === '3d-inherits-google-ads');
          if (!vector || !inheritedTouch) throw new Error('Missing canonical inheritance scenario.');
          assert.equal(inheritedTouch.channel, vector.expectedChannel);
          assert.equal(inheritedTouch.source, vector.expectedSource);
          assert.equal(inheritedTouch.medium, vector.expectedMedium);
          assert.equal(inheritedTouch.campaignKey, vector.expectedCampaignKey);
          assert.equal(inheritedTouch.evidence, vector.expectedEvidence);
        }
        await resolveOwner(childReceipt.shortCode);
        transport.seed(mapping.tables.quotes, 'quote-child');
        transport.seed(mapping.tables.orders, 'order-child');
        hooks.quote(childReceipt.shortCode, inquiryId, 'quote-child');
        hooks.order('quote-child', 'order-child');
        assert.equal((await projector.flush()).pending, false);
        const childQuote = await transport.read(mapping.tables.quotes, 'quote-child');
        const childOrder = await transport.read(mapping.tables.orders, 'order-child');
        const childLink = (childQuote.fields[mapping.quote.snapshot] as string[])[0];
        assert.deepEqual(childOrder.fields[mapping.order.snapshot], [childLink]);
        assert.equal((await transport.read(mapping.tables.attributions, childLink)).fields[mapping.attribution.lastChannel], 'google_ads');
        if (vectors) vectorsChecked += 1;
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
    if (wireOutputPath) writeFileSync(resolve(wireOutputPath), JSON.stringify(wire));
    process.stdout.write(`Five frontend-to-router-to-business synthetic paths passed; ${vectorsChecked} canonical scenarios exercised across the frontends.\n`);
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

main().catch(error => { console.error(error); process.exitCode = 1; });
