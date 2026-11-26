export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("X-Notion-Signature");

    let parsed = null;
    try {
      parsed = JSON.parse(rawBody);
    } catch (e) {
      parsed = null;
    }

    if (parsed && parsed.verification_token) {
      console.log("Notion webhook verification payload received");
      try {
        await env.RELAY_KV.put("verification_token", parsed.verification_token);
      } catch (e) {
        console.log("KV put failed:", e.message);
      }
      return new Response("OK", { status: 200 });
    }

    if (!signature) {
      return new Response("Missing signature", { status: 400 });
    }

    if (!env.NOTION_WEBHOOK_SECRET) {
      console.log("NOTION_WEBHOOK_SECRET not configured yet; rejecting signed event");
      return new Response("Secret not configured yet", { status: 503 });
    }

    const expected = await hmacSha256Hex(env.NOTION_WEBHOOK_SECRET, rawBody);
    if (("sha256=" + expected) !== signature) {
      return new Response("Invalid signature", { status: 401 });
    }

    if (!parsed) {
      return new Response("Bad payload", { status: 400 });
    }

    console.log("Notion event received:", parsed.type);

    if (isEventsSource(parsed)) {
      if (!isRelevantEventsChange(parsed)) {
        console.log("Events change ignored (no public property touched):", parsed.type);
        return new Response("OK", { status: 200 });
      }
      // Debounce trailing: el Cron de 5 min dispara el build una sola vez.
      await env.RELAY_KV.put(PENDING_KEY, new Date().toISOString());
      console.log("Events rebuild marked pending:", parsed.type);
      return new Response("OK", { status: 200 });
    }

    const deployResponse = await fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
    console.log("Deploy hook triggered, status:", deployResponse.status);
    // Este build ya incluye cualquier cambio pendiente de eventos.
    await env.RELAY_KV.delete(PENDING_KEY);

    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    if (!env.DEPLOY_HOOK_URL) {
      console.log("DEPLOY_HOOK_URL not configured; skipping scheduled rebuild");
      return;
    }
    if (event.cron === FLUSH_CRON) {
      // Flush del debounce de eventos: solo si hay cambios pendientes.
      const pending = await env.RELAY_KV.get(PENDING_KEY);
      if (!pending) return;
      await env.RELAY_KV.delete(PENDING_KEY);
      const r = await fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
      console.log("Debounced events rebuild triggered, status:", r.status);
      if (!r.ok) await env.RELAY_KV.put(PENDING_KEY, pending); // reintenta en 5 min
      return;
    }
    // Rebuild diario: mantiene el HTML/SEO servido al dia (la agenda /eventos
    // deja de listar eventos ya sucedidos aunque nadie edite Notion ni haga push).
    const r = await fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
    console.log("Scheduled rebuild triggered (cron " + event.cron + "), status:", r.status);
    // Este build ya incluye cualquier cambio pendiente de eventos: evita un build duplicado en el siguiente flush.
    if (r.ok) await env.RELAY_KV.delete(PENDING_KEY);
  },
};

const PENDING_KEY = "events_rebuild_pending";
const FLUSH_CRON = "*/5 * * * *";

const norm = (id) => String(id || "").replace(/-/g, "").toLowerCase();
const EVENTS_PARENT_IDS = new Set([
  norm("d8a0aaf3-ebb5-4ee0-8add-4b830b8a2350"), // database
  norm("7c2e4e81-be2f-428c-ad64-73c05beea6b5"), // data source
]);

// Propiedades que lee mapEvent (src/services/notionEvents.ts), IDs decodificados.
// Si mapEvent lee otra propiedad, agregar su ID aqui.
const EVENTS_PUBLIC_PROPERTY_IDS = new Set([
  "title", "xY=Z", "aQIg", "`deh", "l>\\a", "eU[", "=Qzf",
  "dKpJ", "gU^`", "alLa", "l_<R", "UVgN",
]);
const EVENTS_STRUCTURAL_TYPES = new Set([
  "page.created", "page.deleted", "page.undeleted", "page.moved",
]);

function parentIds(parsed) {
  const p = (parsed && parsed.data && parsed.data.parent) || {};
  return [p.id, p.data_source_id, p.database_id].map(norm).filter(Boolean);
}

function isEventsSource(parsed) {
  return parentIds(parsed).some((id) => EVENTS_PARENT_IDS.has(id));
}

function decodeId(id) {
  try { return decodeURIComponent(id); } catch (e) { return id; }
}

function isRelevantEventsChange(parsed) {
  if (EVENTS_STRUCTURAL_TYPES.has(parsed.type)) return true;
  if (parsed.type !== "page.properties_updated") return false; // content_updated, locked, etc.: el loader no lee el body
  const updated = (parsed.data && parsed.data.updated_properties) || [];
  // Sin lista de propiedades no se puede descartar: se trata como relevante.
  if (updated.length === 0) return true;
  return updated.some((id) => EVENTS_PUBLIC_PROPERTY_IDS.has(decodeId(id)));
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
