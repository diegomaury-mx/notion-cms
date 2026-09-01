/**
 * Astro Content Collections — Schema Definitions
 *
 * `cases`, `metrics`, `siteCopy` e `imageSlots` son las 4 colecciones del CMS
 * de Notion (Diego CMS): cargan datos en build vía Content Layer API
 * (`loader:`), validadas contra el contrato real en
 * `docs/platform/notion-astro-contract.md`.
 *
 * Requires: astro@^7.0.0 (Content Layer API estable). Movido de
 * src/content/config.ts a src/content.config.ts (2026-08-20): v6 elimino el
 * soporte de "legacy content config" en la ubicacion anterior.
 * All date fields use ISO 8601 string format (e.g. "2024-03-15").
 * All slug references use kebab-case filenames without extension.
 */

import { defineCollection, z } from 'astro:content';
import {
  CASE_TRANSLATABLE_FIELDS,
  METRIC_TRANSLATABLE_FIELDS,
  casesLoader,
  imageSlotsLoader,
  metricsLoader,
  siteCopyLoader,
} from './services/notionLoaders.ts';

/** Construye el schema Zod de `en` con las mismas claves que traduce el loader (una sola fuente, ver notionLoaders.ts). */
function translatableEnSchema(fields: readonly string[]) {
  return z
    .object(Object.fromEntries(fields.map((field) => [field, z.string().optional()])))
    .default({});
}

// `z.string().url()` acepta cualquier esquema valido de WHATWG URL, incluido
// `javascript:` — el mapper de notionLoaders.ts ya filtra a https?:// en la
// practica, pero el schema no lo exigia. Restringe explicitamente el esquema
// como defensa en profundidad (ver TECHNICAL_DEBT.md, Seguridad #3).
const httpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), {
  message: 'La URL debe usar esquema http:// o https://',
});

// ─── Case Study (fuente: SSOT - Portafolio Proyectos) ─────────────────────────

const cases = defineCollection({
  loader: casesLoader,
  schema: z
    .object({
      title: z.string().min(1),
      // H1 del cuerpo de la ficha: el resultado narrado como afirmacion
      // ("Escale X y logre Y"). Vive en el body, no en una propiedad — vacio
      // si la ficha aun no tiene esa narrativa escrita.
      resultHeadline: z.string().default(''),
      // Propiedad "Titular de tarjeta" (agregada 2026-08-16): override manual
      // del titulo mostrado, con prioridad sobre resultHeadline. Vacio hasta
      // que Diego migre una ficha; el fallback resultHeadline||title sigue
      // vigente para no romper nada retroactivamente (ver cardTitle() en
      // portfolio.astro, displayTitle en [slug].astro y llms.txt.ts).
      cardHeadline: z.string().default(''),
      // 12/27 fichas reales no tienen Organización y 11/27 no tienen Tipo
      // (fichas Draft/Archivo aún sin curar) — opcionales para no bloquear
      // el build entero por contenido en progreso que no se va a publicar.
      organization: z.string().optional(),
      type: z.string().optional(),
      role: z.string(),
      // Frase de ~160 caracteres escrita para la tarjeta (Contexto tarjeta en
      // Notion), separada de `role` para no truncar texto pensado para la
      // pagina completa del caso. Vacio hasta que se llene por ficha.
      cardContext: z.string().default(''),
      objective: z.string(),
      resultsAndActions: z.string(),
      quantData: z.string(),
      anchorMetric: z.string(),
      publicationStatus: z
        .enum(['Draft', 'En revisión', 'Publicado', 'Archivado'])
        .default('Draft'),
      publishable: z.boolean().default(false),
      layer: z.enum(['Insignia', 'Soporte', 'Archivo']),
      channels: z.array(z.enum(['Sitio', 'LinkedIn', 'CV', 'llms.txt'])).default([]),
      capabilities: z.array(z.string()).default([]),
      evidenceUrl: httpUrl.optional(),
      // Fotos de evidencia subidas directo a Notion, cacheadas localmente en
      // build (ver notionImageCache.ts). Los videos NUNCA viven aqui: van
      // forzosamente en `evidenceVideos` como link externo, nunca como
      // archivo — evita romper el limite de tamano de assets de Cloudflare
      // Pages con un video sin comprimir.
      evidenceMedia: z.array(z.string()).default([]),
      evidenceVideos: z.array(z.object({ label: z.string(), url: httpUrl })).default([]),
      // Badge de evidencia de tarjeta: se hereda de si al menos una fila de
      // la tabla "## Evidencia" del cuerpo tiene un artefacto marcado (✔).
      // Nunca se declara aparte de esa tabla (ver notionLoaders.ts).
      hasVerifiedEvidence: z.boolean().default(false),
      masterCase: z.array(z.string()).default([]),
      editions: z.array(z.string()).default([]),
      year: z.string().optional(),
      // Orden manual de los casos Insignia en /portfolio (agregado 2026-08-16,
      // rediseño narrativo): los 4 casos Insignia usan el mismo tratamiento
      // visual (sin "featured"), asi que el orden ya no lo decide el codigo
      // (antes: "primero con evidencia verificada") sino Diego, via esta
      // propiedad numerica en Notion. Sin valor = va al final (ver fallback
      // determinista en portfolio.astro: year desc, luego title).
      insigniaOrder: z.number().optional(),
      banner: z.string().optional(),
      logo: z.string().optional(),
      // Cuerpo completo de la ficha (Contexto, Problema, Sistema, Evidencia,
      // etc.), aplanado a Markdown. Fuente narrativa para la pagina de caso.
      body: z.string().default(''),
      // Reflexion de cierre, propiedad independiente del body (Notion:
      // "Reflexión") para poder editarla sin tocar el resto de la narrativa.
      // Vacia hasta que se llena; la seccion final de la pagina de caso no
      // se renderiza si esta vacia (ver [slug].astro).
      reflection: z.string().default(''),
      // draft = NOT (Estado publicación == "Publicado" AND Publicable == true)
      draft: z.boolean().default(true),
      // Traduccion automatica a ingles (DeepL, cacheada en build, ver
      // notionLoaders.ts translateFields) de los campos de prosa. Solo trae
      // las claves que efectivamente se tradujeron — sin DEEPL_API_KEY
      // configurado, viene vacio y la pagina /en/portfolio/[slug] cae al
      // campo en espanol como fallback (ver [slug].astro).
      en: translatableEnSchema(CASE_TRANSLATABLE_FIELDS),
    })
    .superRefine((data, ctx) => {
      // Regla transversal del contrato: capa Insignia no puede publicarse
      // (draft = false) sin métrica ancla y evidencia verificadas.
      if (data.layer === 'Insignia' && !data.draft) {
        if (!data.anchorMetric.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['anchorMetric'],
            message: 'Ficha Insignia publicada sin Métrica ancla — bloquea el build.',
          });
        }
        if (!data.evidenceUrl) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['evidenceUrl'],
            message: 'Ficha Insignia publicada sin Evidencia — bloquea el build.',
          });
        }
      }
    }),
});

// ─── Métricas oficiales (fuente: Métricas oficiales — Portafolio D) ───────────

const metrics = defineCollection({
  loader: metricsLoader,
  schema: z.object({
    metric: z.string().min(1),
    slug: z.string().regex(/^[a-z0-9-]+$/, 'slug debe ser kebab-case'),
    value: z.string(),
    canonicalClaim: z.string(),
    mandatoryQualifier: z.string(),
    timeframe: z.string(),
    entity: z.string().optional(),
    allowedSurfaces: z
      .array(
        z.enum([
          'Hero',
          'Caso de estudio',
          'llms.txt',
          'CV',
          'Pitch deck',
          'LinkedIn',
          'Sitio web',
        ])
      )
      .default([]),
    status: z.enum(['Vigente', 'Condicionada', 'Retirada', 'En revisión']).optional(),
    publicability: z
      .enum(['Pública', 'Interna', 'A solicitud', 'No publicable'])
      .optional(),
    evidenceGrade: z.enum(['published', 'own', 'belief']).optional(),
    reputationalRisk: z.enum(['Bajo', 'Medio', 'Alto']).optional(),
    evidenceUrl: httpUrl.optional(),
    source: z.string().optional(),
    usageNote: z.string().optional(),
    relatedCase: z.array(z.string()).default([]),
    // buildable = Estado == "Vigente" AND Publicabilidad IN [Pública, A solicitud]
    buildable: z.boolean(),
    // Traduccion automatica a ingles (DeepL, cacheada), ver `en` en `cases`
    // arriba. Nota: el gate de verify-metrics.cjs NO valida esta version —
    // riesgo aceptado explicitamente (decision 2026-08-17), no reintroducir
    // sin decision aparte.
    en: translatableEnSchema(METRIC_TRANSLATABLE_FIELDS),
  }),
});

// ─── Copy Oficial (fuente: Copy Oficial · diegomaury.mx, singleton) ───────────

const siteCopy = defineCollection({
  loader: siteCopyLoader,
  schema: z.object({
    title: z.string(),
    markdown: z.string(),
  }),
});

// ─── Image Slots (fuente: 🖼️ CMS Imágenes — Portafolio D) ─────────────────────
// Slots de imagen hoy hardcodeados en index.astro (foto de Diego, logos de
// trust bar). `slot` es la llave tecnica que el codigo usa para buscar cada
// fila; `status !== 'Listo'` o `imageUrl` ausente = el render cae al fallback
// hardcodeado actual, para no romper el sitio mientras Diego sube archivos.

const imageSlots = defineCollection({
  loader: imageSlotsLoader,
  schema: z.object({
    slot: z.string().min(1),
    // Ruta local (`/cms-media/notion/...`), no una URL externa: el loader
    // descarga la imagen de Notion en build y la cachea como asset propio
    // (ver gotcha 2026-08-03 en notion-astro-contract.md seccion 4).
    imageUrl: z.string().optional(),
    sizeRequired: z.string().default(''),
    formatRequired: z.string().optional(),
    status: z.enum(['Sin empezar', 'En curso', 'Listo']).optional(),
    description: z.string().default(''),
    // Nombre de display (con acentos/mayusculas correctas) para el alt de
    // logos renderizados directo desde el CMS, sin pasar por copy de Notion
    // S1 (ver cinturon de logos, 2026-08-14).
    nombre: z.string().default(''),
  }),
});

// ─── Exports ─────────────────────────────────────────────────────────────────

export const collections = {
  cases,
  metrics,
  siteCopy,
  imageSlots,
};
