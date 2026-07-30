import crypto from 'crypto';

export const MUTATION_CONFIRMATION_TTL_MS = 30 * 60 * 1000;

export type ProductionMutationRecord = {
  tableId: string;
  tableName: string;
  recordId: string;
  identifier: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type ProductionMutationPlan = {
  version: 1;
  operation: 'edit' | 'cancel';
  issuedAt: number;
  nonce: string;
  target: string;
  requiredConfirmation: string;
  mutations: ProductionMutationRecord[];
  impact: {
    pricingChanged: boolean;
    oldTotal?: number;
    newTotal?: number;
    estimatedNetProfit?: number;
    quoteLinkChanged: false;
    invoiceMayReflectChange: boolean;
    labelMayReflectChange: boolean;
    deliveryMayReflectChange: boolean;
    notes: string[];
  };
};

type MutationLock = {
  v: 1;
  operation: 'edit' | 'cancel';
  issuedAt: number;
  nonce: string;
  target: string;
  fingerprint: string;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const mutationPlanFingerprint = (plan: ProductionMutationPlan): string =>
  crypto.createHash('sha256').update(stableStringify({
    operation: plan.operation,
    target: plan.target,
    requiredConfirmation: plan.requiredConfirmation,
    mutations: plan.mutations,
    impact: plan.impact,
  })).digest('hex');

export const issueMutationConfirmation = (
  plan: ProductionMutationPlan,
  secret: string,
): string => {
  if (!secret) throw new Error('Maintenance confirmation secret is not configured.');
  if (!plan.mutations.length) throw new Error('Mutation plan has no records.');
  const lock: MutationLock = {
    v: 1,
    operation: plan.operation,
    issuedAt: plan.issuedAt,
    nonce: plan.nonce,
    target: plan.target,
    fingerprint: mutationPlanFingerprint(plan),
  };
  const payload = Buffer.from(stableStringify(lock), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

export const verifyMutationConfirmation = (
  confirmationId: string,
  secret: string,
  now = Date.now(),
): MutationLock => {
  const [payload, signature, extra] = String(confirmationId || '').trim().split('.');
  if (!payload || !signature || extra || !secret) throw new Error('Invalid mutation confirmation ID.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error('Invalid mutation confirmation ID.');
  }
  const lock = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as MutationLock;
  if (
    lock.v !== 1
    || !['edit', 'cancel'].includes(lock.operation)
    || !lock.nonce
    || !lock.target
    || !lock.fingerprint
    || !Number.isFinite(lock.issuedAt)
  ) throw new Error('Invalid mutation confirmation ID.');
  if (lock.issuedAt > now + 60_000 || now - lock.issuedAt > MUTATION_CONFIRMATION_TTL_MS) {
    throw new Error('Mutation confirmation has expired. Generate a new preview.');
  }
  return lock;
};

export const makeMutationPlan = (
  operation: 'edit' | 'cancel',
  target: string,
  mutations: ProductionMutationRecord[],
  impact: ProductionMutationPlan['impact'],
  now = Date.now(),
  nonce = crypto.randomBytes(12).toString('hex'),
): ProductionMutationPlan => ({
  version: 1,
  operation,
  issuedAt: now,
  nonce,
  target,
  requiredConfirmation: operation === 'edit' ? '確認修改' : `確認取消 ${target}`,
  mutations,
  impact,
});

export const mutationFieldsMatch = (
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean => Object.entries(expected).every(([field, value]) =>
  stableStringify(current[field] ?? null) === stableStringify(value ?? null)
);

