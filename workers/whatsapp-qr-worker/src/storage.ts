import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SESSION_ID_RE = /^acct_[0-9a-fA-F-]{36}$/;

export function validateSessionId(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw Object.assign(new Error('Invalid session id.'), { status: 400 });
  }
  return sessionId;
}

export interface SessionStore {
  pathFor(sessionId: string): Promise<string>;
  remove(sessionId: string): Promise<void>;
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly basePath = config.sessionStoragePath) {
    fsSync.mkdirSync(this.basePath, { recursive: true, mode: 0o700 });
  }

  async pathFor(sessionId: string): Promise<string> {
    validateSessionId(sessionId);
    const sessionPath = path.join(this.basePath, sessionId);
    await fs.mkdir(sessionPath, { recursive: true, mode: 0o700 });
    return sessionPath;
  }

  async remove(sessionId: string): Promise<void> {
    validateSessionId(sessionId);
    await fs.rm(path.join(this.basePath, sessionId), {
      recursive: true,
      force: true,
    });
  }
}
