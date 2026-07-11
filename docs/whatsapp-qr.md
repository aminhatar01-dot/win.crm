# WhatsApp QR connector

WIN.AI supports two WhatsApp providers per account:

- `official_cloud_api`: Meta WhatsApp Cloud API. This is the production
  method and keeps the existing webhook, template, media, broadcast,
  flow and inbox behavior.
- `qr_session`: experimental WhatsApp Web session through a dedicated
  Node worker. This is for quick tests and simple connections. It is
  not an official Meta API and can disconnect.

## Runtime model

The QR provider is intentionally not hosted inside Next.js route
handlers. WhatsApp Web libraries such as `@whiskeysockets/baileys`
maintain long-lived WebSocket state and auth credentials. Vercel and
other serverless runtimes can suspend or recreate functions, which
breaks QR sessions and loses in-memory state.

Recommended production shape:

- WIN.AI Next.js app on Vercel/Hostinger/etc.
- Separate persistent Node worker on Railway, Render, Fly.io, a VPS, or
  another long-running runtime.
- Worker uses Baileys or another maintained WhatsApp Web library.
- The included worker uses filesystem auth state under
  `SESSION_STORAGE_PATH`.
- For production, store per-account auth state in durable storage, for
  example Redis, Supabase Storage, or encrypted files on a persistent
  volume.
- WIN.AI calls the worker through HTTPS with
  `WHATSAPP_QR_WORKER_SECRET` HMAC signatures.

Do not store QR sessions only in memory except for local experiments.

## Worker implementation in this repo

The dedicated worker lives in:

```text
workers/whatsapp-qr-worker
```

Run it locally:

```bash
cd workers/whatsapp-qr-worker
npm install
cp .env.example .env
npm run dev
```

Build and start:

```bash
npm run build
npm start
```

The main app must use the same secret:

```bash
WHATSAPP_QR_WORKER_URL=http://localhost:4001
WHATSAPP_QR_WORKER_SECRET=generate-a-long-random-string
```

Worker variables:

```bash
PORT=4001
WHATSAPP_QR_WORKER_SECRET=generate-a-long-random-string
WINAI_APP_URL=http://localhost:3000
SESSION_STORAGE_PATH=./.sessions
WHATSAPP_QR_DEBUG=false
```

`WINAI_APP_URL` is required for inbound messages. The worker posts
Baileys events to `WINAI_APP_URL/api/whatsapp/qr/events` using the same
HMAC secret. Without this variable, QR can connect and send, but
incoming WhatsApp Web messages cannot reach WIN.AI.

## Worker contract

WIN.AI sends these signed requests to `WHATSAPP_QR_WORKER_URL`:

- `POST /sessions/start`
  Body: `{ "accountId": "...", "sessionId": "acct_..." }`
  Response: `{ "status": "waiting_qr", "qrDataUrl": "...", "expiresAt": "..." }`
  Reuses the existing socket when the session is already `waiting_qr`,
  `connecting`, or `connected`; it must not create a second socket for
  the same tenant.

- `GET /sessions/:sessionId/qr`
  Response: `{ "status": "waiting_qr", "qrDataUrl": "...", "expiresAt": "..." }`

- `GET /sessions/:sessionId/status`
  Response: `{ "status": "connected", "sessionRef": "acct_...", "connectedAt": "..." }`

- `DELETE /sessions/:sessionId`
  Response: `{ "status": "disconnected" }`

- `POST /sessions/:sessionId/send`
  Body: `{ "to": "+549...", "kind": "text", "text": "Hola" }`
  Response: `{ "messageId": "..." }`

Inbound event callback from worker to app:

- `POST /api/whatsapp/qr/events`
  Body: signed worker event with `accountId`, `sessionId`, `messageId`,
  `from`, `timestamp`, `contentType`, and optional `contentText`.
  The app verifies the session/account, creates contact/conversation
  rows, stores the message, updates unread/preview fields, and Supabase
  realtime updates the Inbox.

Every request between app and worker includes:

- `X-WINAI-Timestamp`
- `X-WINAI-Signature = HMAC_SHA256(secret, timestamp + "." + rawBody)`

The worker must reject unsigned, stale, or mismatched signatures.

Valid status values:

- `waiting_qr`: QR is available and waiting to be scanned.
- `connecting`: WhatsApp scanned the QR and Baileys is completing the
  handshake. WIN.AI must not treat this as connected yet.
- `connected`: Baileys emitted `connection: "open"`.
- `disconnected`: no active socket/session.
- `error`: the worker could not reconnect or needs a fresh QR.

## Database

Migration `037_whatsapp_qr_provider.sql` extends `whatsapp_config`
instead of creating a duplicate table. The row remains scoped by
`account_id` and protected by the existing RLS policies.

New fields include:

- `connection_method`
- `qr_status`
- `qr_session_ref`
- `qr_session_ciphertext`
- `qr_last_error`
- `qr_connected_at`
- `qr_updated_at`

Cloud API credentials remain in the existing columns and are still
encrypted with `WHATSAPP_TOKEN_ENCRYPTION_KEY`.

Migration `039_whatsapp_qr_connecting_status.sql` allows the QR worker
to persist the real post-scan `connecting` state without marking the
session as connected prematurely.

## Connection diagnostics

Set `WHATSAPP_QR_DEBUG=true` in the worker environment when diagnosing
QR stability. The worker logs safe connection lifecycle fields only:

- Baileys connection update: `sessionId`, `connection`, `isNewLogin`,
  `receivedPendingNotifications`, `qrGenerated`, `statusCode`,
  `disconnectReason`, `errorName`, `errorMessage`, `reconnectAttempts`,
  `intentionalDisconnect`, `timestamp`.
- QR generated/refreshed count and expiration timestamp, never the QR
  content.
- Credential save events, never auth state or tokens.
- Socket close reason and reconnect attempts.

Expected successful sequence:

```text
opening qr session socket
baileys connection update connection=connecting
qr code generated/refreshed
baileys connection update qrGenerated=true
baileys connection update connection=connecting isNewLogin=true
qr session credentials saved
baileys connection update connection=open receivedPendingNotifications=true
qr session connected
WhatsApp event received
inbound QR message parsed
inbound QR event delivered
```

Disconnect interpretation and action:

- `restartRequired`: Baileys asked for a restart. The worker should
  recreate the socket with the same persisted session; no new QR is
  normally required.
- `connectionClosed`: socket closed without logout. Retry with backoff.
- `connectionLost`: network/WebSocket loss. Retry with backoff.
- `timedOut`: handshake or socket timeout. Retry with backoff.
- `loggedOut`: WhatsApp invalidated the session. Stop reconnecting and
  scan a fresh QR.
- `badSession`: stored auth state is unusable. Stop reconnecting, remove
  the session folder for that account, and scan a fresh QR.
- `connectionReplaced`: another WhatsApp Web session replaced this one.
  Stop reconnecting and scan a fresh QR from the intended device.
- `multideviceMismatch`: auth state is incompatible with the device mode.
  Stop reconnecting, clear the stored session, and scan again.
- `forbidden`: WhatsApp rejected the session. Stop reconnecting and scan
  a fresh QR.
- `unavailableService`: WhatsApp service-side availability issue. Keep the
  diagnostic log; if repeated, wait and retry manually or scan fresh QR.
- `unknown`: no mappable Baileys status code was available. Use
  `errorName`, `errorMessage`, and the preceding event sequence to decide
  whether to retry or scan a fresh QR.

Expected app-side inbound logs:

```text
[qr-events] WhatsApp event received
[qr-events] Contact resolved
[qr-events] Conversation found
[qr-events] Message stored
[qr-events] Inbox updated
[qr-events] Frontend notified
```

If the worker logs `loggedOut`, `badSession`, `forbidden`, or
`connectionReplaced`, it removes the stored session and requires a new
QR scan. For a stubborn local test after those reasons, stop the worker
and delete `workers/whatsapp-qr-worker/.sessions/acct_<accountId>` or
the configured `SESSION_STORAGE_PATH` folder for that account, then
generate a fresh QR.

## Limitations

- QR mode is experimental and unofficial.
- QR mode supports text and media sends through the worker contract.
- Meta templates and interactive Cloud API payloads require
  `official_cloud_api`.
- Inbound QR message ingestion is delivered by the worker to the signed
  `/api/whatsapp/qr/events` endpoint. The existing Meta webhook remains
  unchanged for Cloud API.
- Use Cloud API for production stability, compliance, templates,
  webhooks and supportability.
