/**
 * Cloudflare Worker: notion-deploy-relay
 *
 * Snapshot de referencia (obtenido de Cloudflare el 2026-08-31 vía
 * `workers_get_worker_code`). Este Worker NO vive en el repo `newlandingpage`
 * ni en este repo como código desplegable: su fuente de verdad es el proyecto
 * de Cloudflare Workers en la cuenta `Diegoraul.maury@gmail.com's Account`.
 *
 * Qué hace: recibe la suscripción nativa de webhooks de Notion sobre las 3
 * fuentes editables del CMS (SSOT casos, CMS Imágenes, Copy Oficial), valida
 * la firma HMAC-SHA256 y, si es válida, dispara el Deploy Hook de Cloudflare
 * Pages — un cambio hecho SOLO en Notion reconstruye el sitio sin push.
 *
 * Secrets (guardados en el Worker, nunca en un repo):
 *   NOTION_WEBHOOK_SECRET  — secreto compartido con la suscripción de Notion
 *   DEPLOY_HOOK_URL        — Deploy Hook del proyecto Pages `newlandingpage`
 *                            (apuntado explícitamente a "notion-cms-rebuild")
 * Binding:
 *   RELAY_KV               — KV namespace; guarda el verification_token del
 *                            handshake inicial de Notion
 */
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

    // Handshake inicial: Notion manda un verification_token una sola vez al
    // crear la suscripción. Se guarda en KV para copiarlo a la config de la
    // integración; no lleva firma todavía.
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

    // Una sola llamada al Deploy Hook por request. Notion emite un evento de
    // webhook independiente por cada propiedad/bloque que cambia en una sola
    // edición, así que una edición grande dispara varias llamadas aquí — es el
    // volumen esperado, no un bug.
    const deployResponse = await fetch(env.DEPLOY_HOOK_URL, { method: "POST" });
    console.log("Deploy hook triggered, status:", deployResponse.status);

    return new Response("OK", { status: 200 });
  },
};

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
