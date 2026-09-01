// Verificador bloqueante del SSOT de metricas.
// Spec: docs/superpowers/specs/2026-07-15-ssot-metricas-design.md
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function loadMetrics(metricsPath) {
  if (!fs.existsSync(metricsPath)) {
    const e = new Error(`No existe el espejo: ${metricsPath}. Sincroniza Notion -> metrics.json primero.`);
    e.code = 'NO_METRICS';
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  } catch (err) {
    const e = new Error(`JSON malformado en ${metricsPath}: ${err.message}`);
    e.code = 'BAD_METRICS';
    throw e;
  }
  if (!Array.isArray(parsed.metrics)) {
    const e = new Error(`${metricsPath} no tiene el arreglo "metrics".`);
    e.code = 'BAD_METRICS';
    throw e;
  }
  return parsed;
}

function findDataMetrics(html) {
  const out = [];
  const re = /<(\w+)[^>]*\bdata-metric="([^"]+)"[^>]*>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ slug: m[2], texto: m[3].trim(), index: m.index });
  }
  return out;
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineaDe(texto, index) {
  return texto.slice(0, index).split('\n').length;
}

function buscarRetiradas(contenido, fileRel, metrics) {
  const errors = [];
  for (const met of metrics.filter((x) => x.estado === 'Retirada')) {
    const patron = new RegExp(met.patronProhibido || escaparRegex(met.valor), 'gi');
    let m;
    while ((m = patron.exec(contenido)) !== null) {
      errors.push(`${fileRel}: cifra retirada "${met.slug}" presente ("${m[0]}", linea ${lineaDe(contenido, m.index)})`);
    }
  }
  return errors;
}

// Regex creada por llamada (no module-level compartida) para no depender de
// resetear `.lastIndex` a mano en cada punto de uso — un olvido ahi arrastra
// el cursor de una pasada anterior en silencio.
function numeroMatches(texto) {
  return texto.matchAll(/(\+?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\+?\d+(?:\.\d+)?%)/g);
}

function esAnio(numStr) {
  const soloDigitos = numStr.replace(/\D/g, '');
  return /^(19|20)\d{2}$/.test(soloDigitos);
}

// Normaliza para comparar cifras entre metrics.json (ej. "3,000+") y texto libre (ej. "3,000").
function normalizarCifra(s) {
  return s.replace(/[,+$%\s]/g, '');
}

// A diferencia de verifyHtml (que exige data-metric explicito por ocurrencia), en texto plano
// no hay forma de marcar una cifra. El proxy de cobertura es: su valor ya existe en metrics.json
// como metrica Vigente/Condicionada. Lo que no matchea ninguna cifra conocida es huerfana.
function huerfanasEnTexto(texto, fileRel, metrics) {
  const conocidas = new Set(
    metrics
      .filter((m) => m.estado === 'Vigente' || m.estado === 'Condicionada')
      .map((m) => normalizarCifra(m.valor))
  );
  const warnings = [];
  for (const num of numeroMatches(texto)) {
    if (esAnio(num[1])) continue;
    if (conocidas.has(normalizarCifra(num[1]))) continue;
    warnings.push(`${fileRel}: posible cifra sin match en metrics.json: "${num[1]}"`);
  }
  return warnings;
}

function verifyText(texto, fileRel, metrics) {
  return {
    errors: buscarRetiradas(texto, fileRel, metrics),
    warnings: huerfanasEnTexto(texto, fileRel, metrics),
  };
}

// Simplificacion piloto (ajuste 19 del spec): superficie a nivel archivo.
// index.html de raiz se elimino 2026-08-13 (ver CLAUDE.md); el HTML estatico
// que sobrevive vive en public/ (cases/ = stubs de redirect, portfolio/ = 3
// casos legacy reales) y ya no incluye la superficie "Hero".
function superficiesDe(fileRel) {
  const rel = fileRel.replace(/\\/g, '/');
  if (rel.startsWith('cases/') || rel.startsWith('portfolio/')) return ['Caso de estudio'];
  return ['Sitio web'];
}

function verifyHtml(html, fileRel, metrics) {
  const errors = [];
  const warnings = [];
  const porSlug = new Map(metrics.map((x) => [x.slug, x]));
  for (const el of findDataMetrics(html)) {
    const met = porSlug.get(el.slug);
    if (!met) {
      errors.push(`${fileRel}: data-metric "${el.slug}" no existe en metrics.json`);
      continue;
    }
    if (el.texto !== met.valor) {
      errors.push(`${fileRel}: "${el.slug}" publica "${el.texto}" pero el SSOT dice "${met.valor}"`);
    }
    if (met.estado !== 'Vigente' && met.estado !== 'Condicionada') {
      errors.push(`${fileRel}: "${el.slug}" tiene estado "${met.estado}", no publicable`);
    }
    if (met.estado === 'Condicionada' && met.notaUso) {
      warnings.push(`${fileRel}: "${el.slug}" es Condicionada — verificar su nota de uso: ${met.notaUso}`);
    }
    if (met.publicabilidad !== 'Pública') {
      errors.push(`${fileRel}: "${el.slug}" tiene publicabilidad "${met.publicabilidad}", no publicable`);
    }
    const permitidas = superficiesDe(fileRel);
    if (!met.superficies.some((s) => permitidas.includes(s))) {
      errors.push(`${fileRel}: "${el.slug}" no permite esta superficie (permitidas: ${met.superficies.join(', ') || 'ninguna'})`);
    }
    const claves = met.calificadorClaves || [];
    if (claves.length) {
      const ventana = html
        .slice(Math.max(0, el.index - 400), el.index + 400)
        .toLowerCase();
      for (const clave of claves) {
        if (!ventana.includes(clave.toLowerCase())) {
          errors.push(`${fileRel}: "${el.slug}" aparece sin su calificador obligatorio ("${clave}") a menos de 400 caracteres`);
        }
      }
    }
  }
  errors.push(...buscarRetiradas(html, fileRel, metrics));
  // Huerfanas: se excluyen <style> y <script> (valores CSS/JS no son metricas).
  const sinEstilos = html
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  const sinMarcadas = sinEstilos.replace(/<(\w+)[^>]*\bdata-metric="[^"]+"[^>]*>[^<]*<\/\1>/g, ' ');
  const soloTexto = sinMarcadas.replace(/<[^>]+>/g, ' ');
  for (const num of numeroMatches(soloTexto)) {
    if (esAnio(num[1])) continue;
    warnings.push(`${fileRel}: posible metrica sin data-metric: "${num[1]}"`);
  }
  return { errors, warnings };
}

function run(argv, raizOverride) {
  const flagIdx = argv.indexOf('--metrics');
  if (flagIdx !== -1 && !argv[flagIdx + 1]) {
    console.error('[verify-metrics] ERROR: --metrics requiere una ruta, ej. --metrics assets/data/metrics.json');
    return 2;
  }
  const metricsPath = flagIdx !== -1
    ? path.resolve(argv[flagIdx + 1])
    : path.join(__dirname, '..', 'assets', 'data', 'metrics.json');
  const raiz = raizOverride || path.join(__dirname, '..');

  let data;
  try {
    data = loadMetrics(metricsPath);
  } catch (e) {
    console.error(`[verify-metrics] ERROR: ${e.message}`);
    return 2;
  }

  // El HTML estatico que el gate cubre vive en public/ desde 2026-08-13
  // (index.html de raiz se elimino; public/ es lo que Astro copia a dist/).
  const publicDir = path.join(raiz, 'public');
  if (!fs.existsSync(publicDir)) {
    console.error(`[verify-metrics] ERROR: no existe ${publicDir}; nada se verifica en silencio.`);
    return 2;
  }

  const htmlFiles = fs.readdirSync(publicDir).filter((x) => x.endsWith('.html'));
  for (const dir of ['cases', 'portfolio']) {
    const dirAbs = path.join(publicDir, dir);
    if (fs.existsSync(dirAbs)) {
      for (const f of fs.readdirSync(dirAbs).filter((x) => x.endsWith('.html'))) {
        htmlFiles.push(`${dir}/${f}`);
      }
    }
  }
  const textFiles = ['llms.txt', 'llms-full.txt'].filter((f) => fs.existsSync(path.join(raiz, f)));

  const errors = [];
  const warnings = [];
  try {
    for (const rel of htmlFiles) {
      const r = verifyHtml(fs.readFileSync(path.join(publicDir, rel), 'utf8'), rel, data.metrics);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    }
    for (const rel of textFiles) {
      const r = verifyText(fs.readFileSync(path.join(raiz, rel), 'utf8'), rel, data.metrics);
      errors.push(...r.errors);
      warnings.push(...r.warnings);
    }
  } catch (e) {
    console.error(`[verify-metrics] ERROR: archivo ilegible: ${e.message}`);
    return 2;
  }

  for (const w of warnings) console.warn(`[verify-metrics] WARN: ${w}`);
  for (const e of errors) console.error(`[verify-metrics] ERROR: ${e}`);
  console.log(`[verify-metrics] ${errors.length} errores, ${warnings.length} advertencias (espejo del ${data.generatedAt})`);
  return errors.length ? 1 : 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { loadMetrics, findDataMetrics, superficiesDe, verifyHtml, verifyText, run };
