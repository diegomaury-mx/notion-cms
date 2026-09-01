# 07 · Runbook — fallos conocidos

Guía de diagnóstico para cuando algo del CMS no se comporta. Ordenado por frecuencia observada.

---

## "Publiqué una ficha en Notion y no aparece en el sitio"

1. **`Publicable`.** Verificar el checkbox `Publicable = true` en la ficha. `Estado publicación = Publicado` no basta solo, en ninguna capa. → [05 · Gate 1](05-build-gates.md).
2. **¿Hubo rebuild?** Editar Notion no basta si el webhook no disparó. Ver más abajo.
3. **Capa Insignia sin evidencia.** Si la ficha es `Insignia`, `draft = false` y le falta `Métrica ancla` o `Evidencia`, el build **falló** (guardrail `superRefine`) y el deploy no ocurrió. Revisar el log del build en Cloudflare.

## "Cambié algo en Notion y no se reconstruyó nada"

1. **Versión de API de la integración de Notion.** Settings & members → Connections → la integración → API version. Debe estar en `2026-03-11` con todos los eventos habilitados. Con una versión vieja, los cambios en propiedades tipo archivo (reemplazar imagen) no emiten evento. → [06](06-auto-publish.md).
2. **¿La fuente está en la suscripción?** Solo SSOT casos, CMS Imágenes y Copy Oficial disparan el Worker. Un cambio en `Métricas oficiales` no reconstruye solo — requiere sincronizar `metrics.json` + push.
3. **Logs del Worker.** `mcp__plugin_cloudflare_cloudflare-observability__query_worker_observability` sobre `notion-deploy-relay`, o el dashboard de Cloudflare. Buscar `Notion event received:` y `Deploy hook triggered, status: 200`.
4. **Firma HMAC.** Un 401 en los logs = `NOTION_WEBHOOK_SECRET` del Worker no coincide con el secreto de la suscripción de Notion.

## "El build falla con `Block type ai_block is not supported`"

Un bloque nativo `ai_block` de Notion (la herramienta "Ask AI" / redacción con IA, sin aceptar el resultado como texto normal) en el body de **cualquier** ficha del SSOT rompe **todos** los rebuilds, automáticos y por push.

**Fix:** identificar la(s) ficha(s) con ese bloque y convertirlo a texto plano en Notion ("Convertir en" → Texto). Pasó el 2026-08-13 (~40 deploys fallidos mientras se redactaban fichas con esa herramienta).

## "El build falla con `NOTION_TOKEN requerido`"

El secret expiró o falta. `NOTION_TOKEN` se configura por separado para `preview` y `production` en Cloudflare Pages. Diego administra la integración; hay que regenerar el token y actualizar los secrets (Cloudflare Pages + `.env` local + secret de GitHub para CI).

## "El check 'Cloudflare Pages' de un PR falla pero `master` despliega bien"

Los secrets de Cloudflare Pages son independientes por entorno. El `NOTION_TOKEN` (o `DEEPL_API_KEY`) de `preview` puede estar vacío mientras `production` está sano.

**Antes de bloquear el merge:** `GET /accounts/{accountId}/pages/projects/newlandingpage/deployments?env=production` — si production está construyendo bien el mismo commit del HEAD anterior, el fallo es del entorno preview, no del código del PR, y el merge es seguro.

## "Las imágenes de un caso se ven rotas en producción"

Casi siempre: una URL cruda de S3 de Notion llegó al HTML en vez de la ruta cacheada. No debería pasar con el pipeline actual (`cacheNotionImage` corre en todos los `imageFields`), pero si se agregó un campo de imagen nuevo sin listarlo en `imageFields` del loader, la URL firmada se publica y expira en ~1h. → [03](03-image-pipeline.md).

## "El sitio EN se ve en español"

1. **`DEEPL_API_KEY` faltante** en Cloudflare Pages → traducción se omite con warning, degradación esperada.
2. **Cuota agotada.** `GET https://api-free.deepl.com/v2/usage` (gratis de consultar). Si es `500000/500000`, esperar el reset mensual o subir a plan de pago. Todo texto nuevo degrada a español hasta entonces.
3. El cache de traducción (`public/cms-media/notion/translations/`) debe estar versionado en git. Si alguien lo volvió a gitignorar, cada deploy retraduce todo. → [04](04-translation-pipeline.md).

## "Una sección del home desapareció después de editar el copy"

El parser (`parseSiteCopy.ts`) corta por el patrón exacto `# S<n> · `. Si se borró o renombró el prefijo `# S<n> · ` de una sección, o si un bloque quedó con un salto de línea sobrante que descoloca el heading, esa sección deja de reconocerse **en silencio** (pasó con S8 el 2026-08-03). Verificar los encabezados en la columna "Versión Actual" de "Copy Oficial".

También: no editar las páginas archivadas "Obsoleto · Secciones reemplazadas…" — el parser se queda con la primera aparición de cada `S<n>`, que es la vigente.

## Verificar el estado real de un deploy

```
GET /accounts/{accountId}/pages/projects/newlandingpage/deployments/{id}
```

vía `mcp__plugin_cloudflare_cloudflare-api__execute`. No confiar solo en `latest_stage.status`: puede reportar `active` sostenido 10–15 min aunque el build real ya terminó en < 2 min. Revisar los timestamps `stages[].started_on` / `ended_on`. El paso `[notion-cases]` del build de Astro toma ~90–115s de por sí (trae el body completo de las 27 fichas) — no asumir que está colgado antes de ~2 min.
