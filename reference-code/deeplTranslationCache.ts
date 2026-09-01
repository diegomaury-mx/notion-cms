/**
 * Traduce texto en build time via la API de DeepL y cachea el resultado en
 * disco por hash de contenido (mismo patron que notionImageCache.ts para
 * imagenes): un texto ya traducido no vuelve a pegarle a la API en el
 * siguiente build. Sin DEEPL_API_KEY configurado, degrada devolviendo el
 * texto original (la version EN del sitio no se rompe, se queda en espanol
 * hasta que la key exista).
 *
 * Incidente 2026-08-17: el primer build con key real disparo cientos de
 * llamadas casi simultaneas (29 casos x ~9 campos + home + portfolio) y el
 * plan Free de DeepL las rechazo en rafaga con HTTP 429 — la mayoria del
 * sitio EN quedo sin traducir (degrado con gracia, no rompio el build, pero
 * tampoco tradujo). Fix: todas las llamadas del proceso se serializan por
 * una cola modulo-level con espaciado minimo entre ellas (`enqueue`), y un
 * 429 se reintenta con backoff (respeta `Retry-After` si DeepL lo manda)
 * antes de degradar.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { LoaderContext } from "astro/loaders";
import { readEnvVar } from "../utils/env.ts";

type Logger = LoaderContext["logger"] | { warn: (message: string) => void };

const DEFAULT_CACHE_DIR = path.join(process.cwd(), "public", "cms-media", "notion", "translations");
const DEEPL_ENDPOINT = "https://api-free.deepl.com/v2/translate";
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_MIN_GAP_MS = 250;

export type DeeplTargetLang = "EN-US";
type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TranslateCachedOptions {
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
  sleepImpl?: Sleep;
  maxRetries?: number;
  minGapMs?: number;
}

function cacheKeyFor(text: string, targetLang: string): string {
  return createHash("sha256").update(`${targetLang}:${text}`).digest("hex");
}

// Cola global del proceso: todas las llamadas a la API de DeepL (de
// cualquier pagina/loader) se encadenan aqui, con un espaciado minimo entre
// el fin de una y el inicio de la siguiente. Es intencional que sea
// modulo-level — un build de Astro es un solo proceso Node, asi que esto
// paca de verdad todo el trafico a DeepL de ese build.
let requestQueue: Promise<void> = Promise.resolve();

function enqueue<T>(sleepImpl: Sleep, minGapMs: number, fn: () => Promise<T>): Promise<T> {
  const result = requestQueue.then(fn, fn);
  requestQueue = result.then(
    () => sleepImpl(minGapMs),
    () => sleepImpl(minGapMs),
  );
  return result;
}

async function fetchTranslation(
  fetchImpl: typeof fetch,
  apiKey: string,
  text: string,
  targetLang: DeeplTargetLang,
  sleepImpl: Sleep,
  maxRetries: number,
  logger: Logger,
): Promise<string> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetchImpl(DEEPL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      // Sin tag_handling: nuestro texto es prosa/markdown plano, no XML/HTML
      // valido. `tag_handling: "xml"` (ver historial) le pide a DeepL
      // parsear el texto COMO XML — cualquier `<`, `>` o `&` suelto en el
      // contenido real (markdown, nombres de organizaciones, etc.) lo vuelve
      // XML mal formado y DeepL responde HTTP 400 sin reintento posible.
      body: JSON.stringify({
        text: [text],
        target_lang: targetLang,
      }),
    });

    if (response.status === 429) {
      if (attempt < maxRetries) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2 ** attempt * 1000;
        logger.warn(
          `[deepl-translation-cache] Rate limit (429), reintento ${attempt + 1}/${maxRetries} en ${retryAfterMs}ms`,
        );
        await sleepImpl(retryAfterMs);
        continue;
      }
      throw new Error("HTTP 429");
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = (await response.json()) as { translations?: { text: string }[] };
    const translated = data.translations?.[0]?.text;
    if (!translated) throw new Error("Respuesta de DeepL sin traducciones");
    return translated;
  }
  throw new Error("HTTP 429");
}

export async function translateCached(
  text: string,
  targetLang: DeeplTargetLang,
  logger: Logger,
  options: TranslateCachedOptions = {},
): Promise<string> {
  if (!text.trim()) return text;

  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const cachePath = path.join(cacheDir, `${cacheKeyFor(text, targetLang)}.txt`);

  try {
    return await readFile(cachePath, "utf-8");
  } catch {
    // cache miss, sigue al fetch
  }

  const apiKey = options.apiKey ?? readEnvVar("DEEPL_API_KEY");
  if (!apiKey) {
    logger.warn(
      "[deepl-translation-cache] DEEPL_API_KEY no configurado, se omite traduccion (el texto se queda en espanol).",
    );
    return text;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS;

  try {
    const translated = await enqueue(sleepImpl, minGapMs, () =>
      fetchTranslation(fetchImpl, apiKey, text, targetLang, sleepImpl, maxRetries, logger),
    );
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cachePath, translated, "utf-8");
    return translated;
  } catch (error) {
    logger.warn(`[deepl-translation-cache] No se pudo traducir texto: ${(error as Error).message}`);
    return text;
  }
}
