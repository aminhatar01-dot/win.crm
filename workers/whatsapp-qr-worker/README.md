# WIN.AI WhatsApp QR Worker

Dedicated Node worker for the experimental WIN.AI `qr_session`
provider. It uses Baileys to keep a persistent WhatsApp Web socket per
account/tenant.

## Local setup

```bash
cd workers/whatsapp-qr-worker
npm install
cp .env.example .env
npm run dev
```

Required variables:

```bash
PORT=4001
WHATSAPP_QR_WORKER_SECRET=generate-a-long-random-string
WINAI_APP_URL=http://localhost:3000
SESSION_STORAGE_PATH=./.sessions
WHATSAPP_QR_DEBUG=false
```

In the main WIN.AI app, point to this worker:

```bash
WHATSAPP_QR_WORKER_URL=http://localhost:4001
WHATSAPP_QR_WORKER_SECRET=generate-a-long-random-string
```

The secret must match exactly in both processes.
`WINAI_APP_URL` must point to the main WIN.AI app so inbound Baileys
events can be delivered to `/api/whatsapp/qr/events`.

## Scripts

```bash
npm run dev
npm run typecheck
npm run build
npm start
```

## Storage

The default storage uses Baileys multi-file auth state under
`SESSION_STORAGE_PATH`, one directory per `acct_<accountId>` session.
The worker creates the base folder on startup and creates each tenant
folder before opening the Baileys socket.
For production, run this worker on a runtime with a persistent volume or
replace the storage abstraction with Redis, Supabase Storage, or another
durable backend.

Do not rely on memory-only sessions in production.

## Security

Every endpoint except `/health` requires:

- `X-WINAI-Timestamp`
- `X-WINAI-Signature`

The signature is `HMAC_SHA256(secret, timestamp + "." + rawBody)`.
Requests without a valid signature are rejected before touching any
session.

The worker never logs WhatsApp credentials, QR contents, request bodies,
or the HMAC secret.

Set `WHATSAPP_QR_DEBUG=true` only while diagnosing local/dev connection
stability. It enables the full structured Baileys connection diagnostic
line; it still does not print QR contents, credentials, tokens, auth
state, message bodies, or secrets.

## Baileys connection behavior

The worker uses `@whiskeysockets/baileys@7.0.0-rc13`, which is the
current npm `latest` release at the time this worker was built. Runtime
options are tuned for local stability:

- `browser: Browsers.macOS('Chrome')`
- `printQRInTerminal: false`
- `syncFullHistory: false`
- `markOnlineOnConnect: false`
- `connectTimeoutMs: 60000`
- `keepAliveIntervalMs: 20000`
- `retryRequestDelayMs: 500`
- `defaultQueryTimeoutMs: 60000`

Status values:

- `waiting_qr`: QR is available.
- `connecting`: QR was scanned and Baileys is completing the handshake.
- `connected`: Baileys emitted `connection: "open"`.
- `disconnected`: session is stopped.
- `error`: reconnect failed or a fresh QR is required.

With `WHATSAPP_QR_DEBUG=true`, every `connection.update` logs:

- `sessionId`
- `connection`
- `isNewLogin`
- `receivedPendingNotifications`
- `qrGenerated`
- `statusCode`
- `disconnectReason`
- `errorName`
- `errorMessage`
- `reconnectAttempts`
- `intentionalDisconnect`
- `timestamp`

Disconnect interpretation:

- `restartRequired`: expected Baileys restart; worker recreates the socket
  immediately using the same persisted auth state.
- `connectionClosed`, `connectionLost`, `timedOut`: transient transport
  failures; worker retries with backoff.
- `loggedOut`, `badSession`, `connectionReplaced`,
  `multideviceMismatch`, `forbidden`: do not reconnect in a loop; the
  worker marks the session unusable, removes persisted state when
  appropriate, and requires a fresh QR.
- `unavailableService` or `unknown`: inspect `statusCode` and
  `errorMessage`; if it repeats, generate a fresh QR after preserving the
  diagnostic log.

Expected successful logs:

```text
opening qr session socket
qr code generated/refreshed
baileys connection update connection=connecting isNewLogin=true
qr session credentials saved
baileys connection update connection=open
qr session connected
WhatsApp event received
inbound QR message parsed
inbound QR event delivered
```

If logs show `loggedOut`, `badSession`, `forbidden`, or
`connectionReplaced`, generate a fresh QR. For local development only,
you may delete the affected `SESSION_STORAGE_PATH/acct_<accountId>`
folder after stopping the worker.

## Limitations

Baileys connects through WhatsApp Web and is not the official Meta Cloud
API. Sessions can disconnect when WhatsApp Web invalidates them, when
the phone logs out, or when the runtime loses its persistent state.

Use the official Cloud API provider for stable production messaging,
templates, webhooks, broadcasts and compliance-sensitive workloads.
