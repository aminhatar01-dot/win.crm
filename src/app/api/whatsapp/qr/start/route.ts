import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { ensureQrConfig, updateQrConfigFromWorker } from '@/lib/whatsapp/providers/qr-config';
import { qrErrorResponse } from '@/lib/whatsapp/providers/qr-api';
import { startQrSession } from '@/lib/whatsapp/providers/qr-worker-client';

export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`whatsapp-qr-start:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    await ensureQrConfig(supabase, accountId, userId);
    const result = await startQrSession(accountId);
    await updateQrConfigFromWorker(supabase, accountId, result);

    return NextResponse.json({
      status: result.status,
      qr: result.qr ?? null,
      qr_data_url: result.qrDataUrl ?? null,
      expires_at: result.expiresAt ?? null,
      warning:
        'La conexión por QR es experimental y puede desconectarse. Para producción estable se recomienda WhatsApp Cloud API oficial.',
    });
  } catch (err) {
    return qrErrorResponse(err);
  }
}
