# CODEX.MD - Contexto operativo

Proyecto: WIN.AI, CRM WhatsApp + agentes IA.

Rama actual obligatoria: `modificaciones1`.

## Mapa rapido

- `src/app/(dashboard)` paginas protegidas.
- `src/components/settings/ai-config.tsx` configuracion del agente.
- `src/components/agents/ai-playground.tsx` playground.
- `src/components/inbox/message-composer.tsx` boton para generar respuesta IA.
- `src/app/api/ai/*` rutas server-side de IA.
- `src/lib/ai/*` providers, prompt, knowledge, auto-reply y uso.
- `src/app/api/whatsapp/qr/*` rutas del conector QR experimental.
- `src/lib/whatsapp/providers/*` capa de proveedores WhatsApp.
- `supabase/migrations/029_ai_reply.sql` base IA inicial.
- `supabase/migrations/030_ai_knowledge.sql` knowledge base.
- `supabase/migrations/033_ai_reply_polish.sql` logs y handoff.
- `supabase/migrations/036_win_ai_agent_config.sql` campos WIN.AI agregados.
- `supabase/migrations/037_whatsapp_qr_provider.sql` seleccion de proveedor WhatsApp y estado QR.
- `supabase/migrations/039_whatsapp_qr_connecting_status.sql` permite persistir el estado QR post-scan `connecting`.

## Decisiones

- No se creo `ai_agents`: `ai_configs` ya cumple la funcion por cuenta/tenant.
- `OPENAI_API_KEY` es fallback server-managed. Si una cuenta guarda su propia clave cifrada, esa clave se usa para esa cuenta.
- `OPENAI_BASE_URL` solo se usa en OpenAI y nunca se expone al frontend.
- Temperatura limitada a `0..1`.
- WhatsApp oficial sigue siendo `official_cloud_api`; QR es `qr_session` y requiere worker Node persistente con `WHATSAPP_QR_WORKER_URL` y `WHATSAPP_QR_WORKER_SECRET`.
- No guardar sesiones QR en memoria de Next/Vercel. Usar worker dedicado con Baileys u otra libreria mantenida y storage durable por tenant.
- Worker incluido: `workers/whatsapp-qr-worker`. Comandos: `npm install`, `npm run dev`, `npm run build`, `npm start`.
- El worker QR debe reutilizar sockets existentes por `sessionId`; `/qr` y `/status` no deben crear ni reiniciar sockets. Solo marcar `connected` cuando Baileys emite `connection: "open"`.

## Antes de editar

1. `git status --short --branch`.
2. Escaneo de secretos sin imprimir valores.
3. Revisar si la funcionalidad ya existe.
4. Cambios incrementales y documentados.
