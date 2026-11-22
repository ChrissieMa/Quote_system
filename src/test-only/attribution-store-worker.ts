import { LocalAttributionStore } from '../attribution-store';
import type { AttributionRequest } from '../attribution-validation';

const request: AttributionRequest = {
  contractVersion: '1.0.0',
  attributionId: `aid_v1_${'a'.repeat(32)}`,
  requestId: `ar_v1_${(process.argv[3] === 'collision-b' ? 'c' : 'b').repeat(32)}`,
  firstTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  lastTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  entrySurface: process.argv[3] === 'alternate' ? 'configurator' : 'wordpress',
  consent: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
};

let minted = 0;
const collision = process.argv[3] === 'collision-a' || process.argv[3] === 'collision-b';
const mint = collision ? () => {
  minted += 1;
  return minted === 1 ? 'LKS-0000000000000000'
    : process.argv[3] === 'collision-a' ? 'LKS-1111111111111111' : 'LKS-2222222222222222';
} : undefined;
const store = new LocalAttributionStore(process.argv[2], Buffer.alloc(32, 7), mint);
const result = store.create(request, Date.parse('2026-01-01T00:00:00Z'));
process.stdout.write(JSON.stringify(result));
store.close();
