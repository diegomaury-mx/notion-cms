# 08 · Límites y deuda técnica

Estado honesto de lo que no está resuelto. Resumen del `TECHNICAL_DEBT.md` del repo del sitio (auditoría 2026-08-19, `/audit-project` modo quick), filtrado a lo que toca el CMS. La lista completa y priorizada vive en ese archivo.

## Rendimiento del build

| Ítem | Detalle |
|---|---|
| **Build de 90–115s** | `createDataSourceLoader` trae el `body` completo de las 27 fichas. Paraleliza a concurrencia 6 (`mapWithConcurrency`), pero el paso `[notion-cases]` sigue siendo el cuello de botella. |
| **`notionImageCache` recomprime de más** | El cache-hit por `readdir` mitiga, pero cada build sigue haciendo un `readdir` por imagen. Con el cache versionado en git el trabajo real es incremental. |
| **Google Fonts carga pesos no usados** | Peso 800 e itálico se cargan aunque el design system solo usa 300/400/500/700. |

## Duplicación ES / EN

| Ítem | Detalle |
|---|---|
| **`en/index.astro` duplica ~237 líneas** de `index.astro` | geometría radial S4, `ctaTarget()`, `SECTION_IDS` y —lo más delicado— el guardrail anti-desanonimización `BLOCKED_LOGO_NAMES`, que vive en dos archivos sin fuente única. Fix propuesto: extraer a `src/utils/` compartidos. |
| **Ficha de caso EN quedó en el diseño anterior** | `en/portfolio/[slug].astro` sigue con el `case-hero` viejo; ES tiene la franja de identidad + galería lateral (rediseño 2026-08-18). Son dos diseños distintos de la misma página. Fix: extraer a `src/components/case/CaseArticle.astro` compartido. |
| **Reglas de negocio duplicadas** | orden Insignia, listas de slugs ancla/soporte, `metricBySlug()` reimplementados en ~5 lugares entre `portfolio.astro` y `en/portfolio.astro`. |

## Cobertura de tests

| Sin test | Riesgo |
|---|---|
| `parseSiteCopy.ts` (9 funciones) | corazón del parseo de todo el copy; un regex mal ajustado rompe una sección en silencio (ya pasó, S8). |
| `notionImageCache.ts` | `cacheNotionImage` mezcla I/O con reglas críticas (límite 20MB, resize, fallback) sin cobertura. |
| `hasVerifiedEvidenceRow` / `parseEvidenceVideos` / `extractResultHeadline` | deciden el badge de evidencia (gate del guardrail Insignia). |
| substring-de-raíz de `verify-metrics.cjs` | documentado explícitamente pero ningún test lo verifica. |

## Seguridad (riesgo bajo hoy — trust model single-editor)

| Ítem | Detalle |
|---|---|
| **Sin CSP en Cloudflare Pages** | el propio manual del proyecto (regla heredada) exige CSP en producción; no existe `public/_headers`. |
| **JSON-LD sin escapar `</script>`** | `BaseLayout.astro` inyecta `JSON.stringify(jsonLd)` con `set:html`; `jsonLd` incluye texto libre de Notion. |
| **Links de markdown sin allowlist de esquema** | `markdown.ts` escapa el texto pero no valida el esquema del `href` (`javascript:` URI). Zod `httpUrl` ya lo restringe en `evidenceUrl`/`evidenceVideos`, pero no en links dentro del `body`. |
| **SSRF de bajo riesgo en `cacheNotionImage`** | mitigado con `ALLOWED_IMAGE_HOST_SUFFIXES` (allowlist de host + `https:`). |

## Riesgos aceptados (no relitigar sin decisión de Diego)

- **`verify-metrics.cjs` no valida la versión EN.** Una cifra puede publicarse en `/en/*` con su calificador traducido por DeepL sin verificación programática. Decisión 2026-08-17.
- **`ai_block` de Notion rompe el build** sin gate preventivo. La mitigación es operativa (convertir el bloque a texto), no de código.
- **La URL de cada caso depende del título de Notion** sin campo `Slug` dedicado — un renombre desincroniza en silencio.
- **`docencia.astro` tiene contenido editorial hardcodeado** — único caso fuera del CMS, sin ruta EN posible. Decisión: fuera de alcance de la migración inicial.

## Colecciones muertas

`src/content.config.ts` (versión previa) tenía 4 colecciones sin consumidor (`projects`, `playbooks`, `insights`, `services`). En el commit ancla ya no están en `collections` — el archivo exporta solo `cases`, `metrics`, `siteCopy`, `imageSlots`.
