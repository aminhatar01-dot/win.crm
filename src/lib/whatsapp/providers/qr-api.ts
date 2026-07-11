import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { QrSchemaError } from './qr-config';
import { QrWorkerError } from './qr-worker-client';

export function qrErrorResponse(err: unknown) {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return toErrorResponse(err);
  }
  if (err instanceof QrWorkerError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status },
    );
  }
  if (err instanceof QrSchemaError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status },
    );
  }
  console.error('[whatsapp/qr] unexpected error:', err);
  return NextResponse.json(
    { error: 'QR connector request failed.' },
    { status: 500 },
  );
}
