import { supabase } from "@/integrations/supabase/client";

/**
 * Roda `tasks` com no máximo `limit` promessas em voo ao mesmo tempo.
 * Disparar dezenas de requisições simultâneas (ex.: todas as páginas de
 * uma tabela grande, de uma vez) pode estourar o limite de conexões do
 * pool do Postgres/PostgREST e deixar algumas requisições penduradas por
 * dezenas de segundos — pior do que a versão sequencial. Isso mantém o
 * ganho de paralelismo sem os picos de fila.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => PromiseLike<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

const DEFAULT_PAGE_CONCURRENCY = 2;

/**
 * Fetch ALL rows from a table, bypassing Supabase's default 1000-row limit
 * by paginating with .range(). Pede a contagem exata na primeira página e
 * busca as páginas restantes com paralelismo limitado (não sequencial, mas
 * também não todas de uma vez) — evita tanto o encadeamento lento quanto
 * os picos de conexões simultâneas em tabelas grandes.
 *
 * Usage:
 *   const rows = await fetchAll("account_entries", "client_id, entry_type, amount");
 */
export async function fetchAll<T = any>(
  table: string,
  columns: string,
  options?: { pageSize?: number; build?: (query: any) => any },
): Promise<T[]> {
  const pageSize = options?.pageSize ?? 1000;
  const build = options?.build ?? ((query: any) => query);
  const first = await build(supabase.from(table as any).select(columns, { count: "exact" })).range(
    0,
    pageSize - 1,
  );
  if (first.error) throw first.error;
  const firstChunk = (first.data ?? []) as T[];
  const total = first.count ?? firstChunk.length;
  if (firstChunk.length < pageSize || total <= pageSize) {
    return firstChunk;
  }
  const totalPages = Math.ceil(total / pageSize);
  const restPages = await runWithConcurrency(
    Array.from({ length: totalPages - 1 }, (_, i) => () => {
      const from = (i + 1) * pageSize;
      const to = from + pageSize - 1;
      return build(supabase.from(table as any).select(columns))
        .range(from, to)
        .then(({ data, error }: { data: T[] | null; error: unknown }) => {
          if (error) throw error;
          return (data ?? []) as T[];
        });
    }),
    DEFAULT_PAGE_CONCURRENCY,
  );
  return [firstChunk, ...restPages].flat() as T[];
}
