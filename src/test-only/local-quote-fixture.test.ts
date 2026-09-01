import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mapQuoteItemTypeToInquiryProductInterest } from '../inquiry-attribution';
import { createLocalQuoteFixture, localQuoteFixtureEnabled } from './local-quote-fixture';

const withFixtureEnvironment = (values: Record<string, string | undefined>, check: () => void): void => {
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    check();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('local Quote fixture requires test mode, explicit opt-in and loopback URL', () => {
  withFixtureEnvironment({
    NODE_ENV: 'test',
    LKS_LOCAL_QUOTE_FIXTURE: '1',
    PUBLIC_BASE_URL: 'http://127.0.0.1:3011',
  }, () => assert.equal(localQuoteFixtureEnabled(), true));

  for (const unsafe of [
    { NODE_ENV: 'production', LKS_LOCAL_QUOTE_FIXTURE: '1', PUBLIC_BASE_URL: 'http://127.0.0.1:3011' },
    { NODE_ENV: 'test', LKS_LOCAL_QUOTE_FIXTURE: '0', PUBLIC_BASE_URL: 'http://127.0.0.1:3011' },
    { NODE_ENV: 'test', LKS_LOCAL_QUOTE_FIXTURE: '1', PUBLIC_BASE_URL: 'https://quote.example.invalid' },
  ]) {
    withFixtureEnvironment(unsafe, () => assert.equal(localQuoteFixtureEnabled(), false));
  }

  for (const nonLoopback of [
    'https://fictional-quote-preview.trycloudflare.com',
    'https://quote.lksdisplaybox.online',
    'http://192.168.1.20:3011',
  ]) {
    withFixtureEnvironment({
      NODE_ENV: 'test',
      LKS_LOCAL_QUOTE_FIXTURE: '1',
      PUBLIC_BASE_URL: nonLoopback,
    }, () => assert.equal(localQuoteFixtureEnabled(), false));
  }
});

test('local original-route fixture keeps every conditional bottom section populated', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lks-local-quote-fixture-'));
  const pngPath = path.join(fixtureDir, 'fixture.png');
  const metadataPath = path.join(fixtureDir, 'fixture.json');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(metadataPath, JSON.stringify({
    width: 1280,
    height: 1280,
    stateRestored: true,
    request: {
      purpose: 'quotation',
      product_type: 'display_box',
      dimensions: {
        unit: 'mm',
        inner: { length: 280, depth: 180, height: 210 },
        outer: { length: 300, depth: 200, height: 220 },
        actual: { length: 300, depth: 200, height: 220 },
      },
      cabinet_layers: [],
      accessories: [{ accessory_type: 'mirror_back', quantity: 1 }],
      colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
      camera_preset: 'quotation_square_three_quarter_v2',
      output: { width: 1280, height: 1280, background: 'configured' },
      branding: { enabled: false, style: 'none' },
      show_dimensions: true,
      show_price: false,
    },
  }));
  const previousPng = process.env.LKS_QUOTATION_IMAGE_FIXTURE_PNG;
  const previousJson = process.env.LKS_QUOTATION_IMAGE_FIXTURE_JSON;
  const previousAutoImage = process.env.LKS_LOCAL_QUOTE_FIXTURE_AUTO_IMAGE;
  try {
    process.env.LKS_QUOTATION_IMAGE_FIXTURE_PNG = pngPath;
    process.env.LKS_QUOTATION_IMAGE_FIXTURE_JSON = metadataPath;
    const fixture = createLocalQuoteFixture();
    const quote = (await fixture.base('Quotes').select().firstPage())[0];
    const order = (await fixture.base('Order_2026').select().firstPage())[0];
    assert.ok(String(quote.fields['Notes'] || '').trim());
    assert.ok(String(quote.fields['Terms and Conditions'] || '').trim());
    assert.ok(String(order.fields['Payment Method'] || '').trim());
    assert.ok(String(order.fields['Notes'] || '').trim());
    assert.ok(String(order.fields['Terms and Conditions'] || '').trim());

    const createdQuote = (await fixture.base('Quotes').create([{
      fields: {
        'Quote Number': 'QT-2026-9002',
        'Sub Total': 1407.89,
        'Total': 1408,
      },
    }]))[0];
    const createdOrder = (await fixture.base('Order_2026').create([{
      fields: {
        'Source Quote Ref': createdQuote.fields['Quote Number'],
        'Product Amount': createdQuote.fields['Sub Total'],
        'Discount': 1.0001,
      },
    }]))[0];
    assert.equal(createdOrder.fields['Final Amount'], createdQuote.fields['Total']);

    process.env.LKS_LOCAL_QUOTE_FIXTURE_AUTO_IMAGE = '1';
    const automaticFixture = createLocalQuoteFixture();
    const automaticQuote = (await automaticFixture.base('Quotes').select().firstPage())[0];
    const automaticItems = JSON.parse(String(automaticQuote.fields['Quote Items JSON'])) as Array<Record<string, unknown>>;
    assert.equal(automaticItems[0].quotation_image, undefined);

    const inquiryTable = fixture.base('Inquiries');
    const quoteItemTypes = ['Display box 展示盒', 'Display Case 疊高展示櫃', '階梯'];
    const createdInquiries = await inquiryTable.create(quoteItemTypes.map((itemType, index) => ({
      fields: {
        'Inquiry Date': '2026-09-01',
        'Product Interest': mapQuoteItemTypeToInquiryProductInterest(itemType),
        'Inquiry Status': 'Quoted',
        'Notes': `TEST-ONLY synthetic product type ${index + 1}`,
      },
    })));
    assert.deepEqual(
      createdInquiries.map(item => item.fields['Product Interest']),
      ['Display Box', 'Display Case', 'Other'],
    );
    await assert.rejects(
      inquiryTable.create([{ fields: { 'Product Interest': 'Display Case 疊高展示櫃' } }]),
      /unknown Product Interest/,
    );
  } finally {
    if (previousPng === undefined) delete process.env.LKS_QUOTATION_IMAGE_FIXTURE_PNG;
    else process.env.LKS_QUOTATION_IMAGE_FIXTURE_PNG = previousPng;
    if (previousJson === undefined) delete process.env.LKS_QUOTATION_IMAGE_FIXTURE_JSON;
    else process.env.LKS_QUOTATION_IMAGE_FIXTURE_JSON = previousJson;
    if (previousAutoImage === undefined) delete process.env.LKS_LOCAL_QUOTE_FIXTURE_AUTO_IMAGE;
    else process.env.LKS_LOCAL_QUOTE_FIXTURE_AUTO_IMAGE = previousAutoImage;
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});
