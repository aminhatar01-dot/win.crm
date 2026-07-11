import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 4001),
  workerSecret: required('WHATSAPP_QR_WORKER_SECRET'),
  appUrl: (
    process.env.WINAI_APP_URL ||
    process.env.WHATSAPP_QR_APP_URL ||
    ''
  ).trim().replace(/\/$/, ''),
  sessionStoragePath: path.resolve(
    workerRoot,
    process.env.SESSION_STORAGE_PATH || './.sessions',
  ),
  hmacMaxSkewMs: Number(process.env.HMAC_MAX_SKEW_MS || 300000),
  allowHistoryInbox: process.env.WHATSAPP_QR_ALLOW_HISTORY_INBOX === 'true',
  historyGraceMs: Number(process.env.WHATSAPP_QR_HISTORY_GRACE_MS || 120000),
  qrDebug: process.env.WHATSAPP_QR_DEBUG === 'true',
};
