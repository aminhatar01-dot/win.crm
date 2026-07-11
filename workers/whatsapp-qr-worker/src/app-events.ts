import crypto from 'node:crypto';

import { config } from './config.js';
import { logger } from './logger.js';

export interface InboundQrMessageEvent {
  type: 'message.received';
  provider: 'qr_session';
  accountId: string;
  sessionId: string;
  messageId: string;
  from: string;
  pushName?: string | null;
  timestamp: string;
  contentType: 'text' | 'image' | 'video' | 'document' | 'audio' | 'location';
  contentText?: string | null;
}

export interface QrSessionStatusEvent {
  type: 'session.status';
  provider: 'qr_session';
  accountId: string;
  sessionId: string;
  status: 'disconnected' | 'waiting_qr' | 'connecting' | 'connected' | 'error';
  connectedAt?: string | null;
  lastError?: string | null;
}

export type QrAppEvent = InboundQrMessageEvent | QrSessionStatusEvent;

function signBody(body: string, timestamp: string) {
  return crypto
    .createHmac('sha256', config.workerSecret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

function hmacDiagnostic(body: string, timestamp: string) {
  return {
    algorithm: 'sha256',
    signatureFormat: 'hex',
    secretLength: config.workerSecret.length,
    bodyLength: Buffer.byteLength(body, 'utf8'),
    timestamp,
    timestampValid: Number.isFinite(Number(timestamp)),
    headers: {
      timestamp: 'X-WINAI-Timestamp',
      signature: 'X-WINAI-Signature',
    },
  };
}

function retryDelayMs(attempt: number) {
  return attempt * 750;
}

function shouldRetry(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeError(err: unknown) {
  if (err instanceof Error) return err.message.slice(0, 240);
  return String(err).slice(0, 240);
}

function logContext(event: QrAppEvent, destinationUrl: string, attempt: number) {
  return {
    destinationUrl,
    eventType: event.type,
    accountId: event.accountId,
    sessionId: event.sessionId,
    attempt,
  };
}

export async function dispatchAppEvent(event: QrAppEvent) {
  if (!config.appUrl) {
    logger.error(
      {
        eventType: event.type,
        sessionId: event.sessionId,
        accountId: event.accountId,
      },
      'WINAI_APP_URL is not configured; QR event cannot be delivered',
    );
    return;
  }

  const body = JSON.stringify(event);
  const maxAttempts = 3;
  const destinationUrl = `${config.appUrl}/api/whatsapp/qr/events`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestTimestamp = String(Date.now());
    const signature = signBody(body, requestTimestamp);

    try {
      logger.info(
        {
          ...logContext(event, destinationUrl, attempt),
          hmac: hmacDiagnostic(body, requestTimestamp),
        },
        'delivering QR event to app',
      );

      const res = await fetch(destinationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WINAI-Timestamp': requestTimestamp,
          'X-WINAI-Signature': signature,
        },
        body,
      });
      const payload = (await res.json().catch(() => null)) as
        | { code?: string; conversationId?: string; stored?: boolean }
        | null;

      if (!res.ok) {
        const retry = attempt < maxAttempts && shouldRetry(res.status);
        logger.warn(
          {
            ...logContext(event, destinationUrl, attempt),
            status: res.status,
            retry,
            code: payload?.code,
            hmac: hmacDiagnostic(body, requestTimestamp),
          },
          'QR event delivery failed',
        );

        if (retry) {
          await sleep(retryDelayMs(attempt));
          continue;
        }

        return;
      }

      logger.info(
        {
          ...logContext(event, destinationUrl, attempt),
          status: res.status,
          conversationId: payload?.conversationId,
          stored: payload?.stored,
        },
        event.type === 'message.received'
          ? 'inbound QR event delivered'
          : 'QR status event delivered',
      );
      return;
    } catch (err) {
      const retry = attempt < maxAttempts;
      logger.error(
        {
          ...logContext(event, destinationUrl, attempt),
          retry,
          err: summarizeError(err),
        },
        'QR event delivery threw',
      );

      if (retry) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
    }
  }
}

export async function dispatchInboundEvent(event: InboundQrMessageEvent) {
  await dispatchAppEvent(event);
}

export async function dispatchStatusEvent(event: QrSessionStatusEvent) {
  await dispatchAppEvent(event);
}
