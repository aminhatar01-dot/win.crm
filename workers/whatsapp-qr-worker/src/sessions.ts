import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
  type WAMessage,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

import { config } from './config.js';
import { logger } from './logger.js';
import { FileSessionStore, validateSessionId, type SessionStore } from './storage.js';
import type { QrStatus, WorkerQrResponse, WorkerSendResponse, WorkerStatusResponse } from './types.js';
import {
  dispatchInboundEvent,
  dispatchStatusEvent,
  type InboundQrMessageEvent,
} from './app-events.js';

type SendKind = 'text' | 'image' | 'video' | 'document' | 'audio';

interface SessionRecord {
  sessionId: string;
  accountId: string;
  status: QrStatus;
  socket?: WASocket;
  qr?: string | null;
  qrDataUrl?: string | null;
  expiresAt?: string | null;
  connectedAt?: string | null;
  lastError?: string | null;
  starting?: Promise<SessionRecord>;
  intentionalDisconnect?: boolean;
  reconnectAttempts?: number;
  reconnectTimer?: NodeJS.Timeout;
  qrRefreshCount?: number;
  deliveredMessageIds?: Set<string>;
}

const MAX_RECONNECT_ATTEMPTS = 5;

const RECONNECTABLE_CLOSE_CODES = new Set<number | undefined>([
  DisconnectReason.connectionClosed,
  DisconnectReason.connectionLost,
  DisconnectReason.restartRequired,
  DisconnectReason.timedOut,
  408,
  515,
]);

const NON_RECONNECTABLE_CLOSE_CODES = new Set<number | undefined>([
  DisconnectReason.badSession,
  DisconnectReason.loggedOut,
  DisconnectReason.forbidden,
  DisconnectReason.connectionReplaced,
  DisconnectReason.multideviceMismatch,
]);

function sessionIdForAccount(accountId: string) {
  return `acct_${accountId}`;
}

function normalizeToJid(phone: string) {
  const digits = phone.replace(/[^\d]/g, '');
  if (!digits) {
    throw Object.assign(new Error('Recipient phone number is required.'), {
      status: 400,
    });
  }
  return `${digits}@s.whatsapp.net`;
}

function errorStatus(err: unknown) {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = Number((err as { status?: unknown }).status);
    if (Number.isFinite(status)) return status;
  }
  return 500;
}

function disconnectReasonName(statusCode: number | null | undefined) {
  if (!statusCode) return 'unknown';
  const entry = Object.entries(DisconnectReason).find(
    ([, value]) => value === statusCode,
  );
  return entry?.[0] ?? 'unknown';
}

function numericValue(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function getDisconnectDiagnostics(error: unknown): {
  statusCode: number | null;
  reason: string;
  errorName: string | null;
  errorMessage: string | null;
} {
  if (!error || typeof error !== 'object') {
    return {
      statusCode: null,
      reason: 'unknown',
      errorName: null,
      errorMessage: typeof error === 'string' ? error : null,
    };
  }

  const err = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    output?: {
      statusCode?: unknown;
      payload?: { error?: unknown; message?: unknown };
    };
    data?: { statusCode?: unknown; status?: unknown; code?: unknown };
  };
  const statusCode =
    numericValue(err.output?.statusCode) ??
    numericValue(err.data?.statusCode) ??
    numericValue(err.data?.status) ??
    numericValue(err.statusCode) ??
    numericValue(err.status) ??
    numericValue(err.data?.code) ??
    numericValue(err.code);
  const errorMessage =
    (typeof err.output?.payload?.message === 'string'
      ? err.output.payload.message
      : null) ??
    (typeof err.message === 'string' ? err.message : null) ??
    (typeof err.output?.payload?.error === 'string'
      ? err.output.payload.error
      : null);

  return {
    statusCode,
    reason: disconnectReasonName(statusCode),
    errorName: typeof err.name === 'string' ? err.name : null,
    errorMessage,
  };
}

function connectionDiagnostics(
  record: SessionRecord,
  update: Partial<ConnectionState>,
) {
  const disconnect = getDisconnectDiagnostics(update.lastDisconnect?.error);
  return {
    sessionId: record.sessionId,
    connection: update.connection ?? null,
    isNewLogin: update.isNewLogin ?? null,
    receivedPendingNotifications: update.receivedPendingNotifications ?? null,
    qrGenerated: Boolean(update.qr),
    statusCode: disconnect.statusCode,
    disconnectReason: disconnect.reason,
    errorName: disconnect.errorName,
    errorMessage: disconnect.errorMessage,
    reconnectAttempts: record.reconnectAttempts ?? 0,
    intentionalDisconnect: Boolean(record.intentionalDisconnect),
    timestamp: new Date().toISOString(),
  };
}

function timestampFromMessage(message: WAMessage) {
  const raw = message.messageTimestamp;
  const seconds =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'bigint'
        ? Number(raw)
        : raw && typeof raw === 'object' && 'toNumber' in raw
          ? (raw as { toNumber: () => number }).toNumber()
          : Math.floor(Date.now() / 1000);
  return new Date(seconds * 1000).toISOString();
}

function messageTimestampMs(message: WAMessage) {
  return new Date(timestampFromMessage(message)).getTime();
}

function phoneFromJid(jid: string | undefined | null) {
  if (!jid) return null;
  if (!jid.endsWith('@s.whatsapp.net')) return null;
  const phone = jid.split('@')[0]?.replace(/\D/g, '');
  return phone || null;
}

function unwrapMessage(message: WAMessage) {
  const content = message.message;
  return (
    content?.ephemeralMessage?.message ??
    content?.viewOnceMessage?.message ??
    content?.viewOnceMessageV2?.message ??
    content?.viewOnceMessageV2Extension?.message ??
    content
  );
}

function inboundEventFromBaileys(
  record: SessionRecord,
  message: WAMessage,
): InboundQrMessageEvent | null {
  if (message.key.fromMe) return null;

  const from = phoneFromJid(message.key.remoteJid);
  if (!from) return null;

  const content = unwrapMessage(message);
  const messageId = message.key.id;
  if (!content || !messageId) return null;

  if (content.conversation) {
    return {
      type: 'message.received',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      messageId,
      from,
      pushName: message.pushName ?? null,
      timestamp: timestampFromMessage(message),
      contentType: 'text',
      contentText: content.conversation,
    };
  }

  if (content.extendedTextMessage?.text) {
    return {
      type: 'message.received',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      messageId,
      from,
      pushName: message.pushName ?? null,
      timestamp: timestampFromMessage(message),
      contentType: 'text',
      contentText: content.extendedTextMessage.text,
    };
  }

  if (content.imageMessage) {
    return {
      type: 'message.received',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      messageId,
      from,
      pushName: message.pushName ?? null,
      timestamp: timestampFromMessage(message),
      contentType: 'image',
      contentText: content.imageMessage.caption ?? null,
    };
  }

  if (content.videoMessage) {
    return {
      type: 'message.received',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      messageId,
      from,
      pushName: message.pushName ?? null,
      timestamp: timestampFromMessage(message),
      contentType: 'video',
      contentText: content.videoMessage.caption ?? null,
    };
  }

  if (content.documentMessage) {
    return {
      type: 'message.received',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      messageId,
      from,
      pushName: message.pushName ?? null,
      timestamp: timestampFromMessage(message),
      contentType: 'document',
      contentText:
        content.documentMessage.caption ||
        content.documentMessage.fileName ||
        null,
    };
  }

  if (content.audioMessage) {
    return {
      type: 'message.received',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      messageId,
      from,
      pushName: message.pushName ?? null,
      timestamp: timestampFromMessage(message),
      contentType: 'audio',
      contentText: null,
    };
  }

  if (content.locationMessage) {
    const loc = content.locationMessage;
    return {
      type: 'message.received',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      messageId,
      from,
      pushName: message.pushName ?? null,
      timestamp: timestampFromMessage(message),
      contentType: 'location',
      contentText: [loc.name, loc.address, `${loc.degreesLatitude},${loc.degreesLongitude}`]
        .filter(Boolean)
        .join(' - '),
    };
  }

  return null;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly store: SessionStore = new FileSessionStore()) {}

  async start(accountId: string, sessionId: string): Promise<WorkerQrResponse> {
    validateSessionId(sessionId);
    if (sessionId !== sessionIdForAccount(accountId)) {
      throw Object.assign(new Error('Session id does not match account id.'), {
        status: 400,
      });
    }

    const existing = this.sessions.get(sessionId);
    if (existing?.starting) await existing.starting;
    if (
      existing?.socket &&
      ['waiting_qr', 'connecting', 'connected'].includes(existing.status)
    ) {
      logger.info(
        { sessionId, status: existing.status },
        'qr session start reused existing socket',
      );
      return this.qrResponse(existing);
    }

    const record =
      existing ??
      ({
        sessionId,
        accountId,
        status: 'disconnected',
      } satisfies SessionRecord);
    if (existing?.socket) {
      existing.socket.end(undefined);
      existing.socket = undefined;
    }
    this.sessions.set(sessionId, record);

    record.starting = this.openSocket(record).finally(() => {
      record.starting = undefined;
    });
    await record.starting;
    await this.waitForInitialQr(record);
    return this.qrResponse(record);
  }

  async qr(sessionId: string): Promise<WorkerQrResponse> {
    validateSessionId(sessionId);
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { status: 'disconnected', qr: null, qrDataUrl: null };
    }
    return this.qrResponse(record);
  }

  async status(sessionId: string): Promise<WorkerStatusResponse> {
    validateSessionId(sessionId);
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { status: 'disconnected', sessionRef: sessionId };
    }
    return {
      status: record.status,
      sessionRef: record.sessionId,
      connectedAt: record.connectedAt ?? null,
      lastError: record.lastError ?? null,
    };
  }

  async disconnect(sessionId: string): Promise<WorkerStatusResponse> {
    validateSessionId(sessionId);
    const record = this.sessions.get(sessionId);
    if (record) {
      record.intentionalDisconnect = true;
      try {
        await record.socket?.logout();
      } catch (err) {
        logger.warn({ sessionId, err: err instanceof Error ? err.message : err }, 'logout failed');
      }
      if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
      record.socket?.end(undefined);
      record.status = 'disconnected';
      record.qr = null;
      record.qrDataUrl = null;
      record.expiresAt = null;
      record.connectedAt = null;
      record.lastError = null;
      this.sessions.delete(sessionId);
    }
    await this.store.remove(sessionId);
    return { status: 'disconnected', sessionRef: sessionId };
  }

  async send(
    sessionId: string,
    args: {
      to: string;
      kind: string;
      text?: string | null;
      mediaUrl?: string | null;
      filename?: string | null;
    },
  ): Promise<WorkerSendResponse> {
    validateSessionId(sessionId);
    const record = this.sessions.get(sessionId);
    if (!record || record.status !== 'connected' || !record.socket) {
      throw Object.assign(new Error('QR session is not connected.'), {
        status: 409,
      });
    }

    const kind = args.kind as SendKind;
    const jid = normalizeToJid(args.to);
    const text = args.text?.trim() || '';
    const mediaUrl = args.mediaUrl?.trim() || '';
    const filename = args.filename?.trim() || undefined;

    if (kind === 'text') {
      if (!text) {
        throw Object.assign(new Error('text is required for text messages.'), {
          status: 400,
        });
      }
      const message = await record.socket.sendMessage(jid, { text });
      return { messageId: message?.key.id || `${Date.now()}` };
    }

    if (!['image', 'video', 'document', 'audio'].includes(kind)) {
      throw Object.assign(new Error(`Unsupported QR message kind "${args.kind}".`), {
        status: 400,
      });
    }
    if (!mediaUrl) {
      throw Object.assign(new Error('mediaUrl is required for media messages.'), {
        status: 400,
      });
    }

    const message = await record.socket.sendMessage(jid, this.mediaPayload(kind, mediaUrl, text, filename));
    return { messageId: message?.key.id || `${Date.now()}` };
  }

  statusCode(err: unknown) {
    return errorStatus(err);
  }

  private async openSocket(record: SessionRecord): Promise<SessionRecord> {
    if (record.socket) {
      logger.warn(
        {
          sessionId: record.sessionId,
          status: record.status,
          timestamp: new Date().toISOString(),
        },
        'closing existing QR socket before opening replacement',
      );
      record.socket.end(undefined);
      record.socket = undefined;
    }

    const authPath = await this.store.pathFor(record.sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    record.intentionalDisconnect = false;
    record.status = 'waiting_qr';
    record.lastError = null;
    record.reconnectAttempts ??= 0;
    record.qrRefreshCount = 0;
    record.deliveredMessageIds ??= new Set<string>();

    logger.info(
      {
        sessionId: record.sessionId,
        authPath,
        baileysVersion: version.join('.'),
        browser: 'macOS/Chrome',
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        retryRequestDelayMs: 500,
        defaultQueryTimeoutMs: 60000,
      },
      'opening qr session socket',
    );

    const socket = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      retryRequestDelayMs: 500,
      defaultQueryTimeoutMs: 60_000,
      qrTimeout: 60_000,
    });
    record.socket = socket;

    socket.ev.on('creds.update', async () => {
      await saveCreds();
      logger.info({ sessionId: record.sessionId }, 'qr session credentials saved');
    });
    socket.ev.on('messages.upsert', async ({ type, messages }) => {
      logger.info(
        {
          sessionId: record.sessionId,
        accountId: record.accountId,
          eventType: type,
          count: messages.length,
        },
        'WhatsApp event received',
      );

      if (type !== 'notify') return;

      for (const message of messages) {
        const event = inboundEventFromBaileys(record, message);
        if (!event) continue;
        if (!this.shouldIngestMessage(record, message, event)) continue;

        logger.info(
          {
            sessionId: record.sessionId,
            accountId: record.accountId,
            eventType: event.type,
            contentType: event.contentType,
          },
          'inbound QR message parsed',
        );
        await dispatchInboundEvent(event);
      }
    });
    socket.ev.on('messaging-history.set', ({ chats, contacts, messages, syncType, progress }) => {
      logger.info(
        {
          sessionId: record.sessionId,
          accountId: record.accountId,
          eventType: 'messaging-history.set',
          chats: chats.length,
          contacts: contacts.length,
          messages: messages.length,
          syncType,
          progress,
        },
        'WhatsApp event received',
      );
    });
    socket.ev.on('messaging-history.status', ({ syncType, status, explicit }) => {
      logger.info(
        {
          sessionId: record.sessionId,
          accountId: record.accountId,
          eventType: 'messaging-history.status',
          syncType,
          status,
          explicit,
        },
        'WhatsApp event received',
      );
    });
    socket.ev.on('message-receipt.update', (receipts) => {
      logger.info(
        {
          sessionId: record.sessionId,
          accountId: record.accountId,
          eventType: 'message-receipt.update',
          count: receipts.length,
        },
        'WhatsApp event received',
      );
    });
    socket.ev.on('chats.upsert', (chats) => {
      logger.info(
        {
          sessionId: record.sessionId,
          accountId: record.accountId,
          eventType: 'chats.upsert',
          count: chats.length,
        },
        'WhatsApp event received',
      );
    });
    socket.ev.on('contacts.upsert', (contacts) => {
      logger.info(
        {
          sessionId: record.sessionId,
          accountId: record.accountId,
          eventType: 'contacts.upsert',
          count: contacts.length,
        },
        'WhatsApp event received',
      );
    });
    socket.ev.on('connection.update', async (update) => {
      const diagnostics = connectionDiagnostics(record, update);
      const { statusCode, disconnectReason: reason, errorMessage } = diagnostics;
      logger.info(
        diagnostics,
        config.qrDebug
          ? 'baileys connection update diagnostics'
          : 'baileys connection update',
      );

      if (update.qr) {
        record.qrRefreshCount = (record.qrRefreshCount ?? 0) + 1;
        record.qr = update.qr;
        record.qrDataUrl = await QRCode.toDataURL(update.qr, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 320,
        });
        record.expiresAt = new Date(Date.now() + 60_000).toISOString();
        record.status = 'waiting_qr';
        record.lastError = null;
        logger.info(
          {
            sessionId: record.sessionId,
            qrRefreshCount: record.qrRefreshCount,
            expiresAt: record.expiresAt,
          },
          'qr code generated/refreshed',
        );
        await this.dispatchStatus(record);
      }

      if (update.connection === 'connecting' && !update.qr) {
        record.status = 'connecting';
        record.qr = null;
        record.qrDataUrl = null;
        record.expiresAt = null;
        record.lastError = null;
        await this.dispatchStatus(record);
      }

      if (update.connection === 'open') {
        record.status = 'connected';
        record.connectedAt = new Date().toISOString();
        record.qr = null;
        record.qrDataUrl = null;
        record.expiresAt = null;
        record.lastError = null;
        record.reconnectAttempts = 0;
        logger.info({ sessionId: record.sessionId }, 'qr session connected');
        await this.dispatchStatus(record);
      }

      if (update.connection === 'close') {
        const closeCode = statusCode ?? undefined;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        record.socket = undefined;
        logger.warn(
          {
            ...diagnostics,
            disconnectReason: reason,
          },
          'qr session socket closed',
        );

        if (
          record.intentionalDisconnect ||
          loggedOut ||
          NON_RECONNECTABLE_CLOSE_CODES.has(closeCode)
        ) {
          record.status = 'disconnected';
          record.connectedAt = null;
          record.qr = null;
          record.qrDataUrl = null;
          record.expiresAt = null;
          record.lastError =
            record.intentionalDisconnect
              ? null
              : `WhatsApp closed the QR session (${reason}). Start a new session and scan a fresh QR.`;
          if (!record.intentionalDisconnect) await this.store.remove(record.sessionId);
          logger.info(
            {
              sessionId: record.sessionId,
              statusCode,
              disconnectReason: reason,
              errorMessage,
              timestamp: new Date().toISOString(),
            },
            'qr session requires fresh login',
          );
          await this.dispatchStatus(record);
          return;
        }

        if (RECONNECTABLE_CLOSE_CODES.has(closeCode)) {
          this.scheduleReconnect(record, closeCode, reason);
          return;
        }

        record.status = 'error';
        record.lastError = `WhatsApp Web connection closed (${reason}). Start the session again to reconnect.`;
        await this.dispatchStatus(record);
      }
    });

    return record;
  }

  private qrResponse(record: SessionRecord): WorkerQrResponse {
    return {
      status: record.status,
      qr: record.qr ?? null,
      qrDataUrl: record.qrDataUrl ?? null,
      expiresAt: record.expiresAt ?? null,
      lastError: record.lastError ?? null,
    };
  }

  private async waitForInitialQr(record: SessionRecord) {
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      record.status === 'waiting_qr' &&
      !record.qrDataUrl
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private scheduleReconnect(
    record: SessionRecord,
    statusCode: number | undefined,
    reason: string,
  ) {
    if (record.reconnectTimer || record.starting) {
      logger.info(
        {
          sessionId: record.sessionId,
          statusCode,
          disconnectReason: reason,
          reconnectAttempts: record.reconnectAttempts ?? 0,
          hasReconnectTimer: Boolean(record.reconnectTimer),
          hasStartingPromise: Boolean(record.starting),
          timestamp: new Date().toISOString(),
        },
        'qr session reconnect already scheduled',
      );
      return;
    }

    const attempts = (record.reconnectAttempts ?? 0) + 1;
    record.reconnectAttempts = attempts;
    record.status = 'connecting';
    record.qr = null;
    record.qrDataUrl = null;
    record.expiresAt = null;
    record.lastError = `WhatsApp Web connection closed (${reason}). Reconnecting (${attempts}/${MAX_RECONNECT_ATTEMPTS}).`;
    void this.dispatchStatus(record);

    if (attempts > MAX_RECONNECT_ATTEMPTS) {
      record.status = 'error';
      record.lastError = `WhatsApp Web connection closed repeatedly (${reason}). Generate a new QR to reconnect.`;
      logger.warn(
        { sessionId: record.sessionId, statusCode, reason, attempts },
        'qr session reconnect attempts exhausted',
      );
      void this.dispatchStatus(record);
      return;
    }

    const delayMs =
      statusCode === DisconnectReason.restartRequired
        ? 0
        : Math.min(30_000, 1_500 * attempts);
    logger.info(
      { sessionId: record.sessionId, statusCode, reason, attempts, delayMs },
      'qr session reconnect scheduled',
    );
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = undefined;
      record.starting = this.openSocket(record)
        .catch((err) => {
          record.status = 'error';
          record.lastError =
            err instanceof Error ? err.message : 'QR reconnect failed.';
          logger.error(
            {
              sessionId: record.sessionId,
              err: err instanceof Error ? err.message : err,
            },
            'qr session reconnect failed',
          );
          return record;
        })
        .finally(() => {
          record.starting = undefined;
        });
    }, delayMs);
  }

  private mediaPayload(kind: SendKind, url: string, text: string, filename?: string) {
    if (kind === 'image') return { image: { url }, caption: text || undefined };
    if (kind === 'video') return { video: { url }, caption: text || undefined };
    if (kind === 'audio') return { audio: { url }, mimetype: 'audio/ogg; codecs=opus' };
    return {
      document: { url },
      fileName: filename || 'document',
      mimetype: 'application/octet-stream',
      caption: text || undefined,
    };
  }

  private shouldIngestMessage(
    record: SessionRecord,
    message: WAMessage,
    event: InboundQrMessageEvent,
  ) {
    record.deliveredMessageIds ??= new Set<string>();
    const dedupeKey = `${event.sessionId}:${event.messageId}`;
    if (record.deliveredMessageIds.has(dedupeKey)) {
      logger.info(
        {
          sessionId: record.sessionId,
          accountId: record.accountId,
          eventType: event.type,
          messageId: event.messageId,
        },
        'duplicate inbound QR message skipped',
      );
      return false;
    }

    if (!config.allowHistoryInbox && record.connectedAt) {
      const connectedAtMs = new Date(record.connectedAt).getTime();
      const messageMs = messageTimestampMs(message);
      if (Number.isFinite(messageMs) && messageMs < connectedAtMs - config.historyGraceMs) {
        logger.info(
          {
            sessionId: record.sessionId,
            accountId: record.accountId,
            eventType: event.type,
            messageId: event.messageId,
          },
          'historical inbound QR message skipped',
        );
        return false;
      }
    }

    record.deliveredMessageIds.add(dedupeKey);
    if (record.deliveredMessageIds.size > 2000) {
      const oldest = record.deliveredMessageIds.values().next().value;
      if (oldest) record.deliveredMessageIds.delete(oldest);
    }
    return true;
  }

  private async dispatchStatus(record: SessionRecord) {
    await dispatchStatusEvent({
      type: 'session.status',
      provider: 'qr_session',
      accountId: record.accountId,
      sessionId: record.sessionId,
      status: record.status,
      connectedAt: record.connectedAt ?? null,
      lastError: record.lastError ?? null,
    });
  }
}
