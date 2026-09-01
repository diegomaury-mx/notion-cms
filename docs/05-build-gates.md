# 05 · Gates de build

El sistema tiene tres mecanismos que impiden publicar contenido no verificado. Los dos primeros corren dentro de `astro build`; el tercero es un verificador manual pre-commit.

## Gate 1 · Doble condición de publicación

Una ficha de caso aparece en el sitio **solo si**:

```
draft === false   ⟺   Estado publicación === "Publicado"  AND  Publicable === true
```

Ambos son necesarios. `Estado publicación = Publicado` **no basta por sí solo**, en ninguna capa (Insignia ni Soporte). El checkbox `Publicable` es un segundo gate independiente.

> Confusión real (2026-08-21): una ficha nueva con `Estado publicación = Publicado` no salía en `/portfolio` porque `Publicable` seguía sin marcar. Ante "publiqué X y no sale", verificar `Publicable` primero.

Astro nunca expone una ficha con `draft = true` en rutas públicas, sitemap ni `llms.txt`.

## Gate 2 · Guardrail Insignia (`superRefine`)

En `content.config.ts`, el schema de `cases` tiene un `.superRefine()`:

```ts
if (data.layer === 'Insignia' && !data.draft) {
  if (!data.anchorMetric.trim())  ctx.addIssue({ path: ['anchorMetric'], … });
  if (!data.evidenceUrl)          ctx.addIssue({ path: ['evidenceUrl'], … });
}
```

Una ficha **Insignia** publicada sin métrica ancla **o** sin evidencia hace que `parseData()` lance → **el build entero falla** → Cloudflare Pages no despliega → el sitio anterior sigue vivo.

Una ficha **Soporte** puede publicarse sin métrica ancla. No es un bloqueo; algunas fichas declaran explícitamente "Sin cifras registradas" y eso es correcto.

## Gate 3 · Verificador de métricas (`verify-metrics.cjs`)

Verificador **bloqueante manual**, se corre antes de commitear cifras y se exige `exit 0`. Es `.cjs` (no `.js`) porque `package.json` tiene `"type": "module"` — un `.js` con `require()` reventaría antes de validar nada.

```
node tools/verify-metrics.cjs           # espejo por defecto: assets/data/metrics.json
node --test tools/verify-metrics.test.cjs
```

Opera sobre el HTML estático de `public/` (stubs de redirect de casos legacy) y sobre `llms.txt` / `llms-full.txt`. Para cada `<tag data-metric="slug">texto</tag>`:

| Chequeo | Falla si |
|---|---|
| slug existe | `data-metric` no está en `metrics.json` |
| valor coincide | el texto publicado ≠ `metrics.json.valor` |
| estado publicable | estado ≠ `Vigente` y ≠ `Condicionada` |
| publicabilidad | `publicabilidad` ≠ `Pública` |
| superficie permitida | la superficie del archivo no está en `superficies` de la métrica |
| calificador obligatorio | ninguna `calificadorClave` aparece a < 400 caracteres del número (**match por substring de raíz**, ej. `"estimad"` → `"estimada"`) |
| cifra retirada | un `patronProhibido` de una métrica `Retirada` aparece en el archivo |

Warnings (no bloquean): cifras en texto plano que no matchean ninguna métrica `Vigente`/`Condicionada` (posibles huérfanas), números sin `data-metric` en HTML.

`metrics.json` es un **espejo generado** desde Notion — no se edita a mano. SOP: sincronizar Notion → `metrics.json` → resolver placeholders `{{metrica:slug}}` → `verify-metrics.cjs` hasta exit 0 → commit.

## Gate de token (no es validación de contenido, pero aborta el build)

Sin `NOTION_TOKEN` en un build de producción (`import.meta.env.PROD`), cada loader lanza inmediatamente:

```
[notion-cases] NOTION_TOKEN requerido para el build de produccion.
```

Es deliberado: nunca se publica un sitio vacío. En dev sin token, la colección queda vacía y el build sigue (permite generar tipos y montar el scaffold sin credenciales).

## Lo que estos gates NO cubren

- La versión **EN** de las métricas: `verify-metrics.cjs` no valida que la traducción DeepL del `mandatoryQualifier` preservó el calificador. Riesgo aceptado (2026-08-17).
- Un bloque nativo `ai_block` de Notion en el body de cualquier ficha rompe **todos** los rebuilds con `Block type ai_block is not supported via the API for your bot type`. No hay gate que lo prevenga; ver [07 · Runbook](07-runbook.md).
