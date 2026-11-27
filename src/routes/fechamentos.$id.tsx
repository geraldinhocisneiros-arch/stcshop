import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadMethods } from "@/lib/data";
import { fmtBRL, fmtDateTime, fmtNum, fmtPct, round2 } from "@/lib/format";
import type { CashSession, CashSummary, PaymentMethod, Sale, SaleLine } from "@/lib/types";
import { toast } from "sonner";
import { Printer } from "lucide-react";

export const Route = createFileRoute("/fechamentos/$id")({
  head: () => ({ meta: [{ title: "Relatório do caixa — Squash Tennis Shop" }] }),
  component: FechamentoReport,
});

interface Movement {
  id: string;
  kind: "sangria" | "suprimento";
  amount: number;
  reason: string | null;
  created_at: string;
}

interface PriceChange {
  id: string;
  old_price: number | null;
  new_price: number;
  changed_by_name: string | null;
  changed_at: string;
  shop_products: { name: string } | null;
}

function FechamentoReport() {
  const { id } = Route.useParams();
  const [session, setSession] = useState<CashSession | null>(null);
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [moves, setMoves] = useState<Movement[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [priceChanges, setPriceChanges] = useState<PriceChange[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [s, sm, sa, li, mv, me, us] = await Promise.all([
          supabase.from("shop_cash_sessions").select("*").eq("id", id).single(),
          supabase.rpc("shop_cash_summary", { p_session_id: id }),
          supabase.from("shop_sales").select("*").eq("session_id", id).order("number"),
          supabase.from("shop_sale_lines").select("*").eq("session_id", id),
          supabase.from("shop_cash_movements").select("*").eq("session_id", id).order("created_at"),
          loadMethods(),
          supabase.from("shop_user_roles").select("user_id, full_name"),
        ]);
        if (s.error) throw s.error;
        setSession(s.data as CashSession);
        setSummary((sm.data as CashSummary) ?? null);
        setSales((sa.data ?? []) as Sale[]);
        setLines((li.data ?? []) as SaleLine[]);
        setMoves((mv.data ?? []) as Movement[]);
        setMethods(me);
        setNames(Object.fromEntries((us.data ?? []).map((u: any) => [u.user_id, u.full_name])));
        // mudanças de preço no cadastro feitas enquanto este caixa esteve aberto
        const sess = s.data as CashSession;
        const pc = await supabase
          .from("shop_price_changes")
          .select("id, old_price, new_price, changed_by_name, changed_at, shop_products(name)")
          .gte("changed_at", sess.opened_at)
          .lte("changed_at", sess.closed_at ?? new Date().toISOString())
          .order("changed_at");
        setPriceChanges((pc.data ?? []) as unknown as PriceChange[]);
      } catch (e) {
        toast.error(errMsg(e));
      }
    })();
  }, [id]);

  const byProduct = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; total: number; cost: number }>();
    for (const l of lines) {
      const r = m.get(l.product_id) ?? { name: l.product_name, qty: 0, total: 0, cost: 0 };
      r.qty += Number(l.qty);
      r.total += Number(l.total);
      r.cost += Number(l.cost_total);
      m.set(l.product_id, r);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [lines]);

  // itens vendidos abaixo do preço de tabela (sem contar o desconto da venda, que aparece à parte)
  const belowList = useMemo(
    () =>
      lines
        .filter((l) => l.list_price != null && Number(l.unit_price) < Number(l.list_price) - 0.009)
        .map((l) => ({ ...l, lost: round2((Number(l.list_price) - Number(l.unit_price)) * Number(l.qty)) }))
        .sort((a, b) => a.sale_number - b.sale_number),
    [lines],
  );
  const lostTotal = round2(belowList.reduce((t, l) => t + l.lost, 0));
  const tracksListPrice = lines.some((l) => l.list_price != null);

  if (!session || !summary) return <AppLayout title="Relatório do caixa">Carregando…</AppLayout>;

  const label = (c: string) => methods.find((m) => m.code === c)?.label ?? c;
  const expected = session.expected ?? summary.expected;
  const counted = session.counted ?? {};
  const codes = Object.keys(expected).filter((k) => Number(expected[k]) !== 0 || k in counted);
  const s = summary.sales;
  const grossProfit = round2(s.total - s.cost - s.fees);
  const canceled = sales.filter((x) => x.status === "cancelada");

  return (
    <AppLayout
      title="Relatório do caixa"
      actions={
        <Button size="sm" variant="outline" onClick={() => window.print()}>
          <Printer className="mr-1 h-4 w-4" /> Imprimir / PDF
        </Button>
      }
    >
      <div className="mx-auto max-w-3xl space-y-4 print:max-w-none">
        <div className="flex items-center gap-4">
          <img src="/logo.webp" alt="" className="h-14" />
          <div>
            <h2 className="text-xl font-bold">Fechamento de caixa {session.status === "aberto" && "(parcial — caixa aberto)"}</h2>
            <p className="text-sm text-muted-foreground">
              Aberto em {fmtDateTime(session.opened_at)} por {names[session.opened_by ?? ""] ?? "—"}
              {session.closed_at && ` · fechado em ${fmtDateTime(session.closed_at)} por ${names[session.closed_by ?? ""] ?? "—"}`}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Box label="Vendas" value={String(s.count)} />
          <Box label="Faturamento" value={fmtBRL(s.total)} />
          <Box label="Ticket médio" value={fmtBRL(s.count ? s.total / s.count : 0)} />
          <Box label="Descontos dados" value={fmtBRL(s.discount)} />
          <Box label="Custo das mercadorias" value={fmtBRL(s.cost)} />
          <Box label="Taxas de cartão" value={fmtBRL(s.fees)} />
          <Box label="Lucro bruto" value={fmtBRL(grossProfit)} hint={fmtPct(s.total ? grossProfit / s.total : 0)} />
          <Box label="Canceladas" value={String(s.canceled)} />
          {tracksListPrice && (
            <Box
              label="Abaixo da tabela"
              value={fmtBRL(lostTotal)}
              hint={belowList.length ? `${belowList.length} ${belowList.length === 1 ? "item" : "itens"} · fora os descontos` : "nenhum item"}
            />
          )}
          {(summary.on_account ?? 0) > 0 && <Box label="Vendido no fiado" value={fmtBRL(summary.on_account)} hint="a receber" />}
          {(summary.secretaria ?? 0) > 0 && (
            <Box label="Lançado na secretaria" value={fmtBRL(summary.secretaria)} hint="repasse da academia" />
          )}
          {summary.receipts && Object.keys(summary.receipts).length > 0 && (
            <Box
              label="Recebido de clientes"
              value={fmtBRL(Object.values(summary.receipts).reduce((t, v) => t + Number(v), 0))}
              hint="dívidas pagas neste caixa"
            />
          )}
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Conferência por forma de pagamento</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Forma</TableHead>
                  <TableHead className="text-right">Vendido</TableHead>
                  <TableHead className="text-right">Recebido de clientes</TableHead>
                  <TableHead className="text-right">Esperado</TableHead>
                  <TableHead className="text-right">Conferido</TableHead>
                  <TableHead className="text-right">Diferença</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {codes.map((c) => {
                  const exp = Number(expected[c] ?? 0);
                  const cnt = c in counted ? Number(counted[c]) : null;
                  const diff = cnt === null ? null : round2(cnt - exp);
                  return (
                    <TableRow key={c}>
                      <TableCell>{label(c)}</TableCell>
                      <TableCell className="text-right">{fmtBRL(summary.by_method[c]?.amount ?? 0)}</TableCell>
                      <TableCell className="text-right">{fmtBRL(summary.receipts?.[c] ?? 0)}</TableCell>
                      <TableCell className="text-right">{fmtBRL(exp)}</TableCell>
                      <TableCell className="text-right">{cnt === null ? "—" : fmtBRL(cnt)}</TableCell>
                      <TableCell className={`text-right ${diff && diff < 0 ? "text-destructive" : ""}`}>
                        {diff === null ? "—" : fmtBRL(diff)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <p className="px-4 py-2 text-xs text-muted-foreground">
              Troco inicial {fmtBRL(session.opening_amount)} · suprimentos {fmtBRL(summary.suprimento)} · sangrias{" "}
              {fmtBRL(summary.sangria)}
            </p>
          </CardContent>
        </Card>

        {session.notes && (
          <Card>
            <CardContent className="pt-4 text-sm">
              <b>Observações:</b> {session.notes}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Produtos vendidos</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Produto</TableHead>
                  <TableHead className="text-right">Qtd</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Lucro bruto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byProduct.map((p) => (
                  <TableRow key={p.name}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="text-right">{fmtNum(p.qty, 2)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(p.total)}</TableCell>
                    <TableCell className="text-right">{fmtBRL(p.total - p.cost)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {belowList.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Vendido abaixo do preço de tabela</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Venda</TableHead>
                    <TableHead>Vendedor</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-right">Qtd</TableHead>
                    <TableHead className="text-right">Tabela</TableHead>
                    <TableHead className="text-right">Vendido</TableHead>
                    <TableHead className="text-right">Deixou de entrar</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {belowList.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap">
                        Nº {l.sale_number} <span className="text-xs text-muted-foreground">{fmtDateTime(l.created_at)}</span>
                      </TableCell>
                      <TableCell>{names[l.sold_by ?? ""] ?? "—"}</TableCell>
                      <TableCell>{l.product_name}</TableCell>
                      <TableCell className="text-right">{fmtNum(l.qty, 2)}</TableCell>
                      <TableCell className="text-right">{fmtBRL(l.list_price)}</TableCell>
                      <TableCell className="text-right">{fmtBRL(l.unit_price)}</TableCell>
                      <TableCell className="text-right font-medium text-destructive">{fmtBRL(l.lost)}</TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell colSpan={6} className="text-right font-medium">
                      Total
                    </TableCell>
                    <TableCell className="text-right font-semibold text-destructive">{fmtBRL(lostTotal)}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p className="px-4 py-2 text-xs text-muted-foreground">
                Tabela = preço que o caixa sugeriu na hora (promoção vigente ou preço do cadastro). O desconto no total da venda não
                entra aqui: está em "Descontos dados".
              </p>
            </CardContent>
          </Card>
        )}

        {priceChanges.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Preços alterados no cadastro durante este caixa</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {priceChanges.map((c) => (
                <div key={c.id} className="flex justify-between gap-2">
                  <span>
                    {fmtDateTime(c.changed_at)} · {c.changed_by_name || "—"} · {c.shop_products?.name ?? "—"}
                  </span>
                  <span
                    className={`whitespace-nowrap tabular-nums ${c.old_price != null && c.new_price < c.old_price ? "text-destructive" : ""}`}
                  >
                    {c.old_price == null ? "—" : fmtBRL(c.old_price)} → {fmtBRL(c.new_price)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {moves.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Sangrias e suprimentos</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {moves.map((m) => (
                <div key={m.id} className="flex justify-between">
                  <span>
                    {fmtDateTime(m.created_at)} · {m.kind === "sangria" ? "Sangria" : "Suprimento"} {m.reason && `— ${m.reason}`}
                  </span>
                  <span className="tabular-nums">{fmtBRL(m.amount)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {canceled.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Vendas canceladas</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {canceled.map((c) => (
                <div key={c.id} className="flex justify-between">
                  <span>
                    Nº {c.number} · {fmtDateTime(c.created_at)} — {c.cancel_reason}
                  </span>
                  <span className="tabular-nums">{fmtBRL(c.total)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
}

function Box({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
