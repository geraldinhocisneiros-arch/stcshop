import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { ListManagerDialog } from "@/components/ListManagerDialog";
import { ProductDialog } from "@/components/ProductDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { errMsg, loadCostStructure, loadProducts, loadSettings } from "@/lib/data";
import { effectivePrice, fmtBRL, fmtDate, fmtNum, fmtPct, matchesSearch } from "@/lib/format";
import { analyzePrice, PRICE_STATUS_LABEL, type CostStructure } from "@/lib/pricing";
import type { Product, ShopSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Award, Plus, Tags } from "lucide-react";

export const Route = createFileRoute("/produtos")({
  head: () => ({ meta: [{ title: "Produtos — Squash Tennis Shop" }] }),
  component: ProdutosPage,
});

function ProdutosPage() {
  const { isAdmin } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [cs, setCs] = useState<CostStructure | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("todas");
  const [status, setStatus] = useState("ativos");
  const [editing, setEditing] = useState<Product | null>(null);
  const [dialog, setDialog] = useState(false);
  const [listDialog, setListDialog] = useState<"category" | "brand" | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([loadProducts(), loadSettings()]);
      setProducts(p);
      setSettings(s);
      if (isAdmin) setCs((await loadCostStructure(s)).cs);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, [isAdmin]);
  useEffect(() => {
    load();
  }, [load]);

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean) as string[])].sort(),
    [products],
  );
  const target = (settings?.target_margin_pct ?? 0) / 100;

  const rows = useMemo(
    () =>
      products
        .filter((p) => (status === "ativos" ? p.active : status === "inativos" ? !p.active : true))
        .filter((p) => category === "todas" || p.category === category)
        .filter((p) => matchesSearch(`${p.name} ${p.nf_name ?? ""} ${p.code ?? ""} ${p.barcode ?? ""} ${p.brand ?? ""}`, search))
        .map((p) => ({ p, pa: cs ? analyzePrice(p.sale_price, p.cost_price, cs, target) : null })),
    [products, status, category, search, cs, target],
  );

  return (
    <AppLayout
      title="Produtos e serviços"
      actions={
        isAdmin && (
          <>
            <Button size="sm" variant="outline" onClick={() => setListDialog("category")}>
              <Tags className="mr-1 h-4 w-4" /> Categorias
            </Button>
            <Button size="sm" variant="outline" onClick={() => setListDialog("brand")}>
              <Award className="mr-1 h-4 w-4" /> Marcas
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(null);
                setDialog(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" /> Novo
            </Button>
          </>
        )
      }
    >
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="max-w-sm" placeholder="Buscar…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas as categorias</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ativos">Ativos</SelectItem>
            <SelectItem value="inativos">Inativos</SelectItem>
            <SelectItem value="todos">Todos</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto self-center text-sm text-muted-foreground">{rows.length} itens</div>
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Apelido</TableHead>
                <TableHead>Nome na nota</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead className="text-right">Estoque</TableHead>
                {isAdmin && <TableHead className="text-right">Custo</TableHead>}
                <TableHead className="text-right">Preço</TableHead>
                {isAdmin && <TableHead className="text-right">Lucro líq.</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ p, pa }) => (
                <TableRow
                  key={p.id}
                  className={cn(isAdmin && "cursor-pointer", !p.active && "opacity-50")}
                  onClick={() => {
                    if (!isAdmin) return;
                    setEditing(p);
                    setDialog(true);
                  }}
                >
                  <TableCell className="font-medium">
                    {p.name}
                    {p.kind === "servico" && (
                      <Badge variant="secondary" className="ml-2">
                        serviço
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-muted-foreground">{p.nf_name ?? "—"}</TableCell>
                  <TableCell>{p.category ?? "—"}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      p.kind === "produto" && p.stock_qty <= p.min_stock && "font-semibold text-destructive",
                    )}
                  >
                    {p.kind === "produto" ? fmtNum(p.stock_qty, 2) : "—"}
                  </TableCell>
                  {isAdmin && <TableCell className="text-right tabular-nums">{fmtBRL(p.cost_price)}</TableCell>}
                  <TableCell className="text-right font-medium tabular-nums">
                    {fmtBRL(p.sale_price)}
                    {effectivePrice(p) !== Number(p.sale_price) && (
                      <div className="text-xs text-accent-foreground">promo {fmtBRL(p.promo_price)} até {fmtDate(p.promo_until)}</div>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      {pa && pa.status !== "sem_custo" ? (
                        <span
                          title={PRICE_STATUS_LABEL[pa.status]}
                          className={cn(
                            "tabular-nums",
                            pa.status === "prejuizo" && "font-semibold text-destructive",
                            pa.status === "abaixo_meta" && "text-warning-foreground",
                            pa.status === "ok" && "text-success",
                          )}
                        >
                          {fmtPct(pa.netMargin)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">sem custo</span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Nenhum produto. Cadastre aqui ou importe uma nota fiscal — os itens da nota viram produtos.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ProductDialog
        open={dialog}
        onOpenChange={setDialog}
        product={editing}
        cs={cs}
        targetMargin={target}
        onSaved={load}
      />
      <ListManagerDialog
        kind={listDialog ?? "category"}
        open={listDialog !== null}
        onOpenChange={(v) => !v && setListDialog(null)}
        products={products}
        onChanged={load}
      />
    </AppLayout>
  );
}
