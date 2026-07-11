export type QrStatus =
  | 'disconnected'
  | 'waiting_qr'
  | 'connecting'
  | 'connected'
  | 'error';

export interface WorkerQrResponse {
  status: QrStatus;
  qr?: string | null;
  qrDataUrl?: string | null;
  expiresAt?: string | null;
  lastError?: string | null;
}

export interface WorkerStatusResponse {
  status: QrStatus;
  sessionRef?: string | null;
  connectedAt?: string | null;
  lastError?: string | null;
}

export interface WorkerSendResponse {
  messageId: string;
}
