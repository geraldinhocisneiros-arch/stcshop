import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { daysAgo, errMsg, loadCostStructure, loadLastSaleByProduct, loadProducts, loadSaleLines, loadSettings } from "@/lib/data";
import { effectivePrice, fmtBRL, fmtDate, fmtNum, fmtPct, isoDay } from "@/lib/format";
import { computeStats, promoSuggestions, reorderSuggestions, type AbcClass, type ProductStats } from "@/lib/intelligence";
import { analyzePrice, type CostStructure } from "@/lib/pricing";
import type { Product, SaleLine, ShopSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/inteligencia")({
  head: () => ({ meta: [{ title: "Inteligência — Squash Tennis Shop" }] }),
  component: InteligenciaPage,
});

const ABC_STYLE: Record<AbcClass, string> = {
  A: "bg-primary text-primary-foreground",
  B: "bg-secondary text-secondary-foreground",
  C: "bg-muted text-muted-foreground",
};

function InteligenciaPage() {
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [cs, setCs] = useState<CostStructure | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [lastSale, setLastSale] = useState<Record<string, string>>({});
  const [metric, setMetric] = useState<"revenue" | "grossProfit">("revenue");

  const load = useCallback(async () => {
    try {
      const s = await loadSettings();
      const [p, l, ls, c] = await Promise.all([
        loadProducts(),
        loadSaleLines(daysAgo(s.analysis_days - 1), isoDay(new Date())),
        loadLastSaleByProduct(),
        loadCostStructure(s),
      ]);
      setSettings(s);
      setProducts(p);
      setLines(l);
      setLastSale(ls);
      setCs(c.cs);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(
    () => (settings ? computeStats(products.filter((p) => p.active), lines, settings.analysis_days, metric, lastSale) : []),
    [products, lines, settings, metric, lastSale],
  );
  const reorder = useMemo(() => (settings ? reorderSuggestions(stats, settings) : []), [stats, settings]);
  const promos = useMemo(
    () =>
      settings && cs
        ? promoSuggestions(stats, cs, settings).filter((p) => effectivePrice(p.stats.product) === Number(p.stats.product.sale_price))
        : [],
    [stats, cs, settings],
  );
  const pricing = useMemo(() => {
    if (!cs || !settings) return [];
    return stats
      .map((s) => ({ s, pa: analyzePrice(s.product.sale_price, s.product.cost_price, cs, settings.target_margin_pct / 100) }))
      .filter((x) => x.pa.status === "prejuizo" || x.pa.status === "abaixo_meta")
      .sort((a, b) => (a.pa.status === b.pa.status ? b.s.revenue - a.s.revenue : a.pa.status === "prejuizo" ? -1 : 1));
  }, [stats, cs, settings]);

  if (!settings || !cs) return <AppLayout title="Inteligência" adminOnly>Calculando…</AppLayout>;

  const withValue = stats.filter((s) => s[metric] > 0);
  const classInfo = (["A", "B", "C"] as AbcClass[]).map((c) => {
    const rows = stats.filter((s) => s.abc === c);
    return { c, count: rows.length, share: rows.reduce((t, r) => t + r.share, 0) };
  });
  const aCount = classInfo[0].count;
  const stockValue = (rows: ProductStats[]) => rows.reduce((t, r) => t + Math.max(0, r.product.stock_qty) * r.product.cost_price, 0);
  const capitalStale = promos.reduce((t, p) => t + p.capitalTied, 0);
  const totalCapital = stockValue(stats.filter((s) => s.product.kind === "produto"));
  const ruptureA = reorder.filter((r) => r.stats.abc === "A" && r.urgency !== "repor").length;

  const applyPromo = async (product: Product, price: number) => {
    const until = isoDay(new Date(Date.now() + 30 * 86_400_000));
    const { error } = await supabase.from("shop_products").update({ promo_price: price, promo_until: until }).eq("id", product.id);
    if (error) return toast.error(error.message);
    toast.success(`${product.name}: ${fmtBRL(price)} até ${fmtDate(until)}`);
    load();
  };
  const applyPrice = async (product: Product, price: number) => {
    const { error } = await supabase.from("shop_products").update({ sale_price: price }).eq("id", product.id);
    if (error) return toast.error(error.message);
    toast.success(`${product.name}: novo preço ${fmtBRL(price)} (era ${fmtBRL(product.sale_price)})`);
    load();
  };

  return (
    <AppLayout title="Inteligência" adminOnly>
      <p className="mb-4 text-sm text-muted-foreground">
        Baseado nos últimos {settings.analysis_days} dias de vendas · custos variáveis {fmtPct(cs.variable)} · custo fixo{" "}
        {fmtPct(cs.fixed)} do faturamento ·{" "}
        <Link to="/configuracoes" className="underline">
          ajustar parâmetros
        </Link>
      </p>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Produtos curva A"
          value={aCount}
          hint={`${fmtPct(withValue.length ? aCount / stats.length : 0, 0)} dos produtos = ${fmtPct(classInfo[0].share, 0)} do ${metric === "revenue" ? "faturamento" : "lucro"}`}
        />
        <Stat label="Comprar agora" value={reorder.length} hint={ruptureA ? `${ruptureA} da curva A zerados/urgentes` : "nenhum A em risco"} tone={ruptureA ? "bad" : undefined} />
        <Stat label="Dinheiro parado" value={fmtBRL(capitalStale)} hint={`${fmtPct(totalCapital ? capitalStale / totalCapital : 0, 0)} do estoque, em ${promos.length} produtos`} tone={capitalStale > 0 ? "warn" : undefined} />
        <Stat label="Preços a revisar" value={pricing.length} hint={`${pricing.filter((p) => p.pa.status === "prejuizo").length} dando prejuízo`} tone={pricing.some((p) => p.pa.status === "prejuizo") ? "bad" : undefined} />
      </div>

      <Tabs defaultValue="abc">
        <TabsList className="flex-wrap">
          <TabsTrigger value="abc">Curva ABC</TabsTrigger>
          <TabsTrigger value="comprar">O que comprar ({reorder.length})</TabsTrigger>
          <TabsTrigger value="promo">Promoções ({promos.length})</TabsTrigger>
          <TabsTrigger value="precos">Preços ({pricing.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="abc" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={metric === "revenue" ? "default" : "outline"} onClick={() => setMetric("revenue")}>
              Por faturamento
            </Button>
            <Button size="sm" variant={metric === "grossProfit" ? "default" : "outline"} onClick={() => setMetric("grossProfit")}>
              Por lucro
            </Button>
            <span className="text-xs text-muted-foreground">
              {classInfo.map((c) => `${c.c}: ${c.count} itens (${fmtPct(c.share, 0)})`).join(" · ")}
            </span>
          </div>
          <Card>
            <CardContent className="p-3 text-sm text-muted-foreground">
              <b className="text-foreground">Como usar:</b> itens <b>A</b> nunca podem faltar — negocie prazo e preço com o fornecedor
              e confira o estoque toda semana. Itens <b>B</b> têm reposição normal. Itens <b>C</b> devem ter estoque mínimo: compre
              pouco, e o que estiver parado vira promoção. Compare as duas visões: um produto que é A em faturamento mas C em lucro
              está vendendo muito e ganhando pouco — o preço dele merece atenção.
            </CardContent>
          </Card>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Classe</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-right">Qtd</TableHead>
                    <TableHead className="text-right">Faturamento</TableHead>
                    <TableHead className="text-right">Lucro bruto</TableHead>
                    <TableHead className="text-right">% / acumulado</TableHead>
                    <TableHead className="text-right">Estoque dura</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.map((s) => (
                    <TableRow key={s.product.id}>
                      <TableCell>
                        <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded font-bold", ABC_STYLE[s.abc])}>{s.abc}</span>
                      </TableCell>
                      <TableCell>{s.product.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(s.qty, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(s.revenue)}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", s.grossProfit < 0 && "text-destructive")}>{fmtBRL(s.grossProfit)}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {fmtPct(s.share)} / {fmtPct(s.cumulativeShare, 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.product.kind === "servico" ? "—" : s.coverageDays === null ? (s.product.stock_qty > 0 ? "sem giro" : "—") : `${Math.round(s.coverageDays)} dias`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="comprar" className="space-y-3">
          <Card>
            <CardContent className="p-3 text-sm text-muted-foreground">
              Sugestão = consumo médio diário × ({settings.lead_time_days} dias de prazo do fornecedor + {settings.coverage_target_days} dias de
              cobertura) − estoque atual. Dispara quando o estoque não cobre o prazo + {settings.safety_days} dias de segurança, ou fica
              abaixo do mínimo cadastrado.
            </CardContent>
          </Card>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Situação</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-center">Classe</TableHead>
                    <TableHead className="text-right">Estoque</TableHead>
                    <TableHead className="text-right">Vende/mês</TableHead>
                    <TableHead className="text-right">Comprar</TableHead>
                    <TableHead className="text-right">Investimento</TableHead>
                    <TableHead>Motivo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reorder.map((r) => (
                    <TableRow key={r.stats.product.id}>
                      <TableCell>
                        <Badge variant={r.urgency === "repor" ? "secondary" : "destructive"}>
                          {r.urgency === "ruptura" ? "Zerado" : r.urgency === "urgente" ? "Urgente" : "Repor"}
                        </Badge>
                      </TableCell>
                      <TableCell>{r.stats.product.name}</TableCell>
                      <TableCell className="text-center">{r.stats.abc}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.stats.product.stock_qty, 2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(r.stats.dailyAvg * 30, 1)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{fmtNum(r.suggestedQty)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(r.suggestedQty * (r.stats.product.last_cost ?? r.stats.product.cost_price))}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.reason}</TableCell>
                    </TableRow>
                  ))}
                  {reorder.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                        Nada para comprar agora.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          {reorder.length > 0 && (
            <p className="text-right text-sm">
              Investimento total sugerido:{" "}
              <b>{fmtBRL(reorder.reduce((t, r) => t + r.suggestedQty * (r.stats.product.last_cost ?? r.stats.product.cost_price), 0))}</b>
            </p>
          )}
        </TabsContent>

        <TabsContent value="promo" className="space-y-3">
          <Card>
            <CardContent className="p-3 text-sm text-muted-foreground">
              Candidatos: sem venda há {settings.stale_days}+ dias, ou curva C com estoque para mais de {settings.coverage_target_days * 3} dias.
              O desconto começa em 10% e sobe 5% a cada 30 dias parado (teto {settings.max_promo_discount_pct}%). O preço nunca fica abaixo
              do <b>equilíbrio</b> (lucro zero, ainda paga o custo fixo); se o produto estiver parado há mais de {settings.stale_days * 2} dias,
              o piso vira o de <b>liquidação</b> (cobre só o custo do produto + impostos/taxas) — melhor virar dinheiro do que continuar parado.
              "Aplicar" cria uma promoção de 30 dias; o preço normal volta sozinho depois.
            </CardContent>
          </Card>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead className="text-right">Parado</TableHead>
                    <TableHead className="text-right">Preço</TableHead>
                    <TableHead className="text-right">Promo</TableHead>
                    <TableHead className="text-right">Piso</TableHead>
                    <TableHead className="text-right">Lucro na promo</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {promos.map((p) => (
                    <TableRow key={p.stats.product.id}>
                      <TableCell>
                        {p.stats.product.name}
                        <div className="text-xs text-muted-foreground">
                          {fmtNum(p.stats.product.stock_qty, 2)} em estoque
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">{p.reason}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(p.capitalTied)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(p.stats.product.sale_price)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {fmtBRL(p.promoPrice)}
                        <div className="text-xs font-normal text-muted-foreground">−{fmtPct(p.discountPct, 0)}</div>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {fmtBRL(p.floor)}
                        <div className="text-muted-foreground">{p.floorKind === "liquidacao" ? "liquidação" : "equilíbrio"}</div>
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", (p.newNetMargin ?? 0) < 0 && "text-destructive")}>
                        {fmtPct(p.newNetMargin)}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => applyPromo(p.stats.product, p.promoPrice)}>
                          Aplicar
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {promos.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                        Nenhum produto parado. 👏
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="precos" className="space-y-3">
          <Card>
            <CardContent className="p-3 text-sm text-muted-foreground">
              Produtos cujo lucro líquido (depois de custo, impostos, taxas e rateio do custo fixo) está abaixo da meta de{" "}
              {settings.target_margin_pct}%. Antes de subir o preço, pergunte: o concorrente vende por quanto? Se não dá para subir, a
              saída é negociar custo com o fornecedor — ou aceitar que esse item é "isca" e compensar em outro.
            </CardContent>
          </Card>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-right">Custo</TableHead>
                    <TableHead className="text-right">Preço</TableHead>
                    <TableHead className="text-right">Lucro líq.</TableHead>
                    <TableHead className="text-right">Equilíbrio</TableHead>
                    <TableHead className="text-right">Sugerido</TableHead>
                    <TableHead className="text-right">Vendeu no período</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pricing.map(({ s, pa }) => (
                    <TableRow key={s.product.id}>
                      <TableCell>
                        {s.product.name}
                        {pa.status === "prejuizo" && (
                          <Badge variant="destructive" className="ml-2">
                            prejuízo
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(pa.cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(pa.price)}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", pa.status === "prejuizo" ? "text-destructive" : "text-warning-foreground")}>
                        {fmtPct(pa.netMargin)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(pa.breakEvenPrice)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{fmtBRL(pa.suggestedPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(s.qty, 2)}</TableCell>
                      <TableCell>
                        {pa.suggestedPrice && (
                          <Button size="sm" variant="outline" onClick={() => applyPrice(s.product, Math.ceil(pa.suggestedPrice! * 10) / 10)}>
                            Aplicar
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {pricing.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                        Todos os preços atingem a meta.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}
