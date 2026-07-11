import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { qrErrorResponse } from '@/lib/whatsapp/providers/qr-api';
import { sendQrMessage } from '@/lib/whatsapp/providers/qr-worker-client';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';

const QR_SEND_KINDS = ['text', 'image', 'video', 'document', 'audio'] as const;

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`whatsapp-qr-send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const to = typeof body?.to === 'string' ? sanitizePhoneForMeta(body.to) : '';
    const kind = typeof body?.kind === 'string' ? body.kind : 'text';
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const mediaUrl = typeof body?.media_url === 'string' ? body.media_url.trim() : '';
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : '';

    if (!isValidE164(to)) {
      return NextResponse.json(
        { error: 'A valid E.164 recipient phone number is required.' },
        { status: 400 },
      );
    }
    if (!(QR_SEND_KINDS as readonly string[]).includes(kind)) {
      return NextResponse.json(
        { error: `Unsupported QR message kind "${kind}".` },
        { status: 400 },
      );
    }
    if (kind === 'text' && !text) {
      return NextResponse.json(
        { error: 'text is required for QR text messages.' },
        { status: 400 },
      );
    }
    if (kind !== 'text' && !mediaUrl) {
      return NextResponse.json(
        { error: 'media_url is required for QR media messages.' },
        { status: 400 },
      );
    }

    const result = await sendQrMessage({
      accountId,
      to,
      kind,
      text,
      mediaUrl,
      filename,
    });

    return NextResponse.json({
      success: true,
      whatsapp_message_id: result.messageId,
    });
  } catch (err) {
    return qrErrorResponse(err);
  }
}
