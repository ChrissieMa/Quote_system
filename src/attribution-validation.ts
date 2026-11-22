export type AttributionTouch = {
  observedAt: string;
  channel: string;
  source: string;
  medium: string;
  campaignKey: string | null;
  landingPath: string | null;
  evidence: string;
  confidence: string;
};

export type AttributionRequest = {
  contractVersion: '1.0.0';
  attributionId: string;
  requestId: string;
  firstTouch: AttributionTouch;
  lastTouch: AttributionTouch;
  entrySurface: 'wordpress' | 'configurator';
  consent: Record<'ad_storage' | 'analytics_storage' | 'ad_user_data' | 'ad_personalization', 'granted' | 'denied'>;
};

export type AttributionValidationConfig = {
  publicPaths: ReadonlySet<string>;
  campaignKeys: ReadonlySet<string>;
};

const consentKeys = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'] as const;
const touchKeys = ['observedAt', 'channel', 'source', 'medium', 'campaignKey', 'landingPath', 'evidence', 'confidence'];
const requestKeys = ['contractVersion', 'attributionId', 'requestId', 'firstTouch', 'lastTouch', 'entrySurface', 'consent'];

const exactObject = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));

const instant = (value: unknown): number => {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, zone] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1
      || date.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59
      || Number(second) > 59 || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23
        || Number(zone.slice(4, 6)) > 59))) return NaN;
  return Date.parse(value);
};

const validTouch = (value: unknown, config: AttributionValidationConfig, now: number): value is AttributionTouch => {
  if (!exactObject(value, touchKeys)) return false;
  const time = instant(value.observedAt);
  if (!Number.isFinite(time) || time > now + 300_000) return false;
  if (value.campaignKey !== null && (typeof value.campaignKey !== 'string'
      || value.campaignKey.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/.test(value.campaignKey)
      || !config.campaignKeys.has(value.campaignKey))) return false;
  if (value.landingPath !== null && (typeof value.landingPath !== 'string'
      || value.landingPath.length > 180 || !/^\/[^?#]*$/.test(value.landingPath)
      || !config.publicPaths.has(value.landingPath))) return false;
  if (![value.channel, value.source, value.medium, value.evidence, value.confidence].every(item => typeof item === 'string')) return false;
  const tuple = [value.channel, value.source, value.medium, value.evidence, value.confidence].join('|');
  const valid = new Set([
    'google_ads|google|cpc|google_click_parameter|signal_strong',
    'google_ads|google|cpc|paid_utm|signal_limited',
    'google_organic|google|organic|organic_utm|signal_limited',
    'google_organic|google|organic|search_referrer|signal_limited',
    ...['facebook', 'instagram', 'meta'].map(source => `meta_ads|${source}|paid_social|paid_utm|signal_limited`),
    ...['facebook', 'instagram', 'youtube', 'tiktok', 'threads'].flatMap(source =>
      ['organic_utm', 'social_referrer'].map(evidence => `organic_social|${source}|organic_social|${evidence}|signal_limited`)),
    'direct|(direct)|(none)|direct_observed|signal_limited',
    'referral|referral|referral|external_referrer|signal_limited',
    'unknown|unknown|unknown|none|unknown',
  ]);
  return valid.has(tuple) && (value.channel !== 'unknown' || value.campaignKey === null);
};

export const validateAttributionRequest = (
  value: unknown,
  config: AttributionValidationConfig,
  now: number,
): { kind: 'valid'; request: AttributionRequest } | { kind: 'invalid' } | { kind: 'consent_unavailable'; request: AttributionRequest } => {
  if (!exactObject(value, requestKeys) || value.contractVersion !== '1.0.0'
      || typeof value.attributionId !== 'string' || !/^aid_v1_[0-9a-f]{32}$/.test(value.attributionId)
      || typeof value.requestId !== 'string' || !/^ar_v1_[0-9a-f]{32}$/.test(value.requestId)
      || (value.entrySurface !== 'wordpress' && value.entrySurface !== 'configurator')
      || !exactObject(value.consent, consentKeys)
      || !validTouch(value.firstTouch, config, now) || !validTouch(value.lastTouch, config, now)
      || instant(value.firstTouch.observedAt) > instant(value.lastTouch.observedAt)) return { kind: 'invalid' };
  const consent = value.consent;
  if (!consentKeys.every(key => consent[key] === 'granted' || consent[key] === 'denied')) return { kind: 'invalid' };
  if (!consentKeys.every(key => consent[key] === 'granted')) return { kind: 'consent_unavailable', request: value as AttributionRequest };
  return { kind: 'valid', request: value as AttributionRequest };
};
