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

function FechamentoReport() {
  const { id } = Route.useParams();
  const [session, setSession] = useState<CashSession | null>(null);
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [moves, setMoves] = useState<Movement[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

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
