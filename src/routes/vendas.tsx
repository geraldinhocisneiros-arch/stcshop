import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { endOfDayISO, fmtBRL, fmtDateTime, fmtNum, isoDay, startOfDayISO } from "@/lib/format";
import { loadMethods } from "@/lib/data";
import type { PaymentMethod, Sale } from "@/lib/types";
import { toast } from "sonner";

export const Route = createFileRoute("/vendas")({
  head: () => ({ meta: [{ title: "Vendas — Squash Tennis Shop" }] }),
  component: VendasPage,
});

interface SaleDetail extends Sale {
  shop_sale_items: Array<{ id: string; description: string; qty: number; unit_price: number; discount: number; total: number }>;
  shop_sale_payments: Array<{ id: string; method: string; amount: number; fee_amount: number }>;
}

function VendasPage() {
  const today = isoDay(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [sales, setSales] = useState<SaleDetail[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [open, setOpen] = useState<SaleDetail | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("shop_sales")
      .select("*, shop_sale_items(*), shop_sale_payments(*)")
      .gte("created_at", startOfDayISO(from))
      .lte("created_at", endOfDayISO(to))
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) return toast.error(error.message);
    setSales((data ?? []) as SaleDetail[]);
  }, [from, to]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    loadMethods().then(setMethods);
  }, []);

  const label = (c: string) => methods.find((m) => m.code === c)?.label ?? c;
  const done = sales.filter((s) => s.status === "concluida");
  const total = done.reduce((s, x) => s + Number(x.total), 0);

  return (
    <AppLayout title="Vendas">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs">De</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Até</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="ml-auto text-right text-sm">
          <div className="text-muted-foreground">{done.length} vendas</div>
          <div className="text-xl font-semibold">{fmtBRL(total)}</div>
        </div>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nº</TableHead>
                <TableHead>Quando</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Itens</TableHead>
                <TableHead>Pagamento</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map((s) => (
                <TableRow key={s.id} className="cursor-pointer" onClick={() => setOpen(s)}>
                  <TableCell>
                    {s.number}
                    {s.status === "cancelada" && (
                      <Badge variant="destructive" className="ml-2">
                        cancelada
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{fmtDateTime(s.created_at)}</TableCell>
                  <TableCell>{s.customer_name ?? "—"}</TableCell>
                  <TableCell className="max-w-72 truncate text-sm">
                    {s.shop_sale_items.map((i) => `${fmtNum(i.qty, 2)}× ${i.description}`).join(", ")}
                  </TableCell>
                  <TableCell className="text-sm">{s.shop_sale_payments.map((p) => label(p.method)).join(" + ")}</TableCell>
                  <TableCell className={`text-right font-medium ${s.status === "cancelada" ? "line-through opacity-50" : ""}`}>
                    {fmtBRL(s.total)}
                  </TableCell>
                </TableRow>
              ))}
              {sales.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nenhuma venda no período.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={!!open}
        onOpenChange={(v) => {
          if (!v) {
            setOpen(null);
            setCancelReason("");
          }
        }}
      >
        {open && (
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                Venda nº {open.number} · {fmtDateTime(open.created_at)}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm">
              {open.customer_name && <div>Cliente: {open.customer_name}</div>}
              <div className="divide-y rounded-md border">
                {open.shop_sale_items.map((i) => (
                  <div key={i.id} className="flex justify-between p-2">
                    <span>
                      {fmtNum(i.qty, 2)}× {i.description} <span className="text-muted-foreground">({fmtBRL(i.unit_price)})</span>
                    </span>
                    <span className="tabular-nums">{fmtBRL(Number(i.total) + Number(i.discount))}</span>
                  </div>
                ))}
              </div>
              {Number(open.discount) > 0 && <div className="text-right">Desconto: − {fmtBRL(open.discount)}</div>}
              <div className="text-right text-lg font-semibold">Total: {fmtBRL(open.total)}</div>
              <div>
                {open.shop_sale_payments.map((p) => (
                  <div key={p.id} className="flex justify-between">
                    <span>{label(p.method)}</span>
                    <span className="tabular-nums">
                      {fmtBRL(p.amount)} {Number(p.fee_amount) > 0 && <span className="text-xs text-muted-foreground">(taxa {fmtBRL(p.fee_amount)})</span>}
                    </span>
                  </div>
                ))}
              </div>
              {open.status === "cancelada" ? (
                <div className="rounded-md bg-destructive/10 p-2 text-destructive">
                  Cancelada em {fmtDateTime(open.canceled_at)} — {open.cancel_reason}
                </div>
              ) : (
                <div className="space-y-1 border-t pt-3">
                  <Label>Cancelar venda (devolve os itens ao estoque)</Label>
                  <Input placeholder="Motivo do cancelamento" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                </div>
              )}
            </div>
            {open.status !== "cancelada" && (
              <DialogFooter>
                <Button
                  variant="destructive"
                  disabled={!cancelReason.trim()}
                  onClick={async () => {
                    const { error } = await supabase.rpc("shop_cancel_sale", { p_sale_id: open.id, p_reason: cancelReason });
                    if (error) return toast.error(error.message);
                    toast.success("Venda cancelada e estoque devolvido");
                    setOpen(null);
                    setCancelReason("");
                    load();
                  }}
                >
                  Cancelar venda
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        )}
      </Dialog>
    </AppLayout>
  );
}
