/**
 * Lê uma variável de ambiente/secret do lado do servidor. `process.env`
 * funciona pra alguns bindings do Cloudflare Workers, mas não pra outros
 * dependendo do tipo — o runtime do Worker sempre expõe os bindings via
 * um global próprio (`globalThis.__env__`, setado pelo handler do nitro
 * em cada request), então usamos isso como reforço caso `process.env`
 * volte vazio.
 */
export function getServerEnv(name: string): string | undefined {
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess;
  const cfEnv = (globalThis as unknown as { __env__?: Record<string, string> }).__env__;
  return cfEnv?.[name];
}

/**
 * Igual a getServerEnv, mas também sabe ler bindings do "Secrets Store"
 * do Cloudflare — esses não chegam como string direto em
 * globalThis.__env__[name], vêm como um objeto com um método .get()
 * assíncrono (diferente do binding clássico de secret/var, que já é
 * string). Usa essa versão só onde a variável foi configurada por lá.
 */
export async function getServerSecret(name: string): Promise<string | undefined> {
  const fromProcess = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess;
  const cfEnv = (globalThis as unknown as { __env__?: Record<string, unknown> }).__env__;
  const raw = cfEnv?.[name];
  if (typeof raw === "string") return raw || undefined;
  if (raw && typeof (raw as { get?: unknown }).get === "function") {
    try {
      const value = await (raw as { get: () => Promise<string> }).get();
      return value || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
