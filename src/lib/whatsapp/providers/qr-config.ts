import type { SupabaseClient } from '@supabase/supabase-js';

import { encrypt } from '@/lib/whatsapp/encryption';
import type { QrConnectionStatus, QrWorkerQr, QrWorkerStatus } from './types';
import { qrSessionId } from './qr-worker-client';

export interface QrConfigView {
  connection_method: 'qr_session';
  qr_status: QrConnectionStatus;
  qr_session_ref: string;
  qr_last_error: string | null;
  qr_connected_at: string | null;
  qr_updated_at: string | null;
}

export class QrSchemaError extends Error {
  readonly status = 409;
  readonly code = 'migration_required';

  constructor() {
    super(
      'WhatsApp QR schema is not migrated. Apply Supabase migrations 037 and 038, then retry.',
    );
    this.name = 'QrSchemaError';
  }
}

function isMissingColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as { code?: string; message?: string; details?: string };
  const text = `${err.message ?? ''} ${err.details ?? ''}`.toLowerCase();
  return (
    err.code === '42703' ||
    err.code === 'PGRST204' ||
    text.includes('connection_method') ||
    text.includes('qr_status') ||
    (text.includes('column') && text.includes('does not exist'))
  );
}

function throwIfMissingQrSchema(error: unknown): void {
  if (isMissingColumnError(error)) throw new QrSchemaError();
}

export function toQrStatus(value: unknown): QrConnectionStatus {
  if (
    value === 'waiting_qr' ||
    value === 'connecting' ||
    value === 'connected' ||
    value === 'error' ||
    value === 'disconnected'
  ) {
    return value;
  }
  return 'disconnected';
}

export async function ensureQrConfig(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<QrConfigView> {
  const sessionRef = qrSessionId(accountId);
  const now = new Date().toISOString();
  const { data: existing, error: readError } = await db
    .from('whatsapp_config')
    .select(
      'id, connection_method, qr_status, qr_session_ref, qr_last_error, qr_connected_at, qr_updated_at',
    )
    .eq('account_id', accountId)
    .maybeSingle();

  if (readError) {
    throwIfMissingQrSchema(readError);
    throw readError;
  }

  if (existing) {
    const patch = {
      connection_method: 'qr_session',
      qr_session_ref: sessionRef,
      qr_updated_at: now,
    };
    const { data, error } = await db
      .from('whatsapp_config')
      .update(patch)
      .eq('id', existing.id)
      .select(
        'connection_method, qr_status, qr_session_ref, qr_last_error, qr_connected_at, qr_updated_at',
      )
      .single();
    if (error) {
      throwIfMissingQrSchema(error);
      throw error;
    }
    return {
      connection_method: 'qr_session',
      qr_status: toQrStatus(data.qr_status),
      qr_session_ref: data.qr_session_ref ?? sessionRef,
      qr_last_error: data.qr_last_error ?? null,
      qr_connected_at: data.qr_connected_at ?? null,
      qr_updated_at: data.qr_updated_at ?? now,
    };
  }

  const { data, error } = await db
    .from('whatsapp_config')
    .insert({
      account_id: accountId,
      user_id: userId,
      connection_method: 'qr_session',
      status: 'disconnected',
      qr_status: 'disconnected',
      qr_session_ref: sessionRef,
      qr_updated_at: now,
    })
    .select(
      'connection_method, qr_status, qr_session_ref, qr_last_error, qr_connected_at, qr_updated_at',
    )
    .single();
  if (error) {
    throwIfMissingQrSchema(error);
    throw error;
  }
  return {
    connection_method: 'qr_session',
    qr_status: toQrStatus(data.qr_status),
    qr_session_ref: data.qr_session_ref ?? sessionRef,
    qr_last_error: data.qr_last_error ?? null,
    qr_connected_at: data.qr_connected_at ?? null,
    qr_updated_at: data.qr_updated_at ?? now,
  };
}

export async function updateQrConfigFromWorker(
  db: SupabaseClient,
  accountId: string,
  result: QrWorkerStatus | QrWorkerQr,
): Promise<void> {
  const status = toQrStatus(result.status);
  const now = new Date().toISOString();
  const sessionRef =
    'sessionRef' in result && result.sessionRef
      ? result.sessionRef
      : qrSessionId(accountId);
  const sessionCiphertext = sessionRef ? encrypt(sessionRef) : null;
  const connectedAt =
    status === 'connected'
      ? ('connectedAt' in result && result.connectedAt
          ? result.connectedAt
          : now)
      : null;

  const { error } = await db
    .from('whatsapp_config')
    .update({
      connection_method: 'qr_session',
      status: status === 'connected' ? 'connected' : 'disconnected',
      qr_status: status,
      qr_session_ref: sessionRef,
      qr_session_ciphertext: sessionCiphertext,
      qr_last_error: result.lastError ?? null,
      qr_connected_at: connectedAt,
      qr_updated_at: now,
    })
    .eq('account_id', accountId);

  if (error) {
    throwIfMissingQrSchema(error);
    throw error;
  }
}
