import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { endOfDayISO, fmtBRL, fmtDateTime, fmtNum, isoDay, startOfDayISO } from "@/lib/format";
import { loadMethods } from "@/lib/data";
import type { CustomerEntry, PaymentMethod, Sale } from "@/lib/types";
import { toast } from "sonner";

export const Route = createFileRoute("/vendas")({
  head: () => ({ meta: [{ title: "Vendas — Squash Tennis Shop" }] }),
  component: VendasPage,
});

interface SaleDetail extends Sale {
  shop_sale_items: Array<{
    id: string;
    description: string;
    qty: number;
    unit_price: number;
    discount: number;
    total: number;
  }>;
  shop_sale_payments: Array<{ id: string; method: string; amount: number; fee_amount: number }>;
}

/** Pagamento de pendência (fiado): entra no caixa, mas não é venda nova nem mexe no estoque. */
type Receipt = CustomerEntry & { shop_customers: { name: string } | null };

function VendasPage() {
  const today = isoDay(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [sales, setSales] = useState<SaleDetail[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [open, setOpen] = useState<SaleDetail | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(async () => {
    const [s, r] = await Promise.all([
      supabase
        .from("shop_sales")
        .select("*, shop_sale_items(*), shop_sale_payments(*)")
        .gte("created_at", startOfDayISO(from))
        .lte("created_at", endOfDayISO(to))
        .order("created_at", { ascending: false })
        .limit(1000),
      supabase
        .from("shop_customer_entries")
        .select("*, shop_customers(name)")
        .eq("kind", "pagamento")
        .gte("created_at", startOfDayISO(from))
        .lte("created_at", endOfDayISO(to))
        .order("created_at", { ascending: false })
        .limit(1000),
    ]);
    if (s.error) return toast.error(s.error.message);
    if (r.error) return toast.error(r.error.message);
    setSales((s.data ?? []) as SaleDetail[]);
    setReceipts((r.data ?? []) as Receipt[]);
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
  // fiado vendido no período: é venda, mas o dinheiro ainda não entrou
  const onAccount = done.reduce(
    (s, x) =>
      s +
      x.shop_sale_payments
        .filter((p) => p.method === "conta")
        .reduce((t, p) => t + Number(p.amount), 0),
    0,
  );
  const received = receipts.reduce((s, r) => s + Number(r.amount), 0);
  const cashIn = total - onAccount + received;

  // vendas e recebimentos juntos, do mais recente para o mais antigo
  const rows = [
    ...sales.map((s) => ({ type: "venda" as const, at: s.created_at, sale: s })),
    ...receipts.map((r) => ({ type: "recebimento" as const, at: r.created_at, receipt: r })),
  ].sort((a, b) => b.at.localeCompare(a.at));

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
        <div className="ml-auto flex flex-wrap gap-6 text-right text-sm">
          <div>
            <div className="text-muted-foreground">{done.length} vendas</div>
            <div className="text-xl font-semibold">{fmtBRL(total)}</div>
            {onAccount > 0 && (
              <div className="text-xs text-muted-foreground">{fmtBRL(onAccount)} no fiado</div>
            )}
          </div>
          {receipts.length > 0 && (
            <div>
              <div className="text-muted-foreground">
                {receipts.length} recebimentos de pendência
              </div>
              <div className="text-xl font-semibold">{fmtBRL(received)}</div>
            </div>
          )}
          <div>
            <div className="text-muted-foreground">Entrou no caixa</div>
            <div className="text-xl font-semibold text-primary">{fmtBRL(cashIn)}</div>
          </div>
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
              {rows.map((row) => {
                if (row.type === "recebimento") {
                  const r = row.receipt;
                  return (
                    <TableRow key={r.id} className="bg-muted/30">
                      <TableCell>
                        <Badge variant="secondary">recebimento</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {fmtDateTime(r.created_at)}
                      </TableCell>
                      <TableCell>{r.shop_customers?.name ?? "—"}</TableCell>
                      <TableCell className="max-w-72 truncate text-sm text-muted-foreground">
                        Pagamento de pendência{r.notes ? ` — ${r.notes}` : ""}
                      </TableCell>
                      <TableCell className="text-sm">{r.method ? label(r.method) : "—"}</TableCell>
                      <TableCell className="text-right font-medium">{fmtBRL(r.amount)}</TableCell>
                    </TableRow>
                  );
                }
                const s = row.sale;
                return (
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
                      {s.shop_sale_items
                        .map((i) => `${fmtNum(i.qty, 2)}× ${i.description}`)
                        .join(", ")}
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.shop_sale_payments.map((p) => label(p.method)).join(" + ")}
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium ${s.status === "cancelada" ? "line-through opacity-50" : ""}`}
                    >
                      {fmtBRL(s.total)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nenhuma venda ou recebimento no período.
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
                      {fmtNum(i.qty, 2)}× {i.description}{" "}
                      <span className="text-muted-foreground">({fmtBRL(i.unit_price)})</span>
                    </span>
                    <span className="tabular-nums">
                      {fmtBRL(Number(i.total) + Number(i.discount))}
                    </span>
                  </div>
                ))}
              </div>
              {Number(open.discount) > 0 && (
                <div className="text-right">Desconto: − {fmtBRL(open.discount)}</div>
              )}
              <div className="text-right text-lg font-semibold">Total: {fmtBRL(open.total)}</div>
              <div>
                {open.shop_sale_payments.map((p) => (
                  <div key={p.id} className="flex justify-between">
                    <span>{label(p.method)}</span>
                    <span className="tabular-nums">
                      {fmtBRL(p.amount)}{" "}
                      {Number(p.fee_amount) > 0 && (
                        <span className="text-xs text-muted-foreground">
                          (taxa {fmtBRL(p.fee_amount)})
                        </span>
                      )}
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
                  <Input
                    placeholder="Motivo do cancelamento"
                    value={cancelReason}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                </div>
              )}
            </div>
            {open.status !== "cancelada" && (
              <DialogFooter>
                <Button
                  variant="destructive"
                  disabled={!cancelReason.trim()}
                  onClick={async () => {
                    const { error } = await supabase.rpc("shop_cancel_sale", {
                      p_sale_id: open.id,
                      p_reason: cancelReason,
                    });
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
