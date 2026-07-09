import { afterEach, describe, expect, it, vi } from 'vitest'

const VALID_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

async function importEncryption() {
  vi.resetModules()
  return import('./encryption')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('encryption key environment resolution', () => {
  it('prefers WHATSAPP_TOKEN_ENCRYPTION_KEY over a legacy ENCRYPTION_KEY value', async () => {
    vi.stubEnv('WHATSAPP_TOKEN_ENCRYPTION_KEY', VALID_KEY)
    vi.stubEnv('ENCRYPTION_KEY', 'your-64-char-hex-key-here')

    const { decrypt, encrypt } = await importEncryption()

    expect(decrypt(encrypt('secret'))).toBe('secret')
  })

  it('trims accidental whitespace and wrapping quotes before decoding hex', async () => {
    vi.stubEnv('WHATSAPP_TOKEN_ENCRYPTION_KEY', `  "${VALID_KEY}"\n`)
    vi.stubEnv('ENCRYPTION_KEY', '')

    const { decrypt, encrypt } = await importEncryption()

    expect(decrypt(encrypt('secret'))).toBe('secret')
  })

  it('throws a clear error before crypto receives an invalid key', async () => {
    vi.stubEnv('WHATSAPP_TOKEN_ENCRYPTION_KEY', '')
    vi.stubEnv('ENCRYPTION_KEY', 'not-a-valid-key')

    await expect(importEncryption()).rejects.toThrow(
      /Invalid ENCRYPTION_KEY: expected 64 hex characters \(32 bytes\).*keyLength=15, bufferLength=0/,
    )
  })
})
