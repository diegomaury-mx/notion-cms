# diagrams/

Los diagramas viven como bloques `mermaid` dentro de la documentación (GitHub
los renderiza nativamente). Índice:

| Diagrama | Dónde |
|---|---|
| Sistema completo (fuentes → build → hosting + Worker) | [README](../README.md#el-sistema-en-una-imagen) |
| Componentes del pipeline (client, loaders, servicios, validación) | [01 · Arquitectura](../docs/01-architecture.md#diagrama-de-componentes) |
| Flujo de una imagen (S3 firmada → cache-hit → sharp → WebP) | [03 · Pipeline de imágenes](../docs/03-image-pipeline.md#la-solución) |
| Flujo de una traducción (cache → cola → DeepL → backoff) | [04 · Pipeline de traducción](../docs/04-translation-pipeline.md#cómo-fluye) |
| Secuencia de auto-publicación (webhook → HMAC → Deploy Hook) | [06 · Auto-publicación](../docs/06-auto-publish.md#la-solución) |

Para exportar uno como imagen: pegar el bloque en <https://mermaid.live> o usar
`@mermaid-js/mermaid-cli` (`mmdc -i entrada.mmd -o salida.svg`).
