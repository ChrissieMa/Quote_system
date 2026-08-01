import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installAirtableReadRetry,
  isRetryableAirtableReadError,
  withAirtableReadRetry,
} from './airtable-retry';

test('classifies transient Airtable connection errors but not validation failures', () => {
  assert.equal(isRetryableAirtableReadError({ code: 'ENOTFOUND' }), true);
  assert.equal(isRetryableAirtableReadError({ statusCode: 503 }), true);
  assert.equal(isRetryableAirtableReadError(new Error('request failed, reason:')), true);
  assert.equal(isRetryableAirtableReadError({ statusCode: 422, message: 'Invalid field' }), false);
});

test('promise read helper retries transient failures and returns the later success', async () => {
  let attempts = 0;
  const result = await withAirtableReadRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('temporary'), { code: 'ECONNRESET' });
    return 'ok';
  }, { sleep: async () => undefined });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('base retry layer retries GET only and never retries writes', async () => {
  let readAttempts = 0;
  const fakeBase: any = {
    _base: {
      runAction(_method: string, _path: string, _query: unknown, _body: unknown, callback: Function) {
        readAttempts += 1;
        if (readAttempts === 1) callback(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
        else callback(null, { statusCode: 200 }, { records: [] });
      },
    },
  };
  installAirtableReadRetry(fakeBase, { delaysMs: [0] });
  await new Promise<void>((resolve, reject) => {
    fakeBase._base.runAction('GET', '/Quotes', {}, null, (error: any, _response: any, result: any) => {
      if (error) return reject(error);
      assert.deepEqual(result, { records: [] });
      resolve();
    });
  });
  assert.equal(readAttempts, 2);

  let writeAttempts = 0;
  const writeBase: any = {
    _base: {
      runAction(_method: string, _path: string, _query: unknown, _body: unknown, callback: Function) {
        writeAttempts += 1;
        callback(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
      },
    },
  };
  installAirtableReadRetry(writeBase, { delaysMs: [0] });
  await new Promise<void>((resolve) => {
    writeBase._base.runAction('POST', '/Quotes', {}, {}, (error: any) => {
      assert.ok(error);
      resolve();
    });
  });
  assert.equal(writeAttempts, 1);
});
