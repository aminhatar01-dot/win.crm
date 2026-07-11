export const WHATSAPP_CONNECTION_METHODS = [
  'official_cloud_api',
  'qr_session',
] as const;

export type WhatsAppConnectionMethod =
  (typeof WHATSAPP_CONNECTION_METHODS)[number];

export const QR_STATUSES = [
  'disconnected',
  'waiting_qr',
  'connecting',
  'connected',
  'error',
] as const;

export type QrConnectionStatus = (typeof QR_STATUSES)[number];

export function isWhatsAppConnectionMethod(
  value: unknown,
): value is WhatsAppConnectionMethod {
  return (
    typeof value === 'string' &&
    (WHATSAPP_CONNECTION_METHODS as readonly string[]).includes(value)
  );
}

export interface QrWorkerStatus {
  status: QrConnectionStatus;
  sessionRef?: string | null;
  connectedAt?: string | null;
  lastError?: string | null;
}

export interface QrWorkerQr {
  status: QrConnectionStatus;
  qr?: string | null;
  qrDataUrl?: string | null;
  expiresAt?: string | null;
  lastError?: string | null;
}

export interface QrSendResult {
  messageId: string;
}
