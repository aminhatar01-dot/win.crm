-- Allow the QR worker to report the real post-scan Baileys state.
-- The worker must not mark a session as connected until Baileys emits
-- connection: "open"; "connecting" represents the scanned/in-progress state.

ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_qr_status_check,
  ADD CONSTRAINT whatsapp_config_qr_status_check
    CHECK (qr_status IN ('disconnected', 'waiting_qr', 'connecting', 'connected', 'error'));
