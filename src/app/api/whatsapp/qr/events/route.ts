import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { qrSessionId } from '@/lib/whatsapp/providers/qr-worker-client';

export const runtime = 'nodejs';

type QrInboundContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'document'
  | 'audio'
  | 'location';

type QrConnectionStatus =
  | 'disconnected'
  | 'waiting_qr'
  | 'connecting'
  | 'connected'
  | 'error';

interface QrInboundEvent {
  type: 'message.received';
  provider: 'qr_session';
  accountId: string;
  sessionId: string;
  messageId: string;
  from: string;
  pushName?: string | null;
  timestamp: string;
  contentType: QrInboundContentType;
  contentText?: string | null;
}

interface QrSessionStatusEvent {
  type: 'session.status';
  provider: 'qr_session';
  accountId: string;
  sessionId: string;
  status: QrConnectionStatus;
  connectedAt?: string | null;
  lastError?: string | null;
}

type QrEvent = QrInboundEvent | QrSessionStatusEvent;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRole) {
      throw new Error(
        'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for QR event processing.',
      );
    }
    _adminClient = createClient(url, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _adminClient;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeEventMeta(rawBody: string) {
  try {
    const payload = JSON.parse(rawBody) as Partial<QrEvent>;
    return {
      eventType: typeof payload.type === 'string' ? payload.type : 'unknown',
      accountId:
        typeof payload.accountId === 'string' ? payload.accountId : 'unknown',
      sessionId:
        typeof payload.sessionId === 'string' ? payload.sessionId : 'unknown',
    };
  } catch {
    return { eventType: 'unparseable', accountId: 'unknown', sessionId: 'unknown' };
  }
}

function verifyWorkerSignature(rawBody: string, request: Request) {
  const meta = safeEventMeta(rawBody);
  const secret = process.env.WHATSAPP_QR_WORKER_SECRET?.trim();
  const timestamp = request.headers.get('X-WINAI-Timestamp') || '';
  const signature = request.headers.get('X-WINAI-Signature') || '';
  const ts = Number(timestamp);
  const baseDiagnostic = {
    ...meta,
    secretLength: secret?.length ?? 0,
    algorithm: 'sha256',
    signatureFormat: 'hex',
    bodyLength: Buffer.byteLength(rawBody, 'utf8'),
    hasTimestampHeader: Boolean(timestamp),
    hasSignatureHeader: Boolean(signature),
    timestamp,
    timestampValid: Boolean(timestamp && Number.isFinite(ts)),
    signatureValid: false,
  };

  if (!secret) return { ok: false, code: 'secret_missing', ...baseDiagnostic };

  if (!timestamp || !signature || !Number.isFinite(ts)) {
    return { ok: false, code: 'signature_required', ...baseDiagnostic };
  }
  if (Math.abs(Date.now() - ts) > 300_000) {
    return {
      ok: false,
      code: 'signature_stale',
      ...baseDiagnostic,
      timestampSkewMs: Math.abs(Date.now() - ts),
    };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const signatureValid = timingSafeEqualHex(signature, expected);
  return {
    ok: signatureValid,
    code: 'signature_invalid',
    ...baseDiagnostic,
    signatureValid,
    receivedSignatureLength: signature.length,
    expectedSignatureLength: expected.length,
  };
}

function isQrInboundEvent(value: unknown): value is QrInboundEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<QrInboundEvent>;
  return (
    event.type === 'message.received' &&
    event.provider === 'qr_session' &&
    typeof event.accountId === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.messageId === 'string' &&
    typeof event.from === 'string' &&
    typeof event.timestamp === 'string' &&
    typeof event.contentType === 'string' &&
    ['text', 'image', 'video', 'document', 'audio', 'location'].includes(
      event.contentType,
    )
  );
}

function isQrSessionStatusEvent(value: unknown): value is QrSessionStatusEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<QrSessionStatusEvent>;
  return (
    event.type === 'session.status' &&
    event.provider === 'qr_session' &&
    typeof event.accountId === 'string' &&
    typeof event.sessionId === 'string' &&
    typeof event.status === 'string' &&
    ['disconnected', 'waiting_qr', 'connecting', 'connected', 'error'].includes(
      event.status,
    )
  );
}

async function loadQrConfig(accountId: string) {
  const { data: config, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('user_id, account_id, connection_method, qr_session_ref')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error || !config) {
    console.error('[qr-events] Config lookup failed', {
      accountId,
      error: error?.message ?? 'QR config not found',
    });
    throw new Error(error?.message || 'QR config not found');
  }
  console.info('[qr-events] Account resolved', { accountId });

  if (config.connection_method !== 'qr_session') {
    throw new Error('Account is not configured for QR session');
  }
  return config;
}

function assertSessionMatches(event: QrEvent) {
  const expectedSessionId = qrSessionId(event.accountId);
  if (event.sessionId !== expectedSessionId) {
    console.error('[qr-events] Session/account mismatch', {
      eventType: event.type,
      accountId: event.accountId,
      sessionId: event.sessionId,
    });
    throw new Error('Session id does not match account id');
  }
}

async function persistQrStatus(event: QrSessionStatusEvent) {
  assertSessionMatches(event);
  const config = await loadQrConfig(event.accountId);
  if (config.qr_session_ref && config.qr_session_ref !== event.sessionId) {
    throw new Error('QR session reference mismatch');
  }

  const now = new Date().toISOString();
  const connectedAt =
    event.status === 'connected' ? event.connectedAt || now : null;
  const { error } = await supabaseAdmin()
    .from('whatsapp_config')
    .update({
      status: event.status === 'connected' ? 'connected' : 'disconnected',
      qr_status: event.status,
      qr_session_ref: event.sessionId,
      qr_connected_at: connectedAt,
      qr_updated_at: now,
      qr_last_error: event.lastError ?? null,
    })
    .eq('account_id', event.accountId);

  if (error) {
    console.error('[qr-events] QR status update failed', {
      accountId: event.accountId,
      status: event.status,
      error: error.message,
    });
    throw new Error(`Failed to update QR status: ${error.message}`);
  }

  console.info('[qr-events] QR status stored', {
    accountId: event.accountId,
    status: event.status,
  });
  return { ok: true, stored: false, status: event.status };
}

async function findOrCreateContact(
  accountId: string,
  userId: string,
  phone: string,
  name: string | null | undefined,
) {
  const normalizedPhone = normalizePhone(phone);
  const existing = await findExistingContact(
    supabaseAdmin(),
    accountId,
    normalizedPhone,
  );

  if (existing) {
    if (name && name !== existing.name) {
      const { error } = await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) throw new Error(`Failed to update QR contact: ${error.message}`);
    }
    console.info('[qr-events] Contact resolved', {
      accountId,
      contactId: existing.id,
      created: false,
    });
    return { contact: existing, wasCreated: false };
  }

  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: userId,
      phone: normalizedPhone,
      name: name || normalizedPhone,
    })
    .select()
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(
        supabaseAdmin(),
        accountId,
        normalizedPhone,
      );
      if (raced) {
        console.info('[qr-events] Contact resolved', {
          accountId,
          contactId: raced.id,
          created: false,
        });
        return { contact: raced, wasCreated: false };
      }
    }
    console.error('[qr-events] Contact creation failed', {
      accountId,
      error: error.message,
    });
    throw new Error(`Failed to create QR contact: ${error.message}`);
  }

  console.info('[qr-events] Contact resolved', {
    accountId,
    contactId: data.id,
    created: true,
  });
  return { contact: data, wasCreated: true };
}

async function findOrCreateConversation(
  accountId: string,
  userId: string,
  contactId: string,
) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();

  if (findError) {
    console.error('[qr-events] Conversation lookup failed', {
      accountId,
      contactId,
      error: findError.message,
    });
    throw new Error(`Failed to find QR conversation: ${findError.message}`);
  }
  if (existing) {
    console.info('[qr-events] Conversation resolved', {
      accountId,
      conversationId: existing.id,
      created: false,
    });
    return { conversation: existing, created: false };
  }

  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select()
    .single();

  if (error) {
    console.error('[qr-events] Conversation creation failed', {
      accountId,
      contactId,
      error: error.message,
    });
    throw new Error(`Failed to create QR conversation: ${error.message}`);
  }
  console.info('[qr-events] Conversation resolved', {
    accountId,
    conversationId: data.id,
    created: true,
  });
  return { conversation: data, created: true };
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = verifyWorkerSignature(rawBody, request);
  if (!signature.ok) {
    console.warn('[qr-events] Signature rejected', signature);
    return NextResponse.json(
      { error: 'Invalid signature', code: signature.code },
      { status: 401 },
    );
  }
  console.info('[qr-events] Signature validated', {
    eventType: signature.eventType,
    accountId: signature.accountId,
    sessionId: signature.sessionId,
    secretLength: signature.secretLength,
    bodyLength: signature.bodyLength,
    timestampValid: signature.timestampValid,
    hasTimestampHeader: signature.hasTimestampHeader,
    hasSignatureHeader: signature.hasSignatureHeader,
    signatureValid: signature.signatureValid,
  });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn('[qr-events] Invalid JSON payload');
    return NextResponse.json(
      { error: 'Invalid JSON', code: 'bad_request' },
      { status: 400 },
    );
  }

  console.info('[qr-events] Event received', safeEventMeta(rawBody));

  try {
    if (isQrSessionStatusEvent(payload)) {
      const result = await persistQrStatus(payload);
      return NextResponse.json(result);
    }
    if (isQrInboundEvent(payload)) {
      const result = await processQrInboundEvent(payload);
      return NextResponse.json(result);
    }

    console.warn('[qr-events] Invalid QR event payload', safeEventMeta(rawBody));
    return NextResponse.json(
      { error: 'Invalid QR event payload', code: 'bad_request' },
      { status: 400 },
    );
  } catch (err) {
    console.error('[qr-events] Processing failed', {
      ...safeEventMeta(rawBody),
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: 'Failed to process QR event', code: 'qr_event_failed' },
      { status: 500 },
    );
  }
}

async function processQrInboundEvent(event: QrInboundEvent) {
  assertSessionMatches(event);
  const config = await loadQrConfig(event.accountId);
  if (config.qr_session_ref && config.qr_session_ref !== event.sessionId) {
    throw new Error('QR session reference mismatch');
  }

  await persistQrStatus({
    type: 'session.status',
    provider: 'qr_session',
    accountId: event.accountId,
    sessionId: event.sessionId,
    status: 'connected',
  });

  const contactOutcome = await findOrCreateContact(
    event.accountId,
    config.user_id,
    event.from,
    event.pushName,
  );
  const convOutcome = await findOrCreateConversation(
    event.accountId,
    config.user_id,
    contactOutcome.contact.id,
  );
  const conversation = convOutcome.conversation;

  if (convOutcome.created) {
    await dispatchWebhookEvent(
      supabaseAdmin(),
      event.accountId,
      'conversation.created',
      {
        conversation_id: conversation.id,
        contact_id: contactOutcome.contact.id,
      },
    );
  }

  const { data: existingMessage, error: existingError } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', event.messageId)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existingMessage) {
    console.info('[qr-events] Message already stored', {
      accountId: event.accountId,
      conversationId: conversation.id,
      messageId: existingMessage.id,
    });
    return {
      ok: true,
      stored: false,
      conversationId: conversation.id,
      messageId: existingMessage.id,
    };
  }

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0;

  const contentText =
    event.contentText ??
    (event.contentType === 'text' ? '' : `[${event.contentType}]`);
  const createdAt = new Date(event.timestamp).toISOString();

  const { data: inserted, error: insertError } = await supabaseAdmin()
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: event.contentType,
      content_text: contentText,
      media_url: null,
      message_id: event.messageId,
      status: 'delivered',
      created_at: createdAt,
    })
    .select('id')
    .single();
  if (insertError) {
    console.error('[qr-events] Message insert failed', {
      accountId: event.accountId,
      conversationId: conversation.id,
      error: insertError.message,
    });
    throw new Error(insertError.message);
  }
  console.info('[qr-events] Message stored', {
    accountId: event.accountId,
    conversationId: conversation.id,
    messageId: inserted.id,
  });

  const { error: convUpdateError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${event.contentType}]`,
      last_message_at: createdAt,
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);
  if (convUpdateError) {
    console.error('[qr-events] Inbox conversation update failed', {
      accountId: event.accountId,
      conversationId: conversation.id,
      error: convUpdateError.message,
    });
    throw new Error(convUpdateError.message);
  }
  console.info('[qr-events] Inbox updated', {
    accountId: event.accountId,
    conversationId: conversation.id,
  });

  const flowResult = await dispatchInboundToFlows({
    accountId: event.accountId,
    userId: config.user_id,
    contactId: contactOutcome.contact.id,
    conversationId: conversation.id,
    message: {
      kind: 'text',
      text: contentText,
      meta_message_id: event.messageId,
    },
    isFirstInboundMessage,
  });

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = [];
  if (!flowResult.consumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');

  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId: event.accountId,
      triggerType,
      contactId: contactOutcome.contact.id,
      context: {
        message_text: contentText,
        conversation_id: conversation.id,
      },
    }).catch((err) =>
      console.error('[qr-events] automation dispatch failed:', err),
    );
  }

  if (!flowResult.consumed && event.contentType === 'text' && contentText.trim()) {
    await dispatchInboundToAiReply({
      accountId: event.accountId,
      conversationId: conversation.id,
      contactId: contactOutcome.contact.id,
      configOwnerUserId: config.user_id,
    });
  }

  await dispatchWebhookEvent(supabaseAdmin(), event.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactOutcome.contact.id,
    whatsapp_message_id: event.messageId,
    content_type: event.contentType,
    text: contentText,
  });

  return {
    ok: true,
    stored: true,
    conversationId: conversation.id,
    messageId: inserted.id,
  };
}
