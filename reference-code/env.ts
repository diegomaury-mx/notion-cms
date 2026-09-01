/**
 * Lee una env var sin lanzar. Prefiere `process.env` (scripts standalone via
 * `node --env-file` o CI) y cae a `import.meta.env` (Astro/Vite la inyecta en
 * codigo server-side desde `.env`). Punto unico para no repetir el patron
 * process.env ?? import.meta.env en cada servicio.
 */
export function readEnvVar(name: string): string | undefined {
  const fromViteEnv =
    typeof import.meta !== "undefined"
      ? (import.meta as { env?: Record<string, string | undefined> }).env?.[name]
      : undefined;
  return process.env[name] ?? fromViteEnv;
}
