# CLAUDE.MD - Contexto para agentes

Trabajar en la rama `modificaciones1`. La rama fue sincronizada desde `modificaciones` y subida al remoto antes de los cambios de WIN.AI.

## Reglas

- No trabajar sobre `main` salvo pedido explicito.
- No imprimir ni copiar secretos reales.
- `.env.local` esta ignorado; usar `.env.local.example` como plantilla segura.
- Mantener llamadas IA en backend.
- Respetar `account_id`, roles y RLS.
- No duplicar tablas si ya existe estructura equivalente.

## Cambios importantes

- Branding visible actualizado a `WIN.AI`.
- La IA ya existia en `ai_configs`, `/api/ai/draft`, `/api/ai/playground`, auto-reply, knowledge base y `ai_usage_log`.
- Se extendio `ai_configs` con campos profesionales de agente mediante `036_win_ai_agent_config.sql`.
- Se agrego soporte a `OPENAI_API_KEY`, `OPENAI_MODEL` y `OPENAI_BASE_URL` server-side.
- WhatsApp ahora tiene selector de proveedor por cuenta: `official_cloud_api` conserva la integracion Meta existente y `qr_session` agrega conexion QR experimental.
- QR usa endpoints `src/app/api/whatsapp/qr/*` y cliente de worker en `src/lib/whatsapp/providers/*`; requiere `WHATSAPP_QR_WORKER_URL` y `WHATSAPP_QR_WORKER_SECRET`.
- No intentar mantener sesiones QR/Baileys dentro de Next serverless. Usar worker Node dedicado con storage durable por tenant; ver `docs/whatsapp-qr.md`.
- Worker real incluido en `workers/whatsapp-qr-worker` con Express, Baileys, HMAC y storage filesystem configurable por `SESSION_STORAGE_PATH`.
- Estado QR `connecting` significa QR escaneado/handshake en curso; no tratarlo como conectado. Solo `connection: "open"` de Baileys equivale a `connected`.

## Validacion esperada

Ejecutar `npm run lint`, `npm run typecheck`, `npm run build` y levantar `npm run dev` para smoke test de login, dashboard, agents, inbox y draft IA.
