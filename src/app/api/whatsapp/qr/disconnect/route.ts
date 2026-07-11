import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { updateQrConfigFromWorker } from '@/lib/whatsapp/providers/qr-config';
import { qrErrorResponse } from '@/lib/whatsapp/providers/qr-api';
import { disconnectQrSession } from '@/lib/whatsapp/providers/qr-worker-client';

export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`whatsapp-qr-disconnect:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const result = await disconnectQrSession(accountId);
    await updateQrConfigFromWorker(supabase, accountId, result);

    return NextResponse.json({
      status: result.status,
      connected_at: result.connectedAt ?? null,
      last_error: result.lastError ?? null,
    });
  } catch (err) {
    return qrErrorResponse(err);
  }
}
