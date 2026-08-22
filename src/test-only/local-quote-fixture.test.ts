import assert from 'node:assert/strict';
import test from 'node:test';
import { localQuoteFixtureEnabled } from './local-quote-fixture';

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
});
