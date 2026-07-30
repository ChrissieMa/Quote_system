import assert from 'node:assert/strict';
import test from 'node:test';
import {
  issueMutationConfirmation,
  makeMutationPlan,
  mutationFieldsMatch,
  mutationPlanFingerprint,
  verifyMutationConfirmation,
} from './production-mutation';

const impact = {
  pricingChanged: false,
  quoteLinkChanged: false as const,
  invoiceMayReflectChange: false,
  labelMayReflectChange: false,
  deliveryMayReflectChange: false,
  notes: [],
};

test('edit confirmation locks exact before/after fields and target', () => {
  const plan = makeMutationPlan('edit', 'QT-2026-0200', [{
    tableId: 'tblQuotes',
    tableName: 'Quotes',
    recordId: 'recQuote',
    identifier: 'QT-2026-0200',
    before: { Phone: '11111111' },
    after: { Phone: '22222222' },
  }], impact, 1_000, 'nonce');
  const secret = 's'.repeat(64);
  const confirmationId = issueMutationConfirmation(plan, secret);
  const lock = verifyMutationConfirmation(confirmationId, secret, 2_000);
  assert.equal(lock.operation, 'edit');
  assert.equal(lock.target, 'QT-2026-0200');
  assert.equal(lock.fingerprint, mutationPlanFingerprint(plan));
  assert.equal(plan.requiredConfirmation, '確認修改');
  assert.throws(() => verifyMutationConfirmation(`${confirmationId}x`, secret, 2_000), /Invalid/);
});

test('cancel confirmation names the exact target and expires', () => {
  const plan = makeMutationPlan('cancel', 'JUL2605', [{
    tableId: 'tblOrders',
    tableName: 'Order_2026',
    recordId: 'recOrder',
    identifier: 'JUL2605',
    before: { Status: 'Confirmed' },
    after: { Status: 'Cancelled' },
  }], impact, 1_000, 'nonce');
  const secret = 's'.repeat(64);
  const confirmationId = issueMutationConfirmation(plan, secret);
  assert.equal(plan.requiredConfirmation, '確認取消 JUL2605');
  assert.throws(() => verifyMutationConfirmation(confirmationId, secret, 2_000_000), /expired/);
});

test('reread guard compares only locked fields and detects changes', () => {
  assert.equal(mutationFieldsMatch(
    { Phone: '11111111', Unrelated: 'safe' },
    { Phone: '11111111' },
  ), true);
  assert.equal(mutationFieldsMatch(
    { Phone: '22222222' },
    { Phone: '11111111' },
  ), false);
});
