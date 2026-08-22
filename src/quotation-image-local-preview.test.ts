import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildLocalQuotationImageEvidence,
  createLocalQuotationImagePreviewApp,
} from './quotation-image-local-preview';

const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'lks-quote-preview-test-'));
const fixturePath = path.join(fixtureDirectory, 'fixture-1280.png');
const pngHeader = Buffer.alloc(24);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
pngHeader.writeUInt32BE(13, 8);
pngHeader.write('IHDR', 12, 'ascii');
pngHeader.writeUInt32BE(1280, 16);
pngHeader.writeUInt32BE(1280, 20);
writeFileSync(fixturePath, pngHeader);

test.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));

test('local preview connects one fixture image to one immutable Quote Item without pricing leakage', async () => {
  const { evidence, storage } = await buildLocalQuotationImageEvidence(fixturePath);
  assert.equal(evidence.quoteItem.quotation_image?.state, 'ready');
  assert.equal(evidence.rendererCalls, 1);
  assert.equal(evidence.storedAssets, 1);
  assert.equal(storage.size, 1);
  assert.equal(evidence.renderRequest.show_price, false);
  assert.equal(JSON.stringify(evidence.renderRequest).includes('4280'), false);
  assert.equal(JSON.stringify(evidence.renderRequest).includes('FICTIONAL LOCAL FIXTURE'), false);
  assert.equal(evidence.failOpen.state, 'failed');
  assert.equal(evidence.failOpen.priceBefore, evidence.failOpen.priceAfter);
  assert.equal(evidence.failOpen.presentationSuppressed, true);
});

test('local preview exposes separate creation, share and invoice fixture pages', async () => {
  const { app } = await createLocalQuotationImagePreviewApp(fixturePath);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    for (const route of ['/internal/quote-create', '/share/test-only', '/invoice/test-only']) {
      const response = await fetch(`${base}${route}`);
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(html, /Image ready · 1280 × 1280 PNG/);
      assert.match(html, /80eac55e-53a2-4d2e-b5d7-329329e2e4e9/);
      assert.match(html, /HKD \$4,280/);
      assert.match(html, /No Airtable · No Production/);
    }
    const evidence = await (await fetch(`${base}/evidence.json`)).json() as Record<string, unknown>;
    assert.equal(evidence.fixture_only, true);
    assert.equal(evidence.production, false);
    assert.equal(evidence.airtable_writes, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
