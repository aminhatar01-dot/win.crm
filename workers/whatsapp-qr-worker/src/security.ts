import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyHmac(
  req: RawBodyRequest,
  res: Response,
  next: NextFunction,
) {
  const timestamp = String(req.header('X-WINAI-Timestamp') || '');
  const signature = String(req.header('X-WINAI-Signature') || '');
  const ts = Number(timestamp);

  if (!timestamp || !signature || !Number.isFinite(ts)) {
    return res.status(401).json({
      error: 'Missing or invalid request signature.',
      code: 'signature_required',
    });
  }

  if (Math.abs(Date.now() - ts) > config.hmacMaxSkewMs) {
    return res.status(401).json({
      error: 'Request signature timestamp is outside the allowed window.',
      code: 'signature_stale',
    });
  }

  const rawBody = req.rawBody?.toString('utf8') || '';
  const expected = crypto
    .createHmac('sha256', config.workerSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  if (!timingSafeEqualHex(signature, expected)) {
    return res.status(401).json({
      error: 'Invalid request signature.',
      code: 'signature_invalid',
    });
  }

  return next();
}
