# 09 · Cómo replicar este CMS en otro proyecto

Guía para montar el mismo patrón (Notion como CMS → Astro estático → Cloudflare Pages, con auto-publicación) en un sitio nuevo. Cada paso apunta al archivo de [`reference-code/`](../reference-code/) que lo resuelve en `diegomaury.mx`. Tiempo realista para un sitio con 2-3 fuentes: un día de trabajo.

## 0. Decide si este patrón te sirve

Sirve si:

- Hay **un editor** (o pocos de confianza) y el contenido cambia de vez en cuando, no cada minuto.
- Quieres HTML estático: sin servidor, sin base de datos y sin costo de runtime.
- Toleras que un cambio en Notion tarde entre 2 y 3 minutos en verse (lo que dura el rebuild).

No sirve si necesitas contenido por usuario, búsquedas en vivo, cientos de editores o publicación instantánea.

## 1. Modela el contenido en Notion

Una **base de datos (data source) por tipo de contenido repetido** y una **página singleton** para el copy de páginas únicas.

| Necesidad | Forma en Notion | Ejemplo aquí |
|---|---|---|
| Elementos repetidos con campos iguales | data source | casos, métricas, testimonios, eventos |
| Texto largo de páginas únicas | página con encabezados codificados (`# S1 · Hero`) | Copy Oficial |
| Imágenes que hoy están en el código | data source "slots" (`Slot` + `Imagen` + `Estado`) | CMS Imágenes |

Reglas de modelado que te ahorran incidentes:

1. **Dos gates de publicación**, no uno: un estado (`Publicado`) **y** un checkbox (`Publicable`). Así se separan "terminado" y "autorizado para salir".
2. **Llaves técnicas estables y separadas del título visible**: `Slug`, `Slot` o el código de sección `S1`. Un renombre del título no debe romper URLs ni anclas.
3. **Nada de cifras sueltas en el copy.** Las cifras viven en su propia base con calificador y grado de evidencia, y el copy las referencia.
4. **Videos como link externo** (YouTube/Drive), nunca como archivo subido: Cloudflare Pages rechaza assets de más de 25MB.
5. Evita los bloques `ai_block` ("Ask AI" sin convertir a texto): la API no los soporta y rompen el build.

## 2. Crea la integración de Notion

1. notion.so/profile/integrations → nueva integración **interna** con permisos de **solo lectura**.
2. En cada base o página fuente: `•••` → Connections → agrega la integración. Si una fuente no está compartida, el build de producción falla.
3. Fija la **versión de API** de la integración en la más reciente y habilita todos los eventos de webhook. Con una versión vieja, reemplazar un archivo no emite evento ([06](06-auto-publish.md)).
4. Guarda el token como `NOTION_TOKEN`. Nunca lo versiones en el repo.

## 3. Scaffold de Astro

```bash
npm create astro@latest
npm i @notionhq/client sharp
```

`astro.config.mjs` con `output: 'static'` y `site:` con tu dominio. Copia como punto de partida:

| Archivo de `reference-code/` | Qué te llevas | Qué cambias |
|---|---|---|
| `env.ts` | `readEnvVar()` (process.env → import.meta.env) | nada |
| `notionClient.ts` | cliente + helpers `getTitle/getSelect/getMultiSelect/getRichText/getUrl/getFileUrls/...`, `fetchBlockChildren`, `blocksToMarkdown` | `NOTION_SOURCES` con **tus** IDs |
| `notionLoaders.ts` | `createDataSourceLoader()` (fábrica), loader de singleton, `translateFields()` | los `map*` de cada fuente |
| `content.config.ts` | patrón de schema Zod + `superRefine` + `translatableEnSchema` | tus campos |
| `notionImageCache.ts` | descarga + WebP + allowlist de hosts | carpeta de destino si quieres |
| `deeplTranslationCache.ts` | traducción con cache por hash + cola + backoff | solo si tu sitio es bilingüe |

## 4. Un loader por fuente

Para cada data source:

```ts
// notionLoaders.ts
function mapThing(page: PageObjectResponse) {
  return {
    title: getTitle(page, "title"),
    status: getSelect(page, "Estado"),
    publishable: getCheckbox(page, "Publicable"),
    cover: getFileUrls(page, "Cover")[0],
    draft: !(getSelect(page, "Estado") === "Publicado" && getCheckbox(page, "Publicable")),
  };
}

export const thingsLoader = createDataSourceLoader(
  "notion-things",          // nombre (prefijo de cache de imágenes)
  fetchThings,              // dataSources.query paginado
  mapThing,
  (page) => page.id,        // id estable
  ["cover"],                // campos de imagen a cachear
  ["title"],                // campos a traducir (opcional)
);
```

```ts
// content.config.ts
const things = defineCollection({
  loader: thingsLoader,
  schema: z.object({
    title: z.string().min(1),
    cover: z.string().optional(),
    draft: z.boolean().default(true),
  }),
});
```

Puntos que no son obvios:

- **Los helpers devuelven vacío sin error** cuando una propiedad se renombró o cambió de tipo (select ↔ multi_select). Escribe un test por mapper o revisa `GET /v1/data_sources/{id}` cuando un campo salga vacío.
- **Usa el nombre exacto de la propiedad**, con acentos y sin espacios al final. Un espacio sobrante en el nombre dejó un campo vacío durante meses en este proyecto.
- **Los gates del build van en Zod** (`superRefine`), no en las páginas: así un dato que no cumple bloquea el deploy completo en vez de publicarse a medias.
- **En producción sin token, el loader lanza**. En dev sin token, deja la colección vacía para poder trabajar sin credenciales.
- Si una página singleton tiene subpáginas archivadas, `fetchBlockChildren` **no debe descender** a `child_page`/`child_database`; si lo hace, el contenido viejo pisa al vigente.

## 5. Imágenes

Las URLs de archivos de Notion son firmas S3 que **expiran en ~1h**. Lista cada campo de imagen en `imageFields` del loader: `cacheNotionImage` la descarga en build, la convierte a WebP (≤1600px, calidad 82) y devuelve una ruta local. **Versiona la carpeta de cache** en git (excepción en `.gitignore`); si no, cada build en CI clona limpio y reprocesa todo. Detalle: [03](03-image-pipeline.md).

## 6. Traducción (opcional)

Solo si el sitio es bilingüe. `DEEPL_API_KEY` (plan Free: 500k caracteres/mes). **Versiona el cache de traducciones**: sin eso, un día de pruebas agota la cuota. Nunca uses `tag_handling: "xml"`. Si el copy se parsea por texto literal, traduce **después** de parsear, string por string. Detalle: [04](04-translation-pipeline.md).

## 7. Hosting en Cloudflare Pages

1. Crea el proyecto de Pages conectado al repo (Git integration), con el comando `npm run build` y la salida `dist`.
2. Agrega los secrets `NOTION_TOKEN` (y `DEEPL_API_KEY`). **Se configuran por separado para production y preview.**
3. Crea un **Deploy Hook** (Settings → Builds → Deploy hooks) y guarda su URL.
4. Configura el dominio propio.
5. Agrega headers de seguridad en `public/_headers`, que es su **única fuente**. No uses Transform Rules de la zona para lo mismo:

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' <tus terceros>; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
  Strict-Transport-Security: max-age=31536000
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
```

6. En la zona: TLS mínimo 1.2. Agrega `includeSubDomains` a HSTS solo si todos tus subdominios sirven HTTPS.

## 8. Auto-publicación desde Notion

Despliega el Worker de `reference-code/notion-deploy-relay.worker.js`. Lógica completa en [06](06-auto-publish.md).

1. Worker con los secrets `NOTION_WEBHOOK_SECRET` y `DEPLOY_HOOK_URL`, más un binding KV (`RELAY_KV`) para el token de verificación.
2. En la integración de Notion → Webhooks → suscripción apuntando a la URL del Worker. El primer POST trae `verification_token`: el Worker lo guarda en KV, y tú lo copias en Notion para confirmar.
3. El Worker valida `X-Notion-Signature` (HMAC-SHA256 del body crudo) y llama al Deploy Hook.
4. **Bases que se editan en ráfagas** (automatizaciones, sincronizaciones): no dispares un build por evento. Marca una bandera en KV y deja que un cron (`*/5 * * * *`) haga un solo build. Filtra por los IDs de las propiedades que de verdad se publican.
5. Agrega un **cron diario** que dispare el Deploy Hook si tienes contenido que caduca por fecha (eventos, por ejemplo).
6. Después de tocar los schedules, verifica que el cron **realmente se invoca** (GraphQL `workersInvocationsScheduled`). En este proyecto un cron quedó registrado sin dispararse.

## 9. Checklist de arranque

- [ ] Cada fuente está compartida con la integración, y la integración usa la versión de API reciente.
- [ ] `NOTION_TOKEN` está en production **y** en preview.
- [ ] Hay un test por mapper, que confirma los nombres y tipos reales de las propiedades.
- [ ] Gate de publicación doble + guardrail en Zod para el contenido sensible.
- [ ] Todas las imágenes pasan por `imageFields`, y ninguna URL de `prod-files-secure.s3` llega al HTML.
- [ ] El cache de imágenes y el de traducciones están versionados en git.
- [ ] El build termina con `[build] Complete!`. No basta el exit code: un timeout del loader puede salir con 0.
- [ ] `_headers` tiene CSP, HSTS, nosniff y frame-ancestors; la zona tiene TLS ≥1.2.
- [ ] El Worker responde 401 a una firma falsa y 200 a una real; el cron aparece en las invocaciones.
- [ ] Hay un documento como [02](02-notion-data-contract.md) que mapea propiedad → campo. Mantenlo al día: los renombres en Notion fallan en silencio.

## 10. Lo que este patrón no resuelve

- **Varios editores con permisos distintos:** Notion no tiene flujo de aprobación por campo. Aquí lo suple el checkbox `Publicable`.
- **Preview de un borrador antes de publicar:** solo hay `astro dev` local con el token.
- **Validación de contenido traducido:** las cifras en EN no se verifican por código ([05](05-build-gates.md)).
- **Builds lentos con muchas páginas:** traer el cuerpo completo de 30 fichas toma ~90s. Con cientos, hay que cachear bloques por `last_edited_time`.
