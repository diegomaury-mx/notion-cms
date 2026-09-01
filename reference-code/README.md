# reference-code/

> **GENERADO — NO EDITAR A MANO.**
> Estos archivos se regeneran con `npm run sync:notion-cms` desde el repo
> `diegomaury-mx/newlandingpage`. Cualquier edición manual aquí se pierde en la
> siguiente sincronización. La fuente de verdad son `src/services/*`,
> `src/content.config.ts`, `src/utils/env.ts` y `tools/verify-metrics.cjs` de ese
> repo. Ver [`MANIFEST.json`](MANIFEST.json) para el commit y los hashes exactos.

Copias **verbatim** de los archivos reales del pipeline CMS, tomadas del commit
`diegomaury-mx/newlandingpage@2f5fb0c` (2026-08-31). Ya vienen comentadas en el
original (en español).

**No son ejecutables en aislamiento** — dependen de `astro:content`,
`@notionhq/client`, `sharp` y del árbol de `src/` del repo del sitio. Están aquí
para leerse, no para correrse. La fuente de verdad es el repo privado del sitio.

| Archivo | Ruta original en `newlandingpage` | Doc relacionada |
|---|---|---|
| `notionClient.ts` | `src/services/notionClient.ts` | [01](../docs/01-architecture.md), [02](../docs/02-notion-data-contract.md) |
| `notionLoaders.ts` | `src/services/notionLoaders.ts` | [01](../docs/01-architecture.md), [02](../docs/02-notion-data-contract.md) |
| `content.config.ts` | `src/content.config.ts` | [02](../docs/02-notion-data-contract.md), [05](../docs/05-build-gates.md) |
| `notionImageCache.ts` | `src/services/notionImageCache.ts` | [03](../docs/03-image-pipeline.md) |
| `deeplTranslationCache.ts` | `src/services/deeplTranslationCache.ts` | [04](../docs/04-translation-pipeline.md) |
| `env.ts` | `src/utils/env.ts` | [01](../docs/01-architecture.md) |
| `verify-metrics.cjs` | `tools/verify-metrics.cjs` | [05](../docs/05-build-gates.md) |
| `notion-deploy-relay.worker.js` | *(no vive en `newlandingpage`)* — Cloudflare Worker, snapshot vía `workers_get_worker_code` el 2026-08-31 | [06](../docs/06-auto-publish.md) |
