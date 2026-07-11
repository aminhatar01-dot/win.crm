# WIN.AI

WIN.AI es un CRM multiusuario para WhatsApp con inbox compartido, contactos, pipelines, broadcasts, automatizaciones, flujos conversacionales y agentes IA reales sobre Next.js 16, Supabase y Meta WhatsApp Cloud API.

## Estado de la rama

- Rama de trabajo: `modificaciones1`.
- Base sincronizada desde `modificaciones` el 2026-07-09.
- No trabajar sobre `main` salvo instruccion explicita.
- `.env.local` no esta versionado; solo se versionan ejemplos seguros.

## Arquitectura

- App: Next.js App Router, React 19, TypeScript, Tailwind v4.
- Auth y datos: Supabase Auth, Postgres, Storage y RLS.
- Tenancy: casi todo se aisla por `account_id`; los helpers de auth validan cuenta y rol.
- WhatsApp: Meta Cloud API oficial, webhooks HMAC, envio server-side; opcion QR experimental mediante worker Node dedicado.
- IA: rutas backend bajo `/api/ai/*`, configuracion por cuenta en `ai_configs`, knowledge base en `ai_knowledge_*`, logs en `ai_usage_log`.

## IA en WIN.AI

El repo ya incluia antes de esta intervencion:

- Configuracion por cuenta para OpenAI/Anthropic con claves cifradas.
- Borrador IA desde inbox mediante `/api/ai/draft`.
- Auto-reply opcional para conversaciones entrantes.
- Knowledge base con busqueda full-text y pgvector opcional.
- Rate limiting basico para draft/playground/auto-reply.
- Registro de uso en `ai_usage_log`.
- RLS y validacion de pertenencia a cuenta.

En esta rama se agrego:

- Branding visible `WIN.AI`.
- Soporte backend para `OPENAI_API_KEY`, `OPENAI_MODEL` y `OPENAI_BASE_URL`.
- Campos configurables del agente sobre `ai_configs`: nombre, descripcion, tono, idioma principal, instrucciones de negocio, reglas anti-alucinacion y temperatura.
- Migracion `supabase/migrations/036_win_ai_agent_config.sql`.
- UI de Agentes actualizada para editar esos campos.

No se creo una tabla `ai_agents` separada porque `ai_configs` ya era la estructura equivalente, account-scoped y protegida por RLS. Crear otra tabla duplicaria el modelo y aumentaria riesgo de inconsistencias.

## Variables de entorno

Copiar `.env.local.example` a `.env.local` y completar:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
WHATSAPP_TOKEN_ENCRYPTION_KEY=
META_APP_SECRET=
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
# OPENAI_BASE_URL=https://api.openai.com/v1
# WHATSAPP_QR_WORKER_URL=https://your-qr-worker.example.com
# WHATSAPP_QR_WORKER_SECRET=
```

`OPENAI_API_KEY` es opcional si cada cuenta guarda su propia clave en Agentes -> Configuracion. Nunca exponer claves privadas con prefijo `NEXT_PUBLIC_`.

## WhatsApp: oficial vs QR

- `official_cloud_api`: metodo oficial de Meta. Recomendado para produccion estable, templates, webhooks, broadcasts y automatizaciones completas.
- `qr_session`: conexion por QR experimental/no oficial para pruebas rapidas. Puede desconectarse y requiere un worker Node persistente, no una funcion serverless.

El selector esta en Settings -> WhatsApp. El metodo elegido se guarda por cuenta en `whatsapp_config.connection_method`; la integracion oficial existente no se reemplaza.
El estado QR puede ser `waiting_qr`, `connecting`, `connected`, `disconnected` o `error`; WIN.AI solo muestra conectado cuando Baileys confirma `connection: "open"`.

Para QR configurar:

```bash
WHATSAPP_QR_WORKER_URL=
WHATSAPP_QR_WORKER_SECRET=
```

Ver detalles del contrato y limitaciones en `docs/whatsapp-qr.md`.

Worker QR local:

```bash
cd workers/whatsapp-qr-worker
npm install
cp .env.example .env
npm run dev
```

La app principal debe apuntar a ese worker con el mismo secreto:

```bash
WHATSAPP_QR_WORKER_URL=http://localhost:4001
WHATSAPP_QR_WORKER_SECRET=generate-a-long-random-string
```

En `workers/whatsapp-qr-worker/.env` configurar tambien:

```bash
WINAI_APP_URL=http://localhost:3000
```

Sin `WINAI_APP_URL`, el QR puede conectar y enviar, pero los mensajes
entrantes de Baileys no llegan al Inbox.

Si el worker informa `loggedOut`, `badSession`, `forbidden` o `connectionReplaced`, detener el worker y borrar solo la carpeta de esa cuenta dentro de `SESSION_STORAGE_PATH` antes de generar un QR nuevo.

## Desarrollo local

```bash
npm install
npm run lint
npm run typecheck
npm run build
npm run dev
```

Luego validar manualmente login, dashboard, agentes, inbox y generacion IA.

## Supabase

Aplicar migraciones en orden desde `supabase/migrations`. Para esta rama, la nueva migracion relevante es:

```text
036_win_ai_agent_config.sql
037_whatsapp_qr_provider.sql
```

No modificar RLS, service role ni permisos sin justificarlo en README, CODEX.MD y CLAUDE.MD.

## Seguridad

- No versionar `.env.local`, claves reales, tokens ni certificados.
- Las llamadas IA deben permanecer en backend/API routes.
- No enviar mensajes reales por WhatsApp si la integracion Meta no esta configurada y validada.
- Los errores hacia cliente no deben incluir secretos.
- Mantener aislamiento por cuenta antes de leer conversaciones, contactos, pipelines o knowledge base.
