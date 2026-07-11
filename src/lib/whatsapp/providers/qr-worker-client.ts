import crypto from 'crypto';

import type { QrSendResult, QrWorkerQr, QrWorkerStatus } from './types';

const DEFAULT_TIMEOUT_MS = 15000;

export class QrWorkerError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = 'QrWorkerError';
    this.code = code;
    this.status = status;
  }
}

function getWorkerConfig() {
  const baseUrl = process.env.WHATSAPP_QR_WORKER_URL?.trim().replace(/\/$/, '');
  const secret = process.env.WHATSAPP_QR_WORKER_SECRET?.trim();
  if (!baseUrl || !secret) {
    throw new QrWorkerError(
      'qr_worker_not_configured',
      'QR connector worker is not configured. Set WHATSAPP_QR_WORKER_URL and WHATSAPP_QR_WORKER_SECRET.',
      503,
    );
  }
  return { baseUrl, secret };
}

function signBody(secret: string, body: string, timestamp: string) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

async function requestWorker<T>(
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {},
): Promise<T> {
  const { baseUrl, secret } = getWorkerConfig();
  const body = init.body ? JSON.stringify(init.body) : '';
  const timestamp = String(Date.now());
  const signature = signBody(secret, body, timestamp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-WINAI-Timestamp': timestamp,
        'X-WINAI-Signature': signature,
      },
      body: body || undefined,
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => null)) as unknown;

    if (!res.ok) {
      const errorPayload =
        payload && typeof payload === 'object'
          ? (payload as { error?: unknown; code?: unknown })
          : null;
      const message =
        typeof errorPayload?.error === 'string'
          ? errorPayload.error
          : 'QR connector worker request failed.';
      const code =
        typeof errorPayload?.code === 'string'
          ? errorPayload.code
          : 'qr_worker_error';
      throw new QrWorkerError(code, message, res.status);
    }

    return payload as T;
  } catch (err) {
    if (err instanceof QrWorkerError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new QrWorkerError(
        'qr_worker_timeout',
        'QR connector worker did not respond in time.',
        504,
      );
    }
    throw new QrWorkerError(
      'qr_worker_unreachable',
      'QR connector worker is unreachable.',
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export function qrSessionId(accountId: string) {
  return `acct_${accountId}`;
}

export async function startQrSession(accountId: string): Promise<QrWorkerQr> {
  return requestWorker<QrWorkerQr>('/sessions/start', {
    method: 'POST',
    body: { accountId, sessionId: qrSessionId(accountId) },
  });
}

export async function getQrCode(accountId: string): Promise<QrWorkerQr> {
  return requestWorker<QrWorkerQr>(
    `/sessions/${encodeURIComponent(qrSessionId(accountId))}/qr`,
  );
}

export async function getQrStatus(accountId: string): Promise<QrWorkerStatus> {
  return requestWorker<QrWorkerStatus>(
    `/sessions/${encodeURIComponent(qrSessionId(accountId))}/status`,
  );
}

export async function disconnectQrSession(
  accountId: string,
): Promise<QrWorkerStatus> {
  return requestWorker<QrWorkerStatus>(
    `/sessions/${encodeURIComponent(qrSessionId(accountId))}`,
    { method: 'DELETE' },
  );
}

export async function sendQrMessage(args: {
  accountId: string;
  to: string;
  text?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  kind: string;
}): Promise<QrSendResult> {
  return requestWorker<QrSendResult>(
    `/sessions/${encodeURIComponent(qrSessionId(args.accountId))}/send`,
    {
      method: 'POST',
      body: {
        to: args.to,
        kind: args.kind,
        text: args.text ?? null,
        mediaUrl: args.mediaUrl ?? null,
        filename: args.filename ?? null,
      },
    },
  );
}
