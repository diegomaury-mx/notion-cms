# 06 · Auto-publicación (Notion → rebuild sin push)

Fuente: `reference-code/notion-deploy-relay.worker.js`.

## El problema

Todo el contenido se resuelve en build (ver [01](01-architecture.md)). Un cambio hecho **solo en Notion** —corregir una cifra, reemplazar una foto, editar el copy del hero— no se ve en el sitio hasta que alguien dispara un rebuild. Antes de agosto 2026 eso era manual (pedir un push trivial, o correr un workflow a mano).

## La solución

Un Cloudflare Worker, **`notion-deploy-relay`**, desplegado en la cuenta `Diegoraul.maury@gmail.com's Account`, en `https://notion-deploy-relay.diegoraul-maury.workers.dev`.

```mermaid
sequenceDiagram
  participant D as Diego (edita Notion)
  participant N as Notion (webhooks nativos)
  participant W as Worker notion-deploy-relay
  participant KV as RELAY_KV
  participant P as Cloudflare Pages (Deploy Hook)
  participant CI as astro build

  Note over N,W: Alta de la suscripción (una vez)
  N->>W: POST { verification_token }
  W->>KV: put("verification_token", …)
  W-->>N: 200 OK
  Note over D: Diego copia el token a la config de la integración

  Note over D,CI: Operación normal
  D->>N: cambia una propiedad / bloque
  N->>W: POST evento + header X-Notion-Signature
  W->>W: hmacSha256Hex(NOTION_WEBHOOK_SECRET, rawBody)
  alt firma inválida
    W-->>N: 401 Invalid signature
  else firma válida
    W->>P: POST DEPLOY_HOOK_URL
    P->>CI: rebuild (trae lo último de Notion)
    W-->>N: 200 OK
  end
```

### Qué hace el Worker, paso a paso

1. Rechaza todo lo que no sea `POST` (405).
2. Si el body trae `verification_token` (handshake inicial de Notion): lo guarda en KV y responde 200. Sin firma todavía.
3. Si no hay header `X-Notion-Signature`: 400.
4. Si `NOTION_WEBHOOK_SECRET` no está configurado: 503.
5. Calcula `HMAC-SHA256(secret, rawBody)` con `crypto.subtle` y compara `"sha256=" + hex` contra el header. No coincide → 401.
6. Firma válida → `fetch(DEPLOY_HOOK_URL, { method: "POST" })` → 200.

**Una sola llamada al Deploy Hook por request.** No hay loop ni doble llamada (confirmado en el código).

## Suscripción de Notion

La suscripción de webhooks de Notion es **por integración**: cubre todas las fuentes compartidas con ella (SSOT casos, CMS Imágenes, Copy Oficial, Testimonios **y** la base de eventos). `Métricas oficiales` dispara un build, pero el espejo `metrics.json` requiere sincronizarse y hacer push aparte.

### Debounce de la base de eventos

La base de eventos la editan automatizaciones (Make, un agente) en ráfagas: decenas de eventos por minuto. Disparar un build por evento saturaba la cola de Cloudflare Pages. El Worker ahora:

1. Identifica si el evento viene de la base de eventos (`EVENTS_PARENT_IDS` contra `data_source_id`/`database_id` del payload).
2. Si sí: solo le importan los cambios en propiedades que el sitio publica (`EVENTS_PUBLIC_PROPERTY_IDS`, los IDs que lee `mapEvent`) o eventos estructurales (página creada, borrada o movida). Los IDs llegan URL-encoded y se decodifican antes de comparar.
3. Un cambio relevante **no dispara build**: escribe `events_rebuild_pending` en `RELAY_KV`.
4. El cron `*/5 * * * *` (`scheduled`) revisa la marca: si existe, llama al Deploy Hook **una vez** y la borra.
5. El cron diario `0 13 * * *` UTC dispara el Deploy Hook para que el HTML deje de listar eventos pasados aunque nadie edite Notion, y borra la marca si el hook respondió ok.

Las demás fuentes siguen disparando build directo, sin debounce.

**Gotcha · cron registrado que no dispara:** tras el primer `PUT` de schedules, el `*/5` no se invocó durante ~15 h (el diario sí). Arrancó al re-aplicar el mismo `PUT`; causa desconocida. Después de cualquier cambio de schedules, verificar con GraphQL `workersInvocationsScheduled` que haya ≥2 invocaciones del `*/5` en 15 min. `GET /schedules` lista el cron aunque no dispare. Una marca `events_rebuild_pending` que persiste por horas es la señal.

**Re-desplegar el Worker por API:** preservar los bindings (`keep_bindings: ["secret_text"]` + re-declarar `RELAY_KV`), subir el script **primero** y después hacer `PUT` de schedules con **ambos** crons.

### Gotcha crítico · versión de API de la integración

Los tipos de evento que Notion emite por webhook dependen de la **versión de API configurada en la integración** (Settings & members → Connections → integración → API version), no de un header por-request (los webhooks salientes no lo llevan).

Con una versión vieja, los cambios en propiedades tipo archivo (reemplazar una imagen) **no disparaban ningún evento** — el auto-publish se quedaba "colgado" en silencio ante ese tipo de edición, sin que nada estuviera roto en el Worker. Fijo en `2026-03-11` con todos los eventos habilitados.

**Si un cambio en Notion no dispara rebuild:** revisar primero la versión de API de la integración, antes de asumir que el Worker o el Deploy Hook están rotos.

## Gotcha · ráfagas de builds

Notion emite un evento de webhook **independiente por cada propiedad/bloque** que cambia en una sola edición. Una edición grande dispara 3–4 builds casi simultáneos. No es un bug: es el volumen esperado de los eventos habilitados.

## Gotcha · deploy hooks duplicados

El proyecto de Cloudflare Pages llegó a tener dos deploy hooks ("Diego CMS" huérfano y "notion-cms-rebuild"). El Worker solo llama a `env.DEPLOY_HOOK_URL` una vez, así que el segundo hook no causaba builds duplicados por sí mismo. El secret se re-apuntó explícitamente a "notion-cms-rebuild" para eliminar la ambigüedad (Cloudflare nunca deja releer el valor de un secret guardado).

## Secrets y bindings del Worker

| Nombre | Tipo | Para qué |
|---|---|---|
| `NOTION_WEBHOOK_SECRET` | secret | validar la firma HMAC del webhook |
| `DEPLOY_HOOK_URL` | secret | Deploy Hook de Cloudflare Pages (`newlandingpage`, → "notion-cms-rebuild") |
| `RELAY_KV` | KV namespace | guardar el `verification_token` del handshake y la marca `events_rebuild_pending` |

Ninguno vive en un repo.
