// Mesmo padrão do squashtenniscenter.
import { createClient } from '@supabase/supabase-js';


// O projeto Supabase (plano Nano) tem só 15 conexões no pool do Postgres.
// Cada aba/usuário podia disparar 10-15 requisições simultâneas (RLS de
// autenticação, notificações, dados da tela), e com poucas pessoas usando
// ao mesmo tempo isso já estourava o pool — requisições travavam por ~20s
// sem nunca terminar (sem timeout). Este fetch limita quantas requisições
// esta aba mantém em voo ao mesmo tempo, enfileirando o resto, para que
// nenhuma aba sozinha consuma o pool inteiro quando várias pessoas
// estiverem conectadas.
const MAX_CONCURRENT_REQUESTS = 2;
// Sem isto, uma requisição travada (rede, contenção momentânea do banco)
// ficava pendurada para sempre — o Promise.all que a espera nunca resolve,
// e a tela fica em "..." indefinidamente, sem erro nenhum. Depois desse
// tempo, desiste e deixa o código tratar como falha (e tentar de novo).
const REQUEST_TIMEOUT_MS = 15000;

function createLimitedFetch(limit: number, timeoutMs: number): typeof fetch {
  let active = 0;
  const queue: Array<() => void> = [];
  const runNext = () => {
    if (active >= limit) return;
    const task = queue.shift();
    if (!task) return;
    active++;
    task();
  };
  return (...args: Parameters<typeof fetch>) =>
    new Promise<Response>((resolve, reject) => {
      queue.push(() => {
        const [input, init] = args;
        const controller = new AbortController();
        const existingSignal = init?.signal;
        if (existingSignal) {
          if (existingSignal.aborted) controller.abort();
          else existingSignal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        fetch(input, { ...init, signal: controller.signal })
          .then(resolve, reject)
          .finally(() => {
            clearTimeout(timer);
            active--;
            runNext();
          });
      });
      runNext();
    });
}

function createSupabaseClient() {
  // Use import.meta.env for client-side (Vite build-time replacement)
  // Fall back to process.env for SSR (server-side rendering)
  const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ['SUPABASE_URL'] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY ? ['SUPABASE_PUBLISHABLE_KEY'] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(', ')}. Configure as variáveis do Supabase.`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: typeof window !== 'undefined' ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    },
    global: {
      fetch: typeof window !== 'undefined' ? createLimitedFetch(MAX_CONCURRENT_REQUESTS, REQUEST_TIMEOUT_MS) : fetch,
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});

