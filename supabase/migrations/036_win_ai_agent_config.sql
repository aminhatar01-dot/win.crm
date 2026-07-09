-- ============================================================
-- 036_win_ai_agent_config.sql - WIN.AI configurable agent fields
--
-- Extends the existing account-scoped AI assistant (`ai_configs`) rather
-- than creating a duplicate `ai_agents` table. This preserves the current
-- tenant/RLS architecture:
--   - one active assistant configuration per account;
--   - admin+ can create/update/delete;
--   - members can read only their own account configuration;
--   - API keys remain encrypted or supplied by server env vars.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'WIN.AI Assistant',
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS tone text NOT NULL DEFAULT 'profesional y claro',
  ADD COLUMN IF NOT EXISTS primary_language text NOT NULL DEFAULT 'es',
  ADD COLUMN IF NOT EXISTS business_instructions text,
  ADD COLUMN IF NOT EXISTS safety_rules text,
  ADD COLUMN IF NOT EXISTS temperature numeric NOT NULL DEFAULT 0.3
    CHECK (temperature >= 0 AND temperature <= 1);

ALTER TABLE ai_configs
  ALTER COLUMN api_key DROP NOT NULL;
