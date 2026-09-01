/**
 * Loaders de Astro Content Layer para las 3 fuentes CMS de Notion (Diego CMS).
 *
 * Cada loader corre en build (server-side): jala las paginas via notionClient,
 * mapea propiedades al shape del schema Zod (definido en src/content/config.ts) y
 * las guarda en el store de Astro. parseData() aplica el schema de la coleccion;
 * un dato invalido lanza y detiene el build (fallo seguro, contrato transversal).
 *
 * Gating de token:
 * - Build de produccion sin NOTION_TOKEN -> lanza (no se publica un sitio vacio).
 * - Dev/sync sin token -> advierte y deja la coleccion vacia, para poder generar
 *   tipos y montar el scaffold sin credenciales.
 *
 * Mapeo verificado campo por campo contra el esquema vivo de Notion (2026-07-19):
 * data sources 88257bc9 (cases) y 213ea2d0 (metrics).
 */
import type { Loader, LoaderContext } from "astro/loaders";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client";
import {
  fetchBlockChildren,
  fetchCases,
  fetchImageSlots,
  fetchMetrics,
  fetchSiteCopy,
  getCheckbox,
  getFileUrls,
  getMultiSelect,
  getNumber,
  getRelationIds,
  getRichText,
  getSelect,
  getStatus,
  getTitle,
  getUrl,
  hasNotionToken,
} from "./notionClient.ts";
import { cacheNotionImage } from "./notionImageCache.ts";
import { translateCached } from "./deeplTranslationCache.ts";

// Tope de fichas procesadas en paralelo por loader (fetchBlockChildren +
// cacheNotionImage). Acotado a proposito: la API de Notion no es infinita,
// esto es rendimiento de build, no un ataque de fuerza bruta.
const LOADER_CONCURRENCY = 6;

/** Procesa `items` con un maximo de `limit` tareas en vuelo a la vez. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// --- Conversion de bloques a Markdown (para siteCopy) ------------------------

/** Extrae el arreglo de rich text de cualquier bloque que lo tenga. */
function blockRichText(block: BlockObjectResponse): RichTextItemResponse[] {
  const value = (block as Record<string, unknown>)[block.type];
  if (value && typeof value === "object" && "rich_text" in value) {
    const richText = (value as { rich_text?: unknown }).rich_text;
    if (Array.isArray(richText)) return richText as RichTextItemResponse[];
  }
  return [];
}

function plain(richText: RichTextItemResponse[]): string {
  return richText.map((item) => item.plain_text).join("");
}

/** Escapa `|` para que el texto de una celda no rompa una fila de tabla Markdown. */
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Agrega un item de lista a `lines`, fusionandolo con el bloque anterior si
 * ese bloque es una lista del mismo tipo (mismo marcador en todas sus
 * lineas). Sin esto, `lines.join("\n\n")` separa cada item de una lista de
 * Notion en su propio bloque de un solo elemento, y `renderMarkdown` (que
 * parte el markdown por `\n{2,}`) termina generando un `<ul>`/`<ol>` distinto
 * por item en vez de una sola lista continua.
 */
function appendListItem(lines: string[], marker: RegExp, line: string): void {
  const last = lines[lines.length - 1];
  if (last !== undefined && last.split("\n").every((existingLine) => marker.test(existingLine))) {
    lines[lines.length - 1] = `${last}\n${line}`;
  } else {
    lines.push(line);
  }
}

/**
 * Convierte el arbol de bloques de una pagina de Notion a Markdown plano.
 * `fetchBlockChildren` aplana el arbol (un bloque "table" es seguido en el
 * mismo arreglo por sus "table_row" hijos), asi que las tablas se consumen
 * con un indice manual en vez de un for..of: sin esto, las tablas de
 * Resultados y Evidencia (✔/✖ por afirmacion) se perderian en silencio.
 */
export function blocksToMarkdown(blocks: BlockObjectResponse[]): string {
  const lines: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "table") {
      const rows: string[][] = [];
      i += 1;
      while (i < blocks.length && blocks[i].type === "table_row") {
        const row = blocks[i] as Extract<BlockObjectResponse, { type: "table_row" }>;
        rows.push(row.table_row.cells.map((cell) => escapeTableCell(plain(cell))));
        i += 1;
      }
      if (rows.length > 0) {
        const width = rows[0].length;
        const header = block.table.has_column_header ? rows[0] : Array(width).fill("");
        const body = block.table.has_column_header ? rows.slice(1) : rows;
        // Una sola entrada en `lines` (join interno de una sola linea) para
        // que la tabla completa siga siendo un solo bloque markdown, no una
        // por fila, cuando el resultado se una con "\n\n" entre bloques.
        const tableLines = [
          `| ${header.join(" | ")} |`,
          `| ${header.map(() => "---").join(" | ")} |`,
          ...body.map((row) => `| ${row.join(" | ")} |`),
        ];
        lines.push(tableLines.join("\n"));
      }
      continue;
    }
    // .trim(): un bloque pegado a mano en Notion (ej. el ID del widget Senja
    // en S6b) puede traer un salto de linea sobrante al final. Sin recortarlo,
    // el join("\n\n") produce 3 saltos de linea seguidos antes del bloque
    // siguiente; al volver a separar por "\n\n" el heading siguiente queda
    // con un "\n" al inicio y deja de matchear SECTION_HEADING (^# ...), lo
    // que borra esa seccion completa (paso con S8 el 2026-08-03).
    const text = plain(blockRichText(block)).trim();
    switch (block.type) {
      case "heading_1":
        lines.push(`# ${text}`);
        break;
      case "heading_2":
        lines.push(`## ${text}`);
        break;
      case "heading_3":
        lines.push(`### ${text}`);
        break;
      case "bulleted_list_item":
        appendListItem(lines, /^- (?!\[)/, `- ${text}`);
        break;
      case "numbered_list_item":
        appendListItem(lines, /^\d+\.\s/, `1. ${text}`);
        break;
      case "to_do":
        appendListItem(lines, /^- \[ \] /, `- [ ] ${text}`);
        break;
      case "quote":
      case "callout":
        lines.push(`> ${text}`);
        break;
      case "divider":
        lines.push("---");
        break;
      case "code":
        lines.push("```", text, "```");
        break;
      default:
        if (text) lines.push(text);
        break;
    }
    i += 1;
  }
  return lines.join("\n\n");
}

// --- Mappers propiedad -> shape del schema -----------------------------------

/**
 * Primer heading_1 del cuerpo de la ficha: el resultado narrado como
 * afirmacion ("Escale X y logre Y"), distinto de la propiedad `title` (que
 * solo lleva el nombre del programa/cliente). Vacio si la ficha no tiene H1.
 */
export function extractResultHeadline(blocks: BlockObjectResponse[]): string {
  const heading = blocks.find((block) => block.type === "heading_1");
  return heading ? plain(blockRichText(heading)) : "";
}

/**
 * True si al menos una fila de la tabla bajo el heading "## Evidencia" del
 * cuerpo tiene un artefacto marcado (✔). El badge de evidencia de una ficha
 * se hereda de esta tabla, nunca se declara aparte.
 */
export function hasVerifiedEvidenceRow(blocks: BlockObjectResponse[]): boolean {
  let inEvidenceSection = false;
  for (const block of blocks) {
    if (block.type === "heading_2") {
      inEvidenceSection = plain(blockRichText(block)).trim().toLowerCase() === "evidencia";
      continue;
    }
    if (!inEvidenceSection || block.type !== "table_row") continue;
    const rowText = block.table_row.cells.map((cell) => plain(cell)).join(" ");
    if (rowText.includes("✔")) return true;
  }
  return false;
}

/**
 * Parsea "Videos de evidencia" (texto libre, una URL por linea, formato
 * opcional "Etiqueta | URL") a una lista de links externos. Los videos son
 * forzosamente un link, nunca un archivo subido a Notion (ver mapCase).
 */
export function parseEvidenceVideos(raw: string): { label: string; url: string }[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [first, second] = line.split("|").map((part) => part.trim());
      return second ? { label: first, url: second } : { label: "Ver video", url: first };
    })
    .filter((item) => /^https?:\/\//.test(item.url));
}

/** Ficha de `SSOT - Portafolio Proyectos` -> data de la coleccion `cases`. */
async function mapCase(page: PageObjectResponse): Promise<Record<string, unknown>> {
  const publicationStatus = getSelect(page, "Estado publicación") ?? "Draft";
  const publishable = getCheckbox(page, "Publicable");
  const blocks = await fetchBlockChildren(page.id);
  return {
    title: getTitle(page, "title"),
    resultHeadline: extractResultHeadline(blocks),
    cardHeadline: getRichText(page, "Titular de tarjeta"),
    organization: getSelect(page, "Organización"),
    type: getSelect(page, "Tipo"),
    role: getRichText(page, "Rol de Diego"),
    cardContext: getRichText(page, "Contexto tarjeta"),
    // Ojo: el nombre real de la propiedad lleva un espacio al final.
    objective: getRichText(page, "Objetivo con métrica y timeframe "),
    resultsAndActions: getRichText(page, "Resultados y acciones clave realizadas"),
    quantData: getRichText(page, "Datos cuantitativos"),
    anchorMetric: getRichText(page, "Métrica ancla"),
    publicationStatus,
    publishable,
    layer: getSelect(page, "Capa"),
    channels: getMultiSelect(page, "Canales"),
    capabilities: getMultiSelect(page, "Capacidades"),
    evidenceUrl: getUrl(page, "Evidencia"),
    // Fotos subidas directo a Notion (se cachean localmente, ver imageFields
    // abajo). Los videos NUNCA se suben como archivo: van forzosamente como
    // link externo (YouTube/Drive) en "Videos de evidencia" — un video pesado
    // puede romper el limite de ~25MB por archivo estatico de Cloudflare
    // Pages, y este loader no tiene forma de avisarlo antes del deploy.
    evidenceMedia: getFileUrls(page, "Evidencia visual"),
    evidenceVideos: parseEvidenceVideos(getRichText(page, "Videos de evidencia")),
    hasVerifiedEvidence: hasVerifiedEvidenceRow(blocks),
    masterCase: getRelationIds(page, "Caso maestro"),
    editions: getRelationIds(page, "Ediciones"),
    year: getSelect(page, "year"),
    insigniaOrder: getNumber(page, "Orden Insignia"),
    banner: getFileUrls(page, "banner")[0],
    logo: getFileUrls(page, "logo")[0],
    body: blocksToMarkdown(blocks),
    reflection: getRichText(page, "Reflexión"),
    // draft = NOT (Publicado AND Publicable) — contrato, regla de publicacion.
    draft: !(publicationStatus === "Publicado" && publishable),
  };
}

/** Fila de `Métricas oficiales` -> data de la coleccion `metrics`. */
function mapMetric(page: PageObjectResponse): Record<string, unknown> {
  const status = getSelect(page, "Estado");
  const publicability = getSelect(page, "Publicabilidad");
  return {
    metric: getTitle(page, "Métrica"),
    slug: getRichText(page, "Slug"),
    value: getRichText(page, "Valor"),
    canonicalClaim: getRichText(page, "Claim canónico"),
    mandatoryQualifier: getRichText(page, "Calificador obligatorio"),
    timeframe: getRichText(page, "Timeframe"),
    entity: getSelect(page, "Entidad/Programa"),
    allowedSurfaces: getMultiSelect(page, "Superficies permitidas"),
    status,
    publicability,
    evidenceGrade: getSelect(page, "Grado de evidencia"),
    reputationalRisk: getSelect(page, "Riesgo reputacional"),
    evidenceUrl: getUrl(page, "URL / Evidencia"),
    source: getRichText(page, "Fuente"),
    usageNote: getRichText(page, "Nota de uso"),
    relatedCase: getRelationIds(page, "Ficha relacionada"),
    // buildable = Vigente AND publicabilidad en {Publica, A solicitud} — contrato.
    buildable:
      status === "Vigente" &&
      (publicability === "Pública" || publicability === "A solicitud"),
  };
}

/** Fila de `🖼️ CMS Imágenes — Portafolio D` -> data de la coleccion `imageSlots`. */
export function mapImageSlot(page: PageObjectResponse): Record<string, unknown> {
  return {
    slot: getTitle(page, "Slot"),
    imageUrl: getFileUrls(page, "Imagen")[0],
    sizeRequired: getRichText(page, "Tamaño requerido"),
    formatRequired: getSelect(page, "Formato requerido"),
    status: getStatus(page, "Estado"),
    description: getRichText(page, "Descripcion"),
    nombre: getRichText(page, "Nombre"),
  };
}

/**
 * Traduce a ingles (via DeepL, cacheado) los campos de `raw` listados en
 * `fields` que sean string no vacio. Devuelve solo los campos efectivamente
 * traducidos — se guarda como `raw.en` para la version /en/* del sitio, sin
 * tocar los campos originales en espanol (fuente unica sigue siendo Notion).
 */
export async function translateFields(
  raw: Record<string, unknown>,
  fields: string[],
  logger: LoaderContext["logger"] | { warn: (message: string) => void },
): Promise<Record<string, string>> {
  // Un cache-hit es solo una lectura de disco; solo las llamadas reales a la
  // API de DeepL necesitan serializarse, y eso ya lo hace la cola
  // modulo-level de deeplTranslationCache.ts sin importar cuantos campos
  // pidan traduccion al mismo tiempo. Recorrer los campos en serie aqui solo
  // frenaba el caso cache-hit (la mayoria de un build ya cacheado) sin
  // ninguna ganancia de rate-limit.
  const entries = await Promise.all(
    fields.map(async (field) => {
      const value = raw[field];
      if (typeof value !== "string" || !value) return null;
      return [field, await translateCached(value, "EN-US", logger)] as const;
    }),
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null));
}

// --- Fabrica de loaders para data sources ------------------------------------

function createDataSourceLoader(
  name: string,
  fetchFn: () => Promise<PageObjectResponse[]>,
  mapFn: (page: PageObjectResponse) => Record<string, unknown> | Promise<Record<string, unknown>>,
  idFn: (page: PageObjectResponse, data: Record<string, unknown>) => string,
  // Campos del shape mapeado que llevan una URL de Notion (S3 firmada,
  // expira en ~1h): se descargan y se reemplazan por una copia local antes
  // de guardarse, para que el HTML de produccion nunca dependa de una firma
  // que puede expirar entre un build y la siguiente visita.
  imageFields: string[] = [],
  // Campos de texto que se traducen a ingles (DeepL, cacheado) y se guardan
  // en `raw.en`, para la version /en/* del sitio. Prosa simple unicamente —
  // el singleton `siteCopy` (home S1-S8) NO pasa por aqui: su markdown tiene
  // estructura que depende de matches literales en espanol (ver
  // src/pages/index.astro), asi que su traduccion ocurre a nivel de hoja
  // (strings ya parseados), no sobre el markdown crudo pre-parseo.
  translatableFields: string[] = [],
): Loader {
  return {
    name,
    load: async ({ store, logger, parseData }: LoaderContext) => {
      store.clear();
      if (!hasNotionToken()) {
        if (import.meta.env.PROD) {
          throw new Error(
            `[${name}] NOTION_TOKEN requerido para el build de produccion. ` +
              "Configura el secret antes de desplegar.",
          );
        }
        logger.warn(
          `[${name}] NOTION_TOKEN ausente: coleccion vacia (scaffolding en dev). ` +
            "Define .env para leer contenido real.",
        );
        return;
      }
      const pages = await fetchFn();
      // fetchBlockChildren (dentro de mapFn) y cacheNotionImage son I/O de red
      // independientes por ficha: procesarlas 100% secuencial es la causa
      // directa de los 90-115s de build con ~29 fichas. Concurrencia acotada
      // (no ilimitada, para no saturar la API de Notion) recorta ese tiempo
      // sin tocar la traduccion DeepL, que ya se serializa sola via la cola
      // modulo-level de deeplTranslationCache.ts (enqueue) sin importar cuantas
      // llamadas concurrentes le lleguen.
      await mapWithConcurrency(pages, LOADER_CONCURRENCY, async (page) => {
        const raw = await mapFn(page);
        const id = idFn(page, raw);
        for (const field of imageFields) {
          const value = raw[field];
          if (typeof value === "string" && value) {
            raw[field] = await cacheNotionImage(value, `${name}-${id}-${field}`, logger);
          } else if (Array.isArray(value)) {
            const cached = await Promise.all(
              value.map((url, index) =>
                typeof url === "string" && url
                  ? cacheNotionImage(url, `${name}-${id}-${field}-${index}`, logger)
                  : Promise.resolve(undefined),
              ),
            );
            raw[field] = cached.filter((url): url is string => Boolean(url));
          }
        }
        if (translatableFields.length > 0) {
          raw.en = await translateFields(raw, translatableFields, logger);
        }
        const data = await parseData({ id, data: raw });
        store.set({ id, data });
      });
      logger.info(`[${name}] ${pages.length} entradas cargadas desde Notion.`);
    },
  };
}

/** Coleccion `cases`: id = page.id de Notion (estable, unico). */
// Fuente unica de que campos se traducen: content.config.ts construye el
// schema Zod de `en` a partir de estos mismos arreglos (antes eran 2 listas
// literales independientes, sin garantia de sincronia entre loader y schema).
export const CASE_TRANSLATABLE_FIELDS = [
  "title",
  "resultHeadline",
  "cardHeadline",
  "cardContext",
  "objective",
  "resultsAndActions",
  "anchorMetric",
  "body",
  "reflection",
] as const;

export const METRIC_TRANSLATABLE_FIELDS = [
  "metric",
  "canonicalClaim",
  "mandatoryQualifier",
  "usageNote",
] as const;

export const casesLoader: Loader = createDataSourceLoader(
  "notion-cases",
  fetchCases,
  mapCase,
  (page) => page.id,
  ["banner", "logo", "evidenceMedia"],
  [...CASE_TRANSLATABLE_FIELDS],
);

/** Coleccion `metrics`: id = slug (kebab-case, llave primaria de facto). */
export const metricsLoader: Loader = createDataSourceLoader(
  "notion-metrics",
  fetchMetrics,
  mapMetric,
  (_page, data) => String(data.slug ?? ""),
  [],
  [...METRIC_TRANSLATABLE_FIELDS],
);

/** Coleccion `imageSlots`: id = Slot (title, llave tecnica unica del contrato). */
export const imageSlotsLoader: Loader = createDataSourceLoader(
  "notion-image-slots",
  fetchImageSlots,
  mapImageSlot,
  (_page, data) => String(data.slot ?? ""),
  ["imageUrl"],
);

/** Singleton `siteCopy`: id fijo `site`; cuerpo aplanado a Markdown. */
export const siteCopyLoader: Loader = {
  name: "notion-site-copy",
  load: async ({ store, logger, parseData }: LoaderContext) => {
    store.clear();
    if (!hasNotionToken()) {
      if (import.meta.env.PROD) {
        throw new Error(
          "[notion-site-copy] NOTION_TOKEN requerido para el build de produccion.",
        );
      }
      logger.warn(
        "[notion-site-copy] NOTION_TOKEN ausente: siteCopy vacio (scaffolding en dev).",
      );
      return;
    }
    const { page, blocks } = await fetchSiteCopy();
    const raw = {
      title: getTitle(page, "title"),
      markdown: blocksToMarkdown(blocks),
    };
    const data = await parseData({ id: "site", data: raw });
    store.set({ id: "site", data });
  },
};
