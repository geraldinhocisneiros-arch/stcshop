import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { errMsg, loadProducts } from "@/lib/data";
import { fmtBRL, fmtDateTime, fmtNum, matchesSearch, parseDecimal } from "@/lib/format";
import type { Product } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/estoque")({
  head: () => ({ meta: [{ title: "Estoque — Squash Tennis Shop" }] }),
  component: EstoquePage,
});

interface Movement {
  id: string;
  product_id: string;
  kind: string;
  qty: number;
  balance_after: number;
  unit_cost: number | null;
  notes: string | null;
  sale_id: string | null;
  invoice_id: string | null;
  created_at: string;
}

const KIND_LABEL: Record<string, string> = {
  entrada_nf: "Entrada NF",
  entrada_manual: "Entrada manual",
  venda: "Venda",
  cancelamento_venda: "Venda cancelada",
  ajuste: "Ajuste (inventário)",
  perda: "Perda / avaria",
};

function EstoquePage() {
  const { isAdmin } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [moves, setMoves] = useState<Movement[]>([]);
  const [search, setSearch] = useState("");
  const [onlyLow, setOnlyLow] = useState(false);
  const [adjusting, setAdjusting] = useState<Product | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([
        loadProducts(),
        supabase.from("shop_stock_movements").select("*").order("created_at", { ascending: false }).limit(300),
      ]);
      setProducts(p.filter((x) => x.kind === "produto"));
      setMoves((m.data ?? []) as Movement[]);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const active = products.filter((p) => p.active);
  const totalValue = active.reduce((s, p) => s + Math.max(0, p.stock_qty) * p.cost_price, 0);
  const totalSale = active.reduce((s, p) => s + Math.max(0, p.stock_qty) * p.sale_price, 0);
  const low = active.filter((p) => p.stock_qty <= p.min_stock);
  const zero = active.filter((p) => p.stock_qty <= 0);

  const rows = active
    .filter((p) => !onlyLow || p.stock_qty <= p.min_stock)
    .filter((p) => matchesSearch(`${p.name} ${p.nf_name ?? ""} ${p.barcode ?? ""}`, search));

  return (
    <AppLayout title="Estoque">
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {isAdmin && <Stat label="Valor em estoque (custo)" value={fmtBRL(totalValue)} />}
        <Stat label="Valor em estoque (venda)" value={fmtBRL(totalSale)} />
        <Stat label="Abaixo do mínimo" value={low.length} tone={low.length ? "warn" : undefined} />
        <Stat label="Zerados" value={zero.length} tone={zero.length ? "bad" : undefined} />
      </div>

      <Tabs defaultValue="saldo">
        <TabsList>
          <TabsTrigger value="saldo">Saldo</TabsTrigger>
          <TabsTrigger value="mov">Movimentações</TabsTrigger>
        </TabsList>
        <TabsContent value="saldo">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input className="max-w-sm" placeholder="Buscar…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button variant={onlyLow ? "default" : "outline"} size="sm" onClick={() => setOnlyLow(!onlyLow)}>
              Só abaixo do mínimo
            </Button>
          </div>
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                    <TableHead className="text-right">Mínimo</TableHead>
                    {isAdmin && <TableHead className="text-right">Custo médio</TableHead>}
                    {isAdmin && <TableHead className="text-right">Valor</TableHead>}
                    {isAdmin && <TableHead />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">{p.category}</div>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          p.stock_qty <= 0 ? "font-semibold text-destructive" : p.stock_qty <= p.min_stock && "text-warning-foreground",
                        )}
                      >
                        {fmtNum(p.stock_qty, 2)} {p.unit}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(p.min_stock, 2)}</TableCell>
                      {isAdmin && <TableCell className="text-right tabular-nums">{fmtBRL(p.cost_price)}</TableCell>}
                      {isAdmin && <TableCell className="text-right tabular-nums">{fmtBRL(Math.max(0, p.stock_qty) * p.cost_price)}</TableCell>}
                      {isAdmin && (
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" onClick={() => setAdjusting(p)}>
                            Ajustar
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="mov">
          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Qtd</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                    <TableHead>Obs.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {moves.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(m.created_at)}</TableCell>
                      <TableCell>{byId.get(m.product_id)?.name ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={m.qty > 0 ? "secondary" : "outline"}>{KIND_LABEL[m.kind] ?? m.kind}</Badge>
                      </TableCell>
                      <TableCell className={cn("text-right tabular-nums", m.qty < 0 ? "text-destructive" : "text-success")}>
                        {m.qty > 0 ? "+" : ""}
                        {fmtNum(m.qty, 2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmtNum(m.balance_after, 2)}</TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-muted-foreground">{m.notes}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <AdjustDialog product={adjusting} onClose={() => setAdjusting(null)} onDone={load} />
    </AppLayout>
  );
}

function AdjustDialog({ product, onClose, onDone }: { product: Product | null; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState("ajuste");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    setKind("ajuste");
    setQty("");
    setCost("");
    setNotes("");
  }, [product]);
  if (!product) return null;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ajustar estoque — {product.name}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Saldo atual: {fmtNum(product.stock_qty, 2)}</p>
        <div className="space-y-3">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ajuste">Inventário — informar quantidade contada</SelectItem>
              <SelectItem value="perda">Perda / avaria / uso interno — baixar</SelectItem>
              <SelectItem value="entrada_manual">Entrada sem nota — somar</SelectItem>
            </SelectContent>
          </Select>
          <div className="space-y-1">
            <Label>{kind === "ajuste" ? "Quantidade contada" : "Quantidade"}</Label>
            <Input autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          {kind === "entrada_manual" && (
            <div className="space-y-1">
              <Label>Custo unitário (R$) — entra no custo médio</Label>
              <Input value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
          )}
          <div className="space-y-1">
            <Label>Motivo</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              if (qty.trim() === "") return toast.error("Informe a quantidade");
              const { error } = await supabase.rpc("shop_adjust_stock", {
                p_product_id: product.id,
                p_kind: kind,
                p_qty: parseDecimal(qty),
                p_unit_cost: kind === "entrada_manual" && cost ? parseDecimal(cost) : null,
                p_notes: notes || null,
              });
              if (error) return toast.error(error.message);
              toast.success("Estoque ajustado");
              onClose();
              onDone();
            }}
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
