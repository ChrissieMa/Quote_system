import express, { ErrorRequestHandler, Request, RequestHandler, Response, Router } from 'express';
import { LocalAttributionStore } from './attribution-store';
import { AttributionValidationConfig, validateAttributionRequest } from './attribution-validation';
import { selectedAttributionCode } from './attribution-business';
import { AttributionRateLimit } from './attribution-rate-limit';

const origin = 'https://lksdisplaybox.online';
const unknown = (reason: string) => ({ contractVersion: '1.0.0', outcome: 'unknown', shortCode: null, expiresAt: null, reason });

export type AttributionRouterOptions = {
  enabled: boolean;
  store: LocalAttributionStore;
  validation: AttributionValidationConfig;
  now: () => number;
  allowRequest: (clientAddress: string) => boolean;
  requireOwner: RequestHandler;
  requireOwnerOriginAndCsrf: RequestHandler;
  reportError: (message: string) => void;
};

/** Mount before any application-wide body parser to enforce the smaller limit. */
export const createAttributionRouter = (options: AttributionRouterOptions): Router => {
  const router = Router();
  if (!options.enabled) return router;
  const rateLimit = new AttributionRateLimit();
  const parse = express.json({ limit: '8kb', strict: true });
  const parseError: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(422).json({ error: 'Invalid request body.' });
  };
  const firstParty: RequestHandler = (req, res, next) => {
    if (req.get('origin') !== origin) { res.sendStatus(403); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    if (req.originalUrl.includes('?')) { res.sendStatus(422); return; }
    if (!rateLimit.allow(req.ip || '', options.now()) || !options.allowRequest(req.ip || '')) { res.sendStatus(429); return; }
    next();
  };
  router.options(['/api/attribution/v1/handoffs', '/api/attribution/v1/revoke'], firstParty, (_req, res) => {
    const requestedMethod = _req.get('access-control-request-method');
    const requestedHeaders = (_req.get('access-control-request-headers') || '')
      .split(',')
      .map(header => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedMethod !== 'POST'
        || requestedHeaders.some(header => header !== 'content-type' && header !== 'idempotency-key')) {
      res.sendStatus(403); return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    res.sendStatus(204);
  });
  router.post('/api/attribution/v1/handoffs', firstParty, parse, parseError, (req: Request, res: Response) => {
    const now = options.now();
    const validation = validateAttributionRequest(req.body, options.validation, now);
    if (validation.kind === 'invalid'
        || typeof req.get('Idempotency-Key') !== 'string'
        || req.get('Idempotency-Key') !== req.body?.requestId) {
      res.status(422).json({ error: 'Invalid request.' }); return;
    }
    try {
      if (validation.kind === 'consent_unavailable') {
        if (options.store.hasConflict(validation.request, now)) { res.status(409).json({ error: 'Idempotency conflict.' }); return; }
        res.status(200).json(unknown('consent_unavailable')); return;
      }
      if (validation.request.firstTouch.channel === 'unknown' || validation.request.lastTouch.channel === 'unknown') {
        if (options.store.hasConflict(validation.request, now)) { res.status(409).json({ error: 'Idempotency conflict.' }); return; }
        res.status(200).json(unknown('untrusted_context')); return;
      }
      const result = options.store.create(validation.request, now);
      if (result.outcome === 'conflict') { res.status(409).json({ error: 'Idempotency conflict.' }); return; }
      if (result.outcome === 'revoked') { res.status(200).json(unknown('revoked')); return; }
      res.status(result.outcome === 'created' ? 201 : 200).json({
        contractVersion: '1.0.0', ...result, reason: null,
      });
    } catch {
      options.reportError('Attribution registration unavailable.');
      res.status(503).json(unknown('service_unavailable'));
    }
  });
  router.post('/api/attribution/v1/revoke', firstParty, parse, parseError, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || Object.keys(body).sort().join(',') !== 'attributionId,contractVersion,revocationProof'
        || body.contractVersion !== '1.0.0'
        || typeof body.attributionId !== 'string' || !/^aid_v1_[0-9a-f]{32}$/.test(body.attributionId)
        || typeof body.revocationProof !== 'string' || !/^rv_v1_[0-9a-f]{64}$/.test(body.revocationProof)) {
      res.status(422).json({ error: 'Invalid request.' }); return;
    }
    try {
      options.store.revoke(body.attributionId, body.revocationProof, options.now());
      res.sendStatus(204);
    } catch {
      options.reportError('Attribution revocation unavailable.');
      res.sendStatus(503);
    }
  });
  router.post('/admin/attribution/v1/resolve', options.requireOwner, options.requireOwnerOriginAndCsrf, parse, parseError, (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || Object.keys(body).sort().join(',') !== 'contractVersion,shortCode'
        || body.contractVersion !== '1.0.0'
        || (body.shortCode !== null && (typeof body.shortCode !== 'string' || body.shortCode.length > 200))) {
      res.status(422).json({ error: 'Invalid request.' }); return;
    }
    const text = String(body.shortCode || '').trim();
    const markers = [...new Set([...text.matchAll(/LKS-[A-Za-z0-9_-]*/g)].map(match => match[0]))];
    const code = selectedAttributionCode(text);
    const reason = !text ? 'missing' : markers.length > 1 ? 'ambiguous' : !code ? 'malformed' : 'not_found';
    try {
      const snapshot = code ? options.store.resolve(code, options.now()) : null;
      res.json({ contractVersion: '1.0.0', outcome: snapshot ? 'matched' : 'unknown', snapshot, reason: snapshot ? null : reason });
    } catch {
      options.reportError('Attribution resolution unavailable.');
      res.json({ contractVersion: '1.0.0', outcome: 'unknown', snapshot: null, reason: 'service_unavailable' });
    }
  });
  return router;
};
