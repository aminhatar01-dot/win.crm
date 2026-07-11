-- Repair/ensure WhatsApp QR provider columns for databases that were
-- deployed before migration 037 was applied. This migration is fully
-- idempotent and safe to run after 037.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_method TEXT DEFAULT 'official_cloud_api',
  ADD COLUMN IF NOT EXISTS qr_status TEXT DEFAULT 'disconnected',
  ADD COLUMN IF NOT EXISTS qr_session_ref TEXT,
  ADD COLUMN IF NOT EXISTS qr_session_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS qr_last_error TEXT,
  ADD COLUMN IF NOT EXISTS qr_connected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_updated_at TIMESTAMPTZ;

UPDATE whatsapp_config
SET
  connection_method = COALESCE(connection_method, 'official_cloud_api'),
  qr_status = COALESCE(qr_status, 'disconnected')
WHERE connection_method IS NULL OR qr_status IS NULL;

ALTER TABLE whatsapp_config
  ALTER COLUMN connection_method SET DEFAULT 'official_cloud_api',
  ALTER COLUMN qr_status SET DEFAULT 'disconnected',
  ALTER COLUMN connection_method SET NOT NULL,
  ALTER COLUMN qr_status SET NOT NULL;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_connection_method_check,
  ADD CONSTRAINT whatsapp_config_connection_method_check
    CHECK (connection_method IN ('official_cloud_api', 'qr_session'));

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_qr_status_check,
  ADD CONSTRAINT whatsapp_config_qr_status_check
    CHECK (qr_status IN ('disconnected', 'waiting_qr', 'connected', 'error'));

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_official_fields_check,
  ADD CONSTRAINT whatsapp_config_official_fields_check
    CHECK (
      connection_method <> 'official_cloud_api'
      OR (phone_number_id IS NOT NULL AND access_token IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_connection_method
  ON whatsapp_config (connection_method);

CREATE INDEX IF NOT EXISTS idx_whatsapp_config_qr_status
  ON whatsapp_config (qr_status)
  WHERE connection_method = 'qr_session';
