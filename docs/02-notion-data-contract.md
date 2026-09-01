# 02 · Contrato de datos Notion → Astro

Mapeo verificado contra `reference-code/notionLoaders.ts` y `reference-code/content.config.ts` (commit ancla `4a7bebe`). La API de Notion devuelve cada propiedad como un objeto discriminado por `type`; los helpers de `notionClient.ts` (`getTitle`, `getSelect`, `getMultiSelect`, `getCheckbox`, `getNumber`, `getUrl`, `getRelationIds`, `getStatus`, `getFileUrls`) extraen el valor plano de forma segura, devolviendo un default neutro si la propiedad falta o es de otro tipo. La validación estricta la hace Zod después.

---

## 1. `SSOT - Portafolio Proyectos` → colección `cases`

`data_source_id: 88257bc9-e575-45e8-90df-f851f96e92f2` · id de entrada = `page.id` de Notion (estable, único).

| Propiedad Notion | Tipo | Campo | Notas |
|---|---|---|---|
| `title` | title | `title` | requerido (`z.string().min(1)`) |
| `Titular de tarjeta` | rich_text | `cardHeadline` | override manual del título; prioridad sobre `resultHeadline`. Default `''` |
| `Organización` | select | `organization` | **opcional** — 12/27 fichas no lo tienen |
| `Tipo` | select | `type` | **opcional** — 11/27 fichas no lo tienen |
| `Rol de Diego` | rich_text | `role` | requerido |
| `Contexto tarjeta` | rich_text | `cardContext` | frase ~160 car. para la tarjeta. Default `''` |
| `Objetivo con métrica y timeframe `  | rich_text | `objective` | **el nombre real lleva un espacio final** |
| `Resultados y acciones clave realizadas` | rich_text | `resultsAndActions` | texto libre, no array |
| `Datos cuantitativos` | rich_text | `quantData` | texto libre |
| `Métrica ancla` | rich_text | `anchorMetric` | la cifra que sostiene el caso |
| `Estado publicación` | select | `publicationStatus` | `Draft` / `En revisión` / `Publicado` / `Archivado`. Default `Draft` |
| `Publicable` | checkbox | `publishable` | segundo gate obligatorio. Default `false` |
| `Capa` | select | `layer` | `Insignia` / `Soporte` / `Archivo`. Requerido |
| `Canales` | multi_select | `channels` | `Sitio` / `LinkedIn` / `CV` / `llms.txt`. Default `[]` |
| `Capacidades` | multi_select | `capabilities` | lista abierta. Default `[]` |
| `Evidencia` | url | `evidenceUrl` | opcional; schema exige esquema `http(s)://` |
| `Evidencia visual` | files (multi) | `evidenceMedia` | **solo fotos**, cacheadas localmente. Default `[]` |
| `Videos de evidencia` | rich_text | `evidenceVideos` | texto libre, una URL por línea (`Etiqueta \| URL` opcional). **Regla dura: siempre link externo YouTube/Drive, nunca archivo subido** |
| `Caso maestro` / `Ediciones` | relation (auto) | `masterCase` / `editions` | agrupa ediciones bajo su maestro. Default `[]` |
| `year` | select | `year` | opcional (usar `year`, no `[DEPRECADO] Año`) |
| `Orden Insignia` | number | `insigniaOrder` | orden manual de los 4 casos Insignia en `/portfolio`; sin valor va al final |
| `banner`, `logo` | files | `banner`, `logo` | primer archivo; cacheados localmente |
| `Reflexión` | rich_text | `reflection` | cierre editable sin tocar el body; su sección solo renderiza si no está vacía. Default `''` |
| *(cuerpo de la página)* | bloques | `body` | Markdown plano vía `blocksToMarkdown()` (soporta tablas ✔/✖) |

### Campos derivados (no son propiedades)

| Campo | Cómo se calcula |
|---|---|
| `resultHeadline` | primer `heading_1` del cuerpo — el resultado narrado como afirmación |
| `hasVerifiedEvidence` | `true` si alguna fila de la tabla bajo `## Evidencia` del cuerpo contiene `✔` |
| `draft` | `!(publicationStatus === "Publicado" && publishable)` — **la regla de publicación** |
| `en` | traducciones DeepL de `CASE_TRANSLATABLE_FIELDS` (title, resultHeadline, cardHeadline, cardContext, objective, resultsAndActions, anchorMetric, body, reflection) |

### Guardrail (`superRefine` en `content.config.ts`)

Si `layer === 'Insignia'` **y** `draft === false`:

- `anchorMetric` vacío → `ctx.addIssue` → **el build falla**
- `evidenceUrl` ausente → `ctx.addIssue` → **el build falla**

Una ficha `Soporte` puede publicarse sin métrica ancla; eso no es un bloqueo.

---

## 2. `Métricas oficiales — Portafolio D` → colección `metrics`

`data_source_id: 213ea2d0-bffc-41b9-9877-92132551461c` · id de entrada = `slug` (kebab-case, llave primaria de facto).

| Propiedad Notion | Tipo | Campo | Notas |
|---|---|---|---|
| `Métrica` | title | `metric` | requerido |
| `Slug` | rich_text | `slug` | `^[a-z0-9-]+$`, nunca cambia |
| `Valor` | rich_text | `value` | valor publicable con formato exacto |
| `Claim canónico` | rich_text | `canonicalClaim` | frase publicable completa |
| `Calificador obligatorio` | rich_text | `mandatoryQualifier` | **siempre acompaña al valor** en cualquier superficie |
| `Timeframe` | rich_text | `timeframe` | |
| `Entidad/Programa` | select | `entity` | opcional |
| `Superficies permitidas` | multi_select | `allowedSurfaces` | `Hero` / `Caso de estudio` / `llms.txt` / `CV` / `Pitch deck` / `LinkedIn` / `Sitio web` |
| `Estado` | select | `status` | `Vigente` / `Condicionada` / `Retirada` / `En revisión` |
| `Publicabilidad` | select | `publicability` | `Pública` / `Interna` / `A solicitud` / `No publicable` |
| `Grado de evidencia` | select | `evidenceGrade` | `published` / `own` / `belief` (belief agregado 2026-08-17) |
| `Riesgo reputacional` | select | `reputationalRisk` | `Bajo` / `Medio` / `Alto` |
| `URL / Evidencia` | url | `evidenceUrl` | opcional, esquema `http(s)://` |
| `Fuente` | rich_text | `source` | respaldo cuando no hay URL |
| `Nota de uso` | rich_text | `usageNote` | restricciones de publicación |
| `Ficha relacionada` | relation | `relatedCase` | → `cases` |

### Campo derivado

| Campo | Cómo se calcula |
|---|---|
| `buildable` | `status === "Vigente" && (publicability === "Pública" \|\| publicability === "A solicitud")` |
| `en` | traducciones DeepL de `METRIC_TRANSLATABLE_FIELDS` (metric, canonicalClaim, mandatoryQualifier, usageNote) |

**Tres grados de evidencia** (declarados en el copy, nunca disfrazados):

- **`published`** — un tercero nombrado lo publica (Informes Anuales del Tec, prensa, páginas de speakers).
- **`own`** — registros propios o estimación con metodología declarada.
- **`belief`** — creencia informada del autor, sin registro ni metodología formal; se declara así en el copy mismo. Reservado para cifras de apoyo, nunca para la métrica ancla de una ficha Insignia.

**Riesgo aceptado:** `verify-metrics.cjs` **no valida la versión EN**. Una cifra puede publicarse en `/en/*` con su `mandatoryQualifier` traducido por DeepL sin verificación programática de que la traducción preservó el calificador. Decisión explícita del 2026-08-17.

---

## 3. `Copy Oficial · diegomaury.mx (SSOT)` → singleton `siteCopy`

`page_id: d9ab8508-660a-43e8-ac45-9386dd7903d9` · **no es una database**. id de entrada fijo = `"site"`.

Schema Zod mínimo: `{ title: z.string(), markdown: z.string() }`. El loader trae `blocksToMarkdown(blocks)` crudo; la estructura la impone `src/utils/parseSiteCopy.ts` en runtime de las páginas, partiendo por encabezados:

| Patrón de heading | Contenido | Consumidor |
|---|---|---|
| `# S1 · …` … `# S8 · …` | secciones del home (Hero, Quién soy, Problema, Evidencia, Cómo trabajo, Sistemas propios, Testimonios, Siguiente paso) | `src/pages/index.astro` |
| `# SEO · …` | metadatos + `## Footer` embebido | `BaseLayout` / `Footer` |
| `# P1 · …` … `# P5 · …` | copy narrativo de `/portfolio` (hero, transiciones, CTA de cierre) | `src/pages/portfolio.astro` |

**Reglas:**

- El código usa el **número** (`S1`…`S8`, `P1`…`P5`) como ancla, nunca el nombre visible después del `·` — Diego puede renombrar secciones sin romper nada.
- El parser descarta cualquier clave `S<n>` duplicada y se queda con la **primera** aparición (Versión Actual va antes que las páginas archivadas "Obsoleto · …").
- `fetchBlockChildren` **no desciende a `child_page`/`child_database`** — sin este corte, las páginas hermanas archivadas (mismos códigos S1–S8) pisaban el copy vigente.
- Sin estado `Draft`/`Publicado`: es un documento vivo de una sola versión. Todo `siteCopy` se considera siempre publicable.
- **El copy nunca lleva una cifra literal.** Referencia el `slug` de una métrica; el build resuelve valor + calificador. Sin esa indirección, cada edición de copy podía pisar una cifra ya corregida.

---

## 4. `🖼️ CMS Imágenes — Portafolio D` → colección `imageSlots`

`data_source_id: 8dda9726-a42d-407d-ba84-334b4a1ef7a1` · id de entrada = `Slot` (title, llave técnica del código).

| Propiedad Notion | Tipo | Campo | Notas |
|---|---|---|---|
| `Slot` | title | `slot` | llave exacta usada en `slotSrc('<slot>', fallback)`; no renombrar sin tocar el código |
| `Imagen` | files | `imageUrl` | opcional; se cachea localmente (nunca URL cruda de Notion) |
| `Tamaño requerido` | rich_text | `sizeRequired` | referencia para quien sube el archivo |
| `Formato requerido` | select | `formatRequired` | PNG / JPG / WebP / SVG |
| `Estado` | status | `status` | `Sin empezar` / `En curso` / `Listo` |
| `Descripcion` | rich_text | `description` | dónde vive el slot en el código |
| `Nombre` | rich_text | `nombre` | alt text con acentos/mayúsculas correctas (obligatorio para logos del cinturón) |

**Regla de resolución** (`slotSrc` en `index.astro`): usa `imageUrl` **solo si** `status === "Listo"` **y** `imageUrl` existe; si no, cae al path hardcodeado. Nunca rompe el build.

**Cinturón de logos del Hero (2026-08-14):** 100% dinámico. Se arma con filas de `imageSlots` donde `slot` empieza con `logo-`, no termina en `-evidencia`, `status === "Listo"`, tiene imagen y tiene `Nombre`. Orden alfabético por `Nombre`. El guardrail anti-desanonimización de un caso bajo NDA es `BLOCKED_LOGO_NAMES` (un `Set` comparado contra `Nombre`).

---

## Regla transversal (las 4 fuentes)

El build de Astro **falla en frío** (el sitio LIVE anterior permanece activo) si:

- una ficha con `draft = false` y `layer = "Insignia"` no tiene `anchorMetric` + `evidenceUrl`,
- `siteCopy` referencia un slug de métrica que no existe o cuyo `buildable` es `false`,
- cualquier dato viola su schema Zod (`parseData` lanza).
