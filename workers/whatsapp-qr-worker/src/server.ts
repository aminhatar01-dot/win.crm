import express, { type Request, type Response } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { verifyHmac, type RawBodyRequest } from './security.js';
import { SessionManager } from './sessions.js';

const app = express();
const sessions = new SessionManager();

app.use(
  express.json({
    limit: '1mb',
    verify: (req: RawBodyRequest, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }),
);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use(verifyHmac);

function routeError(res: Response, err: unknown) {
  const status = sessions.statusCode(err);
  const message = err instanceof Error ? err.message : 'QR worker request failed.';
  return res.status(status).json({
    error: message,
    code: status === 400 ? 'bad_request' : 'qr_worker_error',
  });
}

app.post('/sessions/start', async (req: Request, res: Response) => {
  try {
    const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : '';
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    if (!accountId || !sessionId) {
      return res.status(400).json({
        error: 'accountId and sessionId are required.',
        code: 'bad_request',
      });
    }
    const result = await sessions.start(accountId, sessionId);
    return res.json(result);
  } catch (err) {
    return routeError(res, err);
  }
});

app.get('/sessions/:sessionId/qr', async (req, res) => {
  try {
    return res.json(await sessions.qr(req.params.sessionId));
  } catch (err) {
    return routeError(res, err);
  }
});

app.get('/sessions/:sessionId/status', async (req, res) => {
  try {
    return res.json(await sessions.status(req.params.sessionId));
  } catch (err) {
    return routeError(res, err);
  }
});

app.delete('/sessions/:sessionId', async (req, res) => {
  try {
    return res.json(await sessions.disconnect(req.params.sessionId));
  } catch (err) {
    return routeError(res, err);
  }
});

app.post('/sessions/:sessionId/send', async (req, res) => {
  try {
    const result = await sessions.send(req.params.sessionId, {
      to: typeof req.body?.to === 'string' ? req.body.to : '',
      kind: typeof req.body?.kind === 'string' ? req.body.kind : 'text',
      text: typeof req.body?.text === 'string' ? req.body.text : null,
      mediaUrl:
        typeof req.body?.mediaUrl === 'string'
          ? req.body.mediaUrl
          : typeof req.body?.media_url === 'string'
            ? req.body.media_url
            : null,
      filename: typeof req.body?.filename === 'string' ? req.body.filename : null,
    });
    return res.json(result);
  } catch (err) {
    return routeError(res, err);
  }
});

const server = app.listen(config.port, () => {
  logger.info(
    { port: config.port, qrDebug: config.qrDebug },
    'WIN.AI WhatsApp QR worker listening',
  );
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down QR worker');
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
