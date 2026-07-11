import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { updateQrConfigFromWorker } from '@/lib/whatsapp/providers/qr-config';
import { qrErrorResponse } from '@/lib/whatsapp/providers/qr-api';
import { getQrCode } from '@/lib/whatsapp/providers/qr-worker-client';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const result = await getQrCode(accountId);
    await updateQrConfigFromWorker(supabase, accountId, result);

    return NextResponse.json({
      status: result.status,
      qr: result.qr ?? null,
      qr_data_url: result.qrDataUrl ?? null,
      expires_at: result.expiresAt ?? null,
      last_error: result.lastError ?? null,
    });
  } catch (err) {
    return qrErrorResponse(err);
  }
}
