import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { RevenueBars } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { daysAgo, errMsg, loadProducts, loadSaleLines } from "@/lib/data";
import { fmtBRL, fmtDateTime, fmtNum, isoDay } from "@/lib/format";
import type { CashSession, Product, SaleLine } from "@/lib/types";
import { toast } from "sonner";
import { ShoppingCart, Wrench } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Painel — Squash Tennis Shop" }] }),
  component: Dashboard,
});

function Dashboard() {
  const { isAdmin } = useAuth();
  const [cash, setCash] = useState<CashSession | null>(null);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState({ open: 0, ready: 0, late: 0 });

  useEffect(() => {
    const today = isoDay(new Date());
    Promise.all([
      supabase.from("shop_cash_sessions").select("*").eq("status", "aberto").maybeSingle(),
      loadSaleLines(daysAgo(29), today),
      loadProducts({ onlyActive: true }),
      supabase.from("shop_stringing_orders").select("status, due_at").in("status", ["recebida", "em_andamento", "pronta"]),
    ])
      .then(([c, l, p, o]) => {
        setCash((c.data as CashSession) ?? null);
        setLines(l);
        setProducts(p);
        const rows = (o.data ?? []) as Array<{ status: string; due_at: string | null }>;
        setOrders({
          open: rows.filter((r) => r.status !== "pronta").length,
          ready: rows.filter((r) => r.status === "pronta").length,
          late: rows.filter((r) => r.status !== "pronta" && r.due_at && new Date(r.due_at) < new Date()).length,
        });
      })
      .catch((e) => toast.error(errMsg(e)));
  }, []);

  const today = isoDay(new Date());
  const month = today.slice(0, 7);
  const todayLines = lines.filter((l) => isoDay(l.created_at) === today);
  const monthLines = lines.filter((l) => isoDay(l.created_at).startsWith(month));
  const sum = (ls: SaleLine[]) => ls.reduce((s, l) => s + Number(l.total), 0);
  const count = (ls: SaleLine[]) => new Set(ls.map((l) => l.sale_id)).size;
  const low = products.filter((p) => p.kind === "produto" && p.stock_qty <= p.min_stock);

  const daily = Array.from({ length: 30 }, (_, i) => {
    const d = daysAgo(29 - i);
    return {
      label: d.slice(8),
      value: sum(lines.filter((l) => isoDay(l.created_at) === d)),
      hint: d.split("-").reverse().join("/"),
    };
  });

  return (
    <AppLayout title="Painel">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button asChild size="lg">
            <Link to="/caixa" search={{ ordem: undefined }}>
              <ShoppingCart className="mr-2 h-5 w-5" /> {cash ? "Ir para o caixa" : "Abrir o caixa"}
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/encordoamento">
              <Wrench className="mr-2 h-5 w-5" /> Encordoamentos
            </Link>
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Vendas hoje" value={fmtBRL(sum(todayLines))} hint={`${count(todayLines)} vendas`} />
          {isAdmin && <Stat label="Vendas no mês" value={fmtBRL(sum(monthLines))} hint={`${count(monthLines)} vendas`} />}
          <Stat
            label="Caixa"
            value={cash ? "Aberto" : "Fechado"}
            hint={cash ? `desde ${fmtDateTime(cash.opened_at)}` : "abra para vender"}
            tone={cash ? "good" : "warn"}
          />
          <Stat
            label="Encordoamentos"
            value={`${orders.open} na fila`}
            hint={`${orders.ready} prontos para retirar${orders.late ? ` · ${orders.late} atrasados` : ""}`}
            tone={orders.late ? "bad" : undefined}
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Faturamento — últimos 30 dias</CardTitle>
            </CardHeader>
            <CardContent>
              <RevenueBars data={daily} height={220} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Estoque baixo ({low.length})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {low.slice(0, 12).map((p) => (
                <div key={p.id} className="flex justify-between">
                  <span className="truncate">{p.name}</span>
                  <span className={p.stock_qty <= 0 ? "font-semibold text-destructive" : "text-warning-foreground"}>
                    {fmtNum(p.stock_qty, 2)}
                  </span>
                </div>
              ))}
              {low.length === 0 && <p className="text-muted-foreground">Tudo acima do mínimo.</p>}
              {isAdmin && low.length > 0 && (
                <Link to="/inteligencia" className="block pt-2 text-primary underline">
                  Ver sugestão de compra
                </Link>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
