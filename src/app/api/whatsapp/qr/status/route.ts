import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { updateQrConfigFromWorker } from '@/lib/whatsapp/providers/qr-config';
import { qrErrorResponse } from '@/lib/whatsapp/providers/qr-api';
import { getQrStatus } from '@/lib/whatsapp/providers/qr-worker-client';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const result = await getQrStatus(accountId);
    await updateQrConfigFromWorker(supabase, accountId, result);

    return NextResponse.json({
      status: result.status,
      session_ref: result.sessionRef ?? null,
      connected_at: result.connectedAt ?? null,
      last_error: result.lastError ?? null,
    });
  } catch (err) {
    return qrErrorResponse(err);
  }
}
