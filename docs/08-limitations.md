# 08 · Límites y deuda técnica

Estado honesto de lo que no está resuelto, filtrado a lo que toca el CMS. Revisado el 2026-11-25 contra el código del sitio.

## Rendimiento del build

| Ítem | Detalle |
|---|---|
| **Build de 75–115s** | `createDataSourceLoader` trae el `body` completo de todas las fichas de caso. Paraleliza a concurrencia 6 (`mapWithConcurrency`), pero el paso `[notion-cases]` sigue siendo el cuello de botella. No hay cache de bloques por `last_edited_time`. |
| **`reservaCopy` se carga sin consumidor** | `/reserva` es un redirect 301 desde 2026-09-26, pero el loader de esa página singleton sigue corriendo en cada build. |

## Contenido que se lee vacío a propósito

| Ítem | Detalle |
|---|---|
| **`Objetivo con métrica y timeframe`** | El mapper busca el nombre con un espacio final que ya no existe, así que `objective` llega vacío. No se corrige hasta que ese campo esté curado: al leerse, alimentaría la meta description y el `.md` de cada ficha. |
| **`Slug` de casos** | La propiedad existe, pero la URL se sigue derivando de `slugify(title)`. Un renombre del título cambia la URL en silencio. |

## Fallos silenciosos

| Ítem | Detalle |
|---|---|
| **Helpers `get*` sin error** | Un renombre o cambio de tipo de una propiedad en Notion devuelve `''`/`[]`/`undefined` sin avisar. Mitigación: tests de mapper (`notionLoaders.test.ts`, `notionEvents.test.ts`) y revisión contra `GET /v1/data_sources/{id}`. |
| **Copy por estructura** | `parseSiteCopy.ts` y los parsers de sección leen el copy por encabezados y posición. Reestructurar la página en Notion vacía secciones sin romper el build. |
| **Exit 0 engañoso** | Un timeout del loader puede abortar el build con exit 0 y `dist/` sin regenerar. Confirmar `[build] Complete!` en el log. |

## Seguridad (trust model single-editor)

Resuelto: CSP + HSTS + nosniff + `frame-ancestors 'none'` en `public/_headers`; TLS mínimo 1.2 en la zona; JSON-LD escapado (`<` → `<`); links del Markdown con allowlist de esquema (`http(s)`, `mailto`, `tel`, rutas relativas); `cacheNotionImage` con allowlist de hosts + `https:`; el webhook valida firma HMAC.

Pendiente o aceptado:

| Ítem | Detalle |
|---|---|
| **`script-src 'unsafe-inline'`** | El sitio es estático, así que no hay nonce por request. Cubre los loaders de analítica y scripts `is:inline`. Riesgo bajo: el contenido de Notion siempre se escapa antes de llegar al HTML. |
| **Comparación de firma no constante** | El Worker compara la firma HMAC con `!==` en vez de una comparación de tiempo constante. Riesgo práctico bajo a través de la red. |

## Riesgos aceptados (no relitigar sin decisión del dueño)

- **`verify-metrics.cjs` no valida la versión EN.** Una cifra puede publicarse en `/en/*` con su calificador traducido por DeepL sin verificación programática. Decisión 2026-08-17.
- **`ai_block` de Notion rompe el build** sin gate preventivo. La mitigación es operativa (convertir el bloque a texto), no de código.
- **Doble instancia de Zod** (v4 de Astro, v3 directa en `notionEvents.ts`). Se acota con un `@ts-expect-error` en `content.config.ts`; los consumidores tipan con `EventData`.
- **`docencia.astro` tiene contenido editorial hardcodeado.** Es el único caso fuera del CMS y no tiene ruta EN.
- **Taxonomías de eventos en español también en `/en/events`.** Es una decisión editorial.
