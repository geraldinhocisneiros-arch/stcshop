import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { RevenueBars } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errMsg, loadMethods, loadPaymentLines, loadProducts, loadSaleLines } from "@/lib/data";
import { fmtBRL, fmtNum, fmtPct, isoDay, monthRange, round2 } from "@/lib/format";
import { computeStats } from "@/lib/intelligence";
import type { PaymentMethod, Product, SaleLine } from "@/lib/types";
import { toast } from "sonner";
import { Download } from "lucide-react";

export const Route = createFileRoute("/relatorios")({
  head: () => ({ meta: [{ title: "Relatórios — Squash Tennis Shop" }] }),
  component: RelatoriosPage,
});

const prevMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

function summarize(lines: SaleLine[]) {
  const revenue = lines.reduce((s, l) => s + Number(l.total), 0);
  const cost = lines.reduce((s, l) => s + Number(l.cost_total), 0);
  const fees = lines.reduce((s, l) => s + Number(l.fee_share), 0);
  const sales = new Set(lines.map((l) => l.sale_id)).size;
  const units = lines.reduce((s, l) => s + (l.kind === "produto" ? Number(l.qty) : 0), 0);
  return { revenue, cost, fees, profit: revenue - cost - fees, sales, units, ticket: sales ? revenue / sales : 0 };
}

function RelatoriosPage() {
  const [month, setMonth] = useState(isoDay(new Date()).slice(0, 7));
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [prevLines, setPrevLines] = useState<SaleLine[]>([]);
  const [payments, setPayments] = useState<Array<{ method: string; amount: number; fee_amount: number }>>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [rankBy, setRankBy] = useState<"qty" | "revenue" | "grossProfit">("revenue");

  useEffect(() => {
    const r = monthRange(month);
    const pr = monthRange(prevMonth(month));
    Promise.all([loadSaleLines(r.from, r.to), loadSaleLines(pr.from, pr.to), loadPaymentLines(r.from, r.to), loadProducts(), loadMethods()])
      .then(([l, p, pay, prods, m]) => {
        setLines(l);
        setPrevLines(p);
        setPayments(pay);
        setProducts(prods);
        setMethods(m);
      })
      .catch((e) => toast.error(errMsg(e)));
  }, [month]);

  const range = monthRange(month);
  const cur = summarize(lines);
  const prev = summarize(prevLines);
  const delta = (a: number, b: number) => (b > 0 ? (a - b) / b : null);

  const daily = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) {
      const d = isoDay(l.created_at);
      m.set(d, (m.get(d) ?? 0) + Number(l.total));
    }
    return Array.from({ length: range.days }, (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, "0")}`;
      return { label: String(i + 1), value: round2(m.get(d) ?? 0), hint: d.split("-").reverse().join("/") };
    });
  }, [lines, month, range.days]);

  const stats = useMemo(() => computeStats(products.filter((p) => p.active), lines, range.days), [products, lines, range.days]);
  const ranked = [...stats].sort((a, b) => b[rankBy] - a[rankBy]);
  const top = ranked.filter((s) => s.qty > 0).slice(0, 15);
  const bottom = [...stats]
    .filter((s) => s.product.kind === "produto")
    .sort((a, b) => a.qty - b.qty || a.revenue - b.revenue)
    .slice(0, 15);

  const byCategory = useMemo(() => {
    const m = new Map<string, { revenue: number; profit: number; qty: number }>();
    for (const l of lines) {
      const k = l.category || "Sem categoria";
      const r = m.get(k) ?? { revenue: 0, profit: 0, qty: 0 };
      r.revenue += Number(l.total);
      r.profit += Number(l.total) - Number(l.cost_total) - Number(l.fee_share);
      r.qty += Number(l.qty);
      m.set(k, r);
    }
    return [...m.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  }, [lines]);

  const byMethod = useMemo(() => {
    const m = new Map<string, { amount: number; fee: number }>();
    for (const p of payments) {
      const r = m.get(p.method) ?? { amount: 0, fee: 0 };
      r.amount += Number(p.amount);
      r.fee += Number(p.fee_amount);
      m.set(p.method, r);
    }
    return [...m.entries()].sort((a, b) => b[1].amount - a[1].amount);
  }, [payments]);

  const exportXlsx = async () => {
    const XLSX = await import("xlsx");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        { Indicador: "Faturamento", Valor: round2(cur.revenue) },
        { Indicador: "Vendas", Valor: cur.sales },
        { Indicador: "Ticket médio", Valor: round2(cur.ticket) },
        { Indicador: "Custo das mercadorias", Valor: round2(cur.cost) },
        { Indicador: "Taxas de cartão", Valor: round2(cur.fees) },
        { Indicador: "Lucro bruto", Valor: round2(cur.profit) },
      ]),
      "Resumo",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        ranked.map((s) => ({
          Produto: s.product.name,
          Categoria: s.product.category ?? "",
          Quantidade: s.qty,
          Faturamento: s.revenue,
          "Lucro bruto": s.grossProfit,
          "Estoque atual": s.product.kind === "produto" ? s.product.stock_qty : "",
        })),
      ),
      "Produtos",
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(daily.map((d) => ({ Dia: d.hint, Faturamento: d.value }))), "Por dia");
    XLSX.writeFile(wb, `vendas-${month}.xlsx`);
  };

  const label = (c: string) => methods.find((m) => m.code === c)?.label ?? c;
  const deltaHint = (a: number, b: number) => {
    const d = delta(a, b);
    return d === null ? "sem mês anterior" : `${d >= 0 ? "+" : ""}${fmtPct(d)} vs mês anterior`;
  };

  return (
    <AppLayout
      title="Relatórios de vendas"
      adminOnly
      actions={
        <>
          <Input type="month" className="w-40" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          <Button size="sm" variant="outline" onClick={exportXlsx}>
            <Download className="mr-1 h-4 w-4" /> Excel
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Faturamento do mês" value={fmtBRL(cur.revenue)} hint={deltaHint(cur.revenue, prev.revenue)} />
          <Stat label="Vendas" value={cur.sales} hint={`ticket médio ${fmtBRL(cur.ticket)}`} />
          <Stat
            label="Lucro bruto"
            value={fmtBRL(cur.profit)}
            hint={`${fmtPct(cur.revenue ? cur.profit / cur.revenue : 0)} · após custo e taxas`}
            tone={cur.profit < 0 ? "bad" : undefined}
          />
          <Stat label="Unidades vendidas" value={fmtNum(cur.units)} hint={deltaHint(cur.units, prev.units)} />
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Faturamento por dia</CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueBars data={daily} />
          </CardContent>
        </Card>

        <div className="grid gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-base">O que mais vende</CardTitle>
              <Tabs value={rankBy} onValueChange={(v) => setRankBy(v as typeof rankBy)}>
                <TabsList className="h-8">
                  <TabsTrigger value="revenue" className="text-xs">
                    R$
                  </TabsTrigger>
                  <TabsTrigger value="qty" className="text-xs">
                    Qtd
                  </TabsTrigger>
                  <TabsTrigger value="grossProfit" className="text-xs">
                    Lucro
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </CardHeader>
            <CardContent className="p-0">
              <RankTable rows={top} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">O que menos vende (produtos ativos)</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <RankTable rows={bottom} showStock />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Por categoria</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Categoria</TableHead>
                    <TableHead className="text-right">Faturamento</TableHead>
                    <TableHead className="text-right">% do total</TableHead>
                    <TableHead className="text-right">Lucro bruto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byCategory.map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell>{k}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(v.revenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(cur.revenue ? v.revenue / cur.revenue : 0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(v.profit)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Por forma de pagamento</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Forma</TableHead>
                    <TableHead className="text-right">Recebido</TableHead>
                    <TableHead className="text-right">% do total</TableHead>
                    <TableHead className="text-right">Taxas pagas</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byMethod.map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell>{label(k)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(v.amount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtPct(cur.revenue ? v.amount / cur.revenue : 0)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(v.fee)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}

function RankTable({ rows, showStock }: { rows: ReturnType<typeof computeStats>; showStock?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Produto</TableHead>
          <TableHead className="text-right">Qtd</TableHead>
          <TableHead className="text-right">Faturamento</TableHead>
          <TableHead className="text-right">{showStock ? "Estoque" : "Lucro bruto"}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((s) => (
          <TableRow key={s.product.id}>
            <TableCell className="max-w-56 truncate">{s.product.name}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtNum(s.qty, 2)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtBRL(s.revenue)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {showStock ? fmtNum(s.product.stock_qty, 2) : fmtBRL(s.grossProfit)}
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
              Sem dados no mês.
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}
