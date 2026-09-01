/**
 * Cliente de lectura de Notion (build-time) — subproyecto Diego CMS.
 *
 * Autentica contra la API de Notion con un token de integración privado leído
 * SOLO del entorno del servidor (nunca se expone al navegador: este modulo se
 * evalua en build/SSR, no en el cliente). Recupera el contenido CMS de las 3
 * fuentes editoriales canonicas confirmadas en el contrato de datos
 * (`docs/platform/notion-astro-contract.md`).
 *
 * Alcance de esta tarea ("CMS: implementar cliente de lectura de Notion"):
 * solo la lectura autenticada + helpers de extraccion de propiedades. La
 * validacion Zod y los fallos seguros son la tarea siguiente
 * ("CMS: validar contenido con Zod y fallos seguros"); aqui se devuelven datos
 * crudos normalizados, sin validar contra un schema.
 */
import { Client, collectPaginatedAPI, isFullBlock, isFullPage } from "@notionhq/client";
import type {
  BlockObjectResponse,
  PageObjectResponse,
} from "@notionhq/client";
import { readEnvVar } from "../utils/env.ts";

/**
 * IDs de las 3 fuentes editoriales canonicas del CMS.
 * Fuente: `docs/platform/notion-astro-contract.md` (verificado 2026-07-19).
 * - `cases` y `metrics` son data sources (se consultan con dataSources.query).
 * - `siteCopy` es una pagina singleton (se recupera pagina + bloques).
 */
export const NOTION_SOURCES = {
  cases: "88257bc9-e575-45e8-90df-f851f96e92f2",
  siteCopy: "d9ab8508-660a-43e8-ac45-9386dd7903d9",
  metrics: "213ea2d0-bffc-41b9-9877-92132551461c",
  // Base "🖼️ CMS Imágenes — Portafolio D" (2026-07-25): slots de imagen que
  // hoy viven hardcodeados en el codigo (foto de Diego, logos de trust bar).
  imageSlots: "8dda9726-a42d-407d-ba84-334b4a1ef7a1",
} as const;

/** True si hay un NOTION_TOKEN disponible en el entorno (no valida que sea correcto). */
export function hasNotionToken(): boolean {
  return Boolean(readEnvVar("NOTION_TOKEN"));
}

/**
 * Lee el token de integracion de Notion del entorno del servidor.
 * Falla fuerte si no existe: sin token no hay lectura de CMS posible.
 */
function getNotionToken(): string {
  const token = readEnvVar("NOTION_TOKEN");
  if (!token) {
    throw new Error(
      "[notionClient] Falta NOTION_TOKEN. Define la variable de entorno antes del build " +
        "(local: archivo .env en la raiz; CI: secret NOTION_TOKEN en GitHub Actions). " +
        "La integracion es de solo lectura y su token lo administra Diego.",
    );
  }
  return token;
}

let cachedClient: Client | null = null;

/** Devuelve un cliente de Notion memozado (una sola instancia por build). */
export function getNotionClient(): Client {
  if (!cachedClient) {
    cachedClient = new Client({ auth: getNotionToken() });
  }
  return cachedClient;
}

// --- Helpers de extraccion de propiedades ------------------------------------
// Notion devuelve cada propiedad como un objeto discriminado por `type`. Estos
// helpers extraen el valor plano de forma segura; devuelven un default neutro si
// la propiedad no existe o es de otro tipo (la validacion estricta es Zod, luego).

type NotionProperties = PageObjectResponse["properties"];
type NotionProperty = NotionProperties[string];

function getProp(
  page: PageObjectResponse,
  name: string,
): NotionProperty | undefined {
  return page.properties[name];
}

/** Concatena los `plain_text` de un arreglo de rich text de Notion. */
function richTextToPlain(
  richText: ReadonlyArray<{ plain_text: string }> | undefined,
): string {
  if (!richText) return "";
  return richText.map((item) => item.plain_text).join("");
}

/** title -> string plano. */
export function getTitle(page: PageObjectResponse, name: string): string {
  const prop = getProp(page, name);
  if (prop?.type !== "title") return "";
  return richTextToPlain(prop.title);
}

/** rich_text (texto) -> string plano. */
export function getRichText(page: PageObjectResponse, name: string): string {
  const prop = getProp(page, name);
  if (prop?.type !== "rich_text") return "";
  return richTextToPlain(prop.rich_text);
}

/** select -> nombre de la opcion o `undefined`. */
export function getSelect(
  page: PageObjectResponse,
  name: string,
): string | undefined {
  const prop = getProp(page, name);
  if (prop?.type !== "select") return undefined;
  return prop.select?.name;
}

/** multi_select -> arreglo de nombres de opcion (vacio si no aplica). */
export function getMultiSelect(
  page: PageObjectResponse,
  name: string,
): string[] {
  const prop = getProp(page, name);
  if (prop?.type !== "multi_select") return [];
  return prop.multi_select.map((option) => option.name);
}

/** checkbox -> boolean (false si no aplica). */
export function getCheckbox(page: PageObjectResponse, name: string): boolean {
  const prop = getProp(page, name);
  if (prop?.type !== "checkbox") return false;
  return prop.checkbox;
}

/** number -> valor numerico o `undefined` (celda vacia o de otro tipo). */
export function getNumber(page: PageObjectResponse, name: string): number | undefined {
  const prop = getProp(page, name);
  if (prop?.type !== "number") return undefined;
  return prop.number ?? undefined;
}

/** url -> string o `undefined`. */
export function getUrl(
  page: PageObjectResponse,
  name: string,
): string | undefined {
  const prop = getProp(page, name);
  if (prop?.type !== "url") return undefined;
  return prop.url ?? undefined;
}

/** relation -> arreglo de IDs de paginas relacionadas (vacio si no aplica). */
export function getRelationIds(
  page: PageObjectResponse,
  name: string,
): string[] {
  const prop = getProp(page, name);
  if (prop?.type !== "relation") return [];
  return prop.relation.map((relation) => relation.id);
}

/** status -> nombre de la opcion o `undefined`. */
export function getStatus(
  page: PageObjectResponse,
  name: string,
): string | undefined {
  const prop = getProp(page, name);
  if (prop?.type !== "status") return undefined;
  return prop.status?.name;
}

/** files -> arreglo de URLs (externas o de archivo subido). */
export function getFileUrls(page: PageObjectResponse, name: string): string[] {
  const prop = getProp(page, name);
  if (prop?.type !== "files") return [];
  return prop.files
    .map((file) =>
      file.type === "external" ? file.external.url : file.type === "file" ? file.file.url : undefined,
    )
    .filter((url): url is string => Boolean(url));
}

// --- Lectura de bloques (para la pagina siteCopy) ----------------------------

/**
 * Recupera recursivamente todos los bloques hijos de un bloque o pagina.
 * Pagina automaticamente y desciende a bloques con `has_children`.
 *
 * NO desciende a `child_page` ni `child_database`: son paginas separadas, no
 * cuerpo de esta pagina. Sin este corte, el singleton siteCopy arrastraba el
 * contenido de sus paginas hermanas archivadas ("Obsoleto · Secciones
 * reemplazadas el 24 jul 2026"), cuyos headings usan las mismas claves S1..S8
 * y terminaban pisando al copy vigente.
 */
const NON_BODY_BLOCK_TYPES = new Set(["child_page", "child_database"]);

/**
 * Descarta bloques `child_page`/`child_database` de una tanda de hijos ya
 * paginada. Extraida como funcion pura para poder testear la regla que causo
 * el incidente de paginas hermanas archivadas sin mockear la API de Notion.
 */
export function filterBodyBlocks(blocks: BlockObjectResponse[]): BlockObjectResponse[] {
  return blocks.filter((block) => !NON_BODY_BLOCK_TYPES.has(block.type));
}

export async function fetchBlockChildren(
  blockId: string,
): Promise<BlockObjectResponse[]> {
  const notion = getNotionClient();
  const children = await collectPaginatedAPI(notion.blocks.children.list, {
    block_id: blockId,
  });
  const fullBlocks = children.filter(isFullBlock);
  const bodyBlocks = filterBodyBlocks(fullBlocks);
  const result: BlockObjectResponse[] = [];
  for (const block of bodyBlocks) {
    result.push(block);
    if (block.has_children) {
      const nested = await fetchBlockChildren(block.id);
      result.push(...nested);
    }
  }
  return result;
}

// --- Lectura de las 3 fuentes ------------------------------------------------

/** Todas las fichas de la base `SSOT - Portafolio Proyectos` (colecc. cases). */
export async function fetchCases(): Promise<PageObjectResponse[]> {
  try {
    const notion = getNotionClient();
    const rows = await collectPaginatedAPI(notion.dataSources.query, {
      data_source_id: NOTION_SOURCES.cases,
    });
    return rows.filter(isFullPage);
  } catch (err) {
    console.error("NOTION ERROR:", err);
    throw err;
  }
}

/** Todas las filas de la base `Metricas oficiales` (colecc. metrics). */
export async function fetchMetrics(): Promise<PageObjectResponse[]> {
  const notion = getNotionClient();
  const rows = await collectPaginatedAPI(notion.dataSources.query, {
    data_source_id: NOTION_SOURCES.metrics,
  });
  return rows.filter(isFullPage);
}

/** Todas las filas de la base `🖼️ CMS Imágenes — Portafolio D` (colecc. imageSlots). */
export async function fetchImageSlots(): Promise<PageObjectResponse[]> {
  const notion = getNotionClient();
  const rows = await collectPaginatedAPI(notion.dataSources.query, {
    data_source_id: NOTION_SOURCES.imageSlots,
  });
  return rows.filter(isFullPage);
}

export interface SiteCopy {
  page: PageObjectResponse;
  blocks: BlockObjectResponse[];
}

/** Pagina singleton `Copy Oficial · diegomaury.mx (SSOT)` + su arbol de bloques. */
export async function fetchSiteCopy(): Promise<SiteCopy> {
  const notion = getNotionClient();
  const page = await notion.pages.retrieve({ page_id: NOTION_SOURCES.siteCopy });
  if (!isFullPage(page)) {
    throw new Error(
      "[notionClient] La pagina siteCopy no devolvio un objeto completo. " +
        "Verifica que la integracion tenga acceso a 'Copy Oficial · diegomaury.mx (SSOT)'.",
    );
  }
  const blocks = await fetchBlockChildren(NOTION_SOURCES.siteCopy);
  return { page, blocks };
}
