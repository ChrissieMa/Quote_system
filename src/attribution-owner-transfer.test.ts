import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { attributionOwnerTransferScript } from './attribution-owner-transfer';

test('owner selection transfers once, only to the same inquiry and within one minute', () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  let time = 10_000;
  const window: { sessionStorage: typeof storage; lksAttributionOwnerSelection?: {
    remember(inquiry: string, code: string): void; take(inquiry: string): string;
  } } = { sessionStorage: storage };
  const code = 'LKS-0000000000000000';
  vm.runInNewContext(attributionOwnerTransferScript.replace(/^<script>\n|\n<\/script>$/g, ''), {
    window, console, Date: { now: () => time }, Number, JSON,
  });
  const transfer = window.lksAttributionOwnerSelection;
  if (!transfer) throw new Error('Expected owner selection helper.');
  transfer.remember('inquiry-one', code);
  assert.equal(transfer.take('inquiry-two'), '');
  assert.equal(transfer.take('inquiry-one'), '');
  transfer.remember('inquiry-one', code);
  assert.equal(transfer.take('inquiry-one'), code);
  assert.equal(transfer.take('inquiry-one'), '');
  transfer.remember('inquiry-one', code);
  time += 60_001;
  assert.equal(transfer.take('inquiry-one'), '');
  transfer.remember('inquiry-one', 'not-a-code');
  assert.equal(transfer.take('inquiry-one'), '');
});
