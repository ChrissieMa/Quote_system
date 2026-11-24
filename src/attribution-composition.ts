import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, normalize, sep } from 'node:path';
import { AirtableTableClient, SerializedAirtableProjectionTransport } from './attribution-airtable';
import { AttributionProjectionMapping, validateProjectionMapping } from './attribution-projection';
import { AttributionRateLimit } from './attribution-rate-limit';
import { LocalAttributionStore } from './attribution-store';
import { AttributionValidationConfig } from './attribution-validation';

export const attributionMountPath = '/data/lks-attribution';
export const attributionStorePath = `${attributionMountPath}/attribution.sqlite`;
export const attributionProofKeyPath = `${attributionMountPath}/proof-key.hex`;
export const attributionDeploymentConfigPath = `${attributionMountPath}/deployment.json`;
export const attributionConfigurationFailure = 'Attribution configuration failed; attribution remains closed.';

export type AttributionPathPolicy = { kind: 'production' } | { kind: 'test'; directory: string };

export type AttributionCompositionInput = {
  enabled: boolean;
  storePath: string;
  pathPolicy: AttributionPathPolicy;
  exclusiveWriterConfirmed: boolean;
  proofKey: () => Buffer;
  tables: (name: string) => AirtableTableClient;
  mapping: AttributionProjectionMapping | null;
  publicPaths: readonly string[];
  campaignKeys: readonly string[];
  nodeVersion: string;
  now: () => number;
  report: (message: string) => void;
  limit?: { maxRequests: number; windowMs: number; maxClients: number };
};

export type ComposedAttribution = {
  enabled: true;
  store: LocalAttributionStore;
  validation: AttributionValidationConfig;
  now: () => number;
  allowRequest: (clientAddress: string) => boolean;
  transport: SerializedAirtableProjectionTransport;
  mapping: AttributionProjectionMapping;
};

export type ApprovedAttributionDeployment = {
  storePath: string;
  mountPath: string;
  exclusiveWriterConfirmed: true;
  publicPaths: readonly string[];
  campaignKeys: readonly string[];
  mapping: AttributionProjectionMapping;
};

const supportedNode = (version: string): boolean => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  return major > 22 || (major === 22 && Number(match[2]) >= 13);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const stringRecord = (value: unknown, keys: readonly string[]): Record<string, string> => {
  if (!isPlainObject(value) || !exactKeys(value, keys)) throw new Error('Invalid deployment configuration.');
  const result: Record<string, string> = {};
  for (const key of keys) {
    const field = value[key];
    if (typeof field !== 'string' || !field.trim()) throw new Error('Invalid deployment configuration.');
    result[key] = field;
  }
  return result;
};

const safeDirectory = (path: string): boolean => {
  if (!isAbsolute(path) || normalize(path) !== path) return false;
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path;
};

export const isDistinctMountDevice = (
  mountPath: string,
  deviceOf: (path: string) => number | bigint = path => lstatSync(path).dev,
): boolean => {
  try {
    return deviceOf(mountPath) !== deviceOf(dirname(mountPath));
  } catch {
    return false;
  }
};

const storeFilesAreRegular = (path: string): boolean => {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(candidate) !== candidate) return false;
  }
  return true;
};

const pathAllowed = (path: string, policy: AttributionPathPolicy): boolean => {
  if (!isAbsolute(path) || normalize(path) !== path || !path.endsWith('.sqlite')) return false;
  const directory = dirname(path);
  if (!safeDirectory(directory)) return false;
  if (policy.kind === 'production') {
    return path === attributionStorePath && directory === attributionMountPath
      && isDistinctMountDevice(attributionMountPath) && storeFilesAreRegular(path);
  }
  const root = policy.directory;
  return isAbsolute(root) && normalize(root) === root && safeDirectory(root)
    && (directory === root || directory.startsWith(root + sep)) && storeFilesAreRegular(path);
};

const readBoundedRegularFile = (path: string, minimum: number, maximum: number, requirePrivate: boolean): string => {
  if (!isAbsolute(path) || normalize(path) !== path || !lstatSync(path).isFile()) throw new Error('Invalid configuration file.');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    const forbiddenMode = requirePrivate ? 0o077 : 0o022;
    if (!stat.isFile() || (stat.mode & forbiddenMode) !== 0 || stat.size < minimum || stat.size > maximum) {
      throw new Error('Invalid configuration file.');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
};

/** Reads a synthetic or future operator-provisioned key only from an explicit private regular file. */
export const readAttributionProofKeyFile = (path: string): Buffer => {
  const text = readBoundedRegularFile(path, 64, 128, true).trim();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new Error('Invalid proof key encoding.');
  return Buffer.from(text, 'hex');
};

const tableKeys = ['attributions', 'inquiries', 'quotes', 'orders'] as const;
const attributionKeys = [
  'code', 'attributionId', 'contractVersion', 'entrySurface',
  'firstAt', 'firstChannel', 'firstSource', 'firstMedium', 'firstCampaign', 'firstPath', 'firstEvidence', 'firstConfidence',
  'lastAt', 'lastChannel', 'lastSource', 'lastMedium', 'lastCampaign', 'lastPath', 'lastEvidence', 'lastConfidence',
  'consent', 'createdAt', 'expiresAt',
] as const;
const inquiryKeys = ['first', 'latest', 'revision'] as const;
const snapshotKeys = ['snapshot'] as const;
const surfaceKeys = ['wordpress', 'configurator'] as const;

const parseMapping = (value: unknown): AttributionProjectionMapping => {
  if (!isPlainObject(value) || !exactKeys(value, ['tables', 'attribution', 'inquiry', 'quote', 'order', 'surfaces', 'campaigns'])) {
    throw new Error('Invalid deployment configuration.');
  }
  const campaignsValue = value.campaigns;
  if (!isPlainObject(campaignsValue)) throw new Error('Invalid deployment configuration.');
  const campaigns = new Map<string, { source: string; recordId: string }>();
  for (const [key, campaign] of Object.entries(campaignsValue)) {
    const fields = stringRecord(campaign, ['source', 'recordId']);
    campaigns.set(key, { source: fields.source, recordId: fields.recordId });
  }
  const mapping: AttributionProjectionMapping = {
    tables: stringRecord(value.tables, tableKeys) as AttributionProjectionMapping['tables'],
    attribution: stringRecord(value.attribution, attributionKeys) as AttributionProjectionMapping['attribution'],
    inquiry: stringRecord(value.inquiry, inquiryKeys) as AttributionProjectionMapping['inquiry'],
    quote: stringRecord(value.quote, snapshotKeys) as AttributionProjectionMapping['quote'],
    order: stringRecord(value.order, snapshotKeys) as AttributionProjectionMapping['order'],
    surfaces: stringRecord(value.surfaces, surfaceKeys) as AttributionProjectionMapping['surfaces'],
    campaigns,
  };
  validateProjectionMapping(mapping);
  return mapping;
};

/**
 * Loads the exact non-secret deployment template. Production accepts only the fixed
 * durable file/mount/store paths. Tests must opt into an explicit temporary root.
 */
export const loadApprovedAttributionDeploymentFile = (
  path: string,
  nodeVersion: string,
  policy: AttributionPathPolicy,
): ApprovedAttributionDeployment => {
  if (policy.kind === 'production' && path !== attributionDeploymentConfigPath) throw new Error('Invalid deployment configuration.');
  if (policy.kind === 'test' && (!isAbsolute(policy.directory) || normalize(policy.directory) !== policy.directory
      || !path.startsWith(policy.directory + sep))) throw new Error('Invalid deployment configuration.');
  const parsed = JSON.parse(readBoundedRegularFile(path, 2, 65_536, false)) as unknown;
  if (!isPlainObject(parsed) || !exactKeys(parsed, [
    'schemaVersion', 'requiredNodeVersion', 'storePath', 'mountPath', 'exclusiveWriterConfirmed',
    'writerMode', 'publicPaths', 'campaignKeys', 'mapping',
  ])) throw new Error('Invalid deployment configuration.');
  if (parsed.schemaVersion !== 'attribution-deployment-v1' || parsed.writerMode !== 'single-process'
      || parsed.exclusiveWriterConfirmed !== true || parsed.requiredNodeVersion !== nodeVersion || !supportedNode(nodeVersion)) {
    throw new Error('Invalid deployment configuration.');
  }
  if (typeof parsed.storePath !== 'string' || typeof parsed.mountPath !== 'string'
      || dirname(parsed.storePath) !== parsed.mountPath || !safeDirectory(parsed.mountPath)
      || !pathAllowed(parsed.storePath, policy)) throw new Error('Invalid deployment configuration.');
  if (policy.kind === 'production' && parsed.mountPath !== attributionMountPath) throw new Error('Invalid deployment configuration.');
  if (!Array.isArray(parsed.publicPaths) || !Array.isArray(parsed.campaignKeys)
      || parsed.publicPaths.some(value => typeof value !== 'string')
      || parsed.campaignKeys.some(value => typeof value !== 'string')) throw new Error('Invalid deployment configuration.');
  const publicPaths = parsed.publicPaths as string[];
  const campaignKeys = parsed.campaignKeys as string[];
  const mapping = parseMapping(parsed.mapping);
  if (new Set(publicPaths).size !== publicPaths.length || publicPaths.length === 0
      || publicPaths.some(item => !/^\/[A-Za-z0-9/_-]*$/.test(item))
      || new Set(campaignKeys).size !== campaignKeys.length
      || campaignKeys.length !== mapping.campaigns.size
      || campaignKeys.some(key => !mapping.campaigns.has(key))) throw new Error('Invalid deployment configuration.');
  return {
    storePath: parsed.storePath,
    mountPath: parsed.mountPath,
    exclusiveWriterConfirmed: true,
    publicPaths: Object.freeze([...publicPaths]),
    campaignKeys: Object.freeze([...campaignKeys]),
    mapping,
  };
};

/**
 * Builds the explicit attribution composition. Disabled returns before any provider,
 * path, key, store, mapping, table client or limiter is touched.
 */
export const composeAttribution = (input: AttributionCompositionInput): ComposedAttribution | null => {
  if (input.enabled !== true) return null;
  let store: LocalAttributionStore | null = null;
  try {
    if (!supportedNode(input.nodeVersion)) throw new Error('runtime');
    if (input.exclusiveWriterConfirmed !== true) throw new Error('writer');
    if (!pathAllowed(input.storePath, input.pathPolicy)) throw new Error('path');
    const mapping = input.mapping;
    if (!mapping) throw new Error('mapping');
    validateProjectionMapping(mapping);
    const campaignKeys = new Set(input.campaignKeys);
    if (campaignKeys.size !== input.campaignKeys.length || campaignKeys.size !== mapping.campaigns.size
        || [...campaignKeys].some(key => !mapping.campaigns.has(key))) throw new Error('mapping');
    const publicPaths = new Set(input.publicPaths);
    if (publicPaths.size === 0 || publicPaths.size !== input.publicPaths.length
        || [...publicPaths].some(path => !/^\/[A-Za-z0-9/_-]*$/.test(path))) throw new Error('mapping');
    const limit = input.limit ?? { maxRequests: 30, windowMs: 60_000, maxClients: 5_000 };
    let limiter: AttributionRateLimit;
    try {
      limiter = new AttributionRateLimit(limit.maxRequests, limit.windowMs, limit.maxClients);
    } catch {
      throw new Error('limiter');
    }
    let key: Buffer;
    try {
      key = input.proofKey();
    } catch {
      throw new Error('key');
    }
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('key');
    store = new LocalAttributionStore(input.storePath, key);
    const transport = new SerializedAirtableProjectionTransport(store, input.tables, input.exclusiveWriterConfirmed);
    return {
      enabled: true,
      store,
      now: input.now,
      transport,
      mapping,
      validation: { publicPaths, campaignKeys },
      allowRequest: client => limiter.allow(client, input.now()),
    };
  } catch {
    try { store?.close(); } catch { /* attribution remains closed */ }
    input.report(attributionConfigurationFailure);
    return null;
  }
};
