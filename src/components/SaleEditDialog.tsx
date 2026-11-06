import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CustomerPicker } from "@/components/CustomerPicker";
import { ProductPicker } from "@/components/ProductPicker";
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadCustomers, loadProducts, type CustomerWithBalance } from "@/lib/data";
import { effectivePrice, fmtBRL, fmtNum, parseDecimal, round2 } from "@/lib/format";
import type { PaymentMethod, Product } from "@/lib/types";
import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export interface EditableSale {
  id: string;
  number: number;
  session_id: string;
  customer_id?: string | null;
  customer_name: string | null;
  discount: number;
  shop_sale_items: Array<{
    product_id: string;
    description: string;
    qty: number;
    unit_price: number;
  }>;
  shop_sale_payments: Array<{ method: string; amount: number }>;
}

interface Line {
  key: string;
  product_id: string;
  name: string;
  qty: number;
  unit_price: number;
  /** preço com que já estava na venda (vendedor pode manter) */
  original_price: number | null;
}
interface Pay {
  key: number;
  method: string;
  amount: number;
}

/**
 * Editar uma venda já feita: itens, quantidades, preço (admin), desconto,
 * cliente e formas de pagamento. O banco acerta estoque e fiado pela diferença
 * e guarda o "antes e depois" com o motivo.
 */
export function SaleEditDialog({
  sale,
  methods,
  onClose,
  onSaved,
}: {
  sale: EditableSale | null;
  methods: PaymentMethod[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [discountInput, setDiscountInput] = useState("");
  const [customer, setCustomer] = useState<CustomerWithBalance | null>(null);
  const [pays, setPays] = useState<Pay[]>([]);
  const [reason, setReason] = useState("");
  const [sessionClosed, setSessionClosed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!sale) return;
    setLines(
      mergeLines(
        sale.shop_sale_items.map((i, n) => ({
          key: `o${n}`,
          product_id: i.product_id,
          name: i.description,
          qty: Number(i.qty),
          unit_price: Number(i.unit_price),
          original_price: Number(i.unit_price),
        })),
      ),
    );
    setDiscountInput(
      Number(sale.discount) > 0 ? Number(sale.discount).toFixed(2).replace(".", ",") : "",
    );
    setPays(
      sale.shop_sale_payments.map((p, i) => ({
        key: i,
        method: p.method,
        amount: Number(p.amount),
      })),
    );
    setReason("");
    setCustomer(null);
    (async () => {
      try {
        const [ps, s, cs] = await Promise.all([
          loadProducts(),
          supabase
            .from("shop_cash_sessions")
            .select("status")
            .eq("id", sale.session_id)
            .maybeSingle(),
          sale.customer_id ? loadCustomers() : Promise.resolve([] as CustomerWithBalance[]),
        ]);
        setProducts(ps);
        setSessionClosed((s.data as { status: string } | null)?.status === "fechado");
        if (sale.customer_id) setCustomer(cs.find((c) => c.id === sale.customer_id) ?? null);
      } catch (e) {
        toast.error(errMsg(e));
      }
    })();
  }, [sale]);

  const activeProducts = useMemo(() => products.filter((p) => p.active), [products]);
  const subtotal = round2(lines.reduce((s, l) => s + round2(l.qty * l.unit_price), 0));
  const discount = round2(Math.min(subtotal, Math.max(0, parseDecimal(discountInput))));
  const total = round2(subtotal - discount);
  const paid = round2(pays.reduce((s, p) => s + p.amount, 0));
  const remaining = round2(total - paid);
  const hasConta = pays.some((p) => p.method === "conta");

  const addProduct = (id: string) => {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product_id === id);
      if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...ls,
        {
          key: `n${Date.now()}`,
          product_id: p.id,
          name: p.name,
          qty: 1,
          unit_price: effectivePrice(p),
          original_price: null,
        },
      ];
    });
    if (p.kind === "produto" && Number(p.stock_qty) <= 0)
      toast.warning(`"${p.name}" está sem estoque no sistema`);
  };

  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) =>
      ls.map((l) => (l.key === key ? { ...l, ...patch } : l)).filter((l) => l.qty > 0),
    );

  const fillRemaining = (key: number) =>
    setPays((ps) =>
      ps.map((p) => (p.key === key ? { ...p, amount: round2(p.amount + remaining) } : p)),
    );

  const addPay = () => {
    const used = new Set(pays.map((p) => p.method));
    const m =
      methods.find((x) => x.active && !used.has(x.code) && x.code !== "conta") ??
      methods.find((x) => !used.has(x.code));
    if (!m) return;
    setPays((ps) => [...ps, { key: Date.now(), method: m.code, amount: Math.max(0, remaining) }]);
  };

  const save = async () => {
    if (!sale) return;
    if (lines.length === 0)
      return toast.error(
        "A venda precisa de pelo menos um item. Para desfazer tudo, cancele a venda.",
      );
    if (Math.abs(remaining) > 0.009) return toast.error("Os pagamentos precisam fechar o total");
    if (pays.some((p) => p.amount <= 0))
      return toast.error("Remova as formas de pagamento sem valor");
    if (new Set(pays.map((p) => p.method)).size !== pays.length)
      return toast.error("Forma de pagamento repetida: junte numa linha só");
    if (hasConta && !customer) return toast.error("Escolha o cliente para lançar na conta");
    if (!reason.trim()) return toast.error("Informe o motivo da alteração");
    setBusy(true);
    const { error } = await supabase.rpc("shop_edit_sale", {
      p_sale_id: sale.id,
      p_items: lines.map((l) => ({
        product_id: l.product_id,
        qty: l.qty,
        unit_price: l.unit_price,
      })),
      p_payments: pays.map((p) => ({ method: p.method, amount: p.amount })),
      p_discount: discount,
      p_customer_id: customer?.id ?? null,
      p_customer_name: customer ? null : sale.customer_id ? null : sale.customer_name,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(`Venda nº ${sale.number} alterada — ${fmtBRL(total)}`);
    onSaved();
  };

  return (
    <Dialog open={!!sale} onOpenChange={(v) => !v && !busy && onClose()}>
      {sale && (
        <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar venda nº {sale.number}</DialogTitle>
          </DialogHeader>

          {sessionClosed && (
            <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                O caixa desta venda <b>já foi fechado e conferido</b>. Mudar valor ou forma de
                pagamento altera o relatório desse fechamento e vai aparecer diferença entre o
                vendido e o que foi contado.
              </span>
            </div>
          )}

          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <Label>Itens</Label>
              <div className="divide-y rounded-md border">
                {lines.map((l) => (
                  <div key={l.key} className="flex flex-wrap items-center gap-2 p-2">
                    <div className="min-w-0 flex-1 font-medium">{l.name}</div>
                    <Input
                      key={`q-${l.key}-${l.qty}`}
                      className="h-8 w-16 text-center"
                      aria-label="Quantidade"
                      defaultValue={String(l.qty).replace(".", ",")}
                      onBlur={(e) => setLine(l.key, { qty: parseDecimal(e.target.value) })}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                    <span className="text-muted-foreground">×</span>
                    <Input
                      key={`p-${l.key}-${l.unit_price}`}
                      className="h-8 w-24 text-right"
                      aria-label="Preço unitário"
                      defaultValue={l.unit_price.toFixed(2).replace(".", ",")}
                      onBlur={(e) =>
                        setLine(l.key, { unit_price: round2(parseDecimal(e.target.value)) })
                      }
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                    />
                    <span className="w-24 text-right font-semibold tabular-nums">
                      {fmtBRL(l.qty * l.unit_price)}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => setLine(l.key, { qty: 0 })}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                {lines.length === 0 && (
                  <p className="p-3 text-center text-muted-foreground">Nenhum item.</p>
                )}
              </div>
              <ProductPicker
                products={activeProducts}
                value={null}
                onChange={addProduct}
                placeholder="+ Adicionar produto…"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Cliente</Label>
                <CustomerPicker
                  value={customer}
                  onChange={(c) => {
                    setCustomer(c);
                    if (!c) setPays((ps) => ps.filter((p) => p.method !== "conta"));
                  }}
                />
                {!customer && sale.customer_name && !sale.customer_id && (
                  <p className="text-xs text-muted-foreground">
                    Nome na venda: {sale.customer_name}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Desconto (R$)</Label>
                <Input
                  value={discountInput}
                  onChange={(e) => setDiscountInput(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            <div className="space-y-1 rounded-md bg-muted p-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="tabular-nums">{fmtBRL(subtotal)}</span>
              </div>
              {discount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Desconto</span>
                  <span className="tabular-nums">− {fmtBRL(discount)}</span>
                </div>
              )}
              <div className="flex justify-between text-lg font-bold">
                <span>Total</span>
                <span className="tabular-nums">{fmtBRL(total)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Pagamento</Label>
              {pays.map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <Select
                    value={p.method}
                    onValueChange={(v) =>
                      setPays((ps) => ps.map((x) => (x.key === p.key ? { ...x, method: v } : x)))
                    }
                  >
                    <SelectTrigger className="h-8 w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {methods
                        .filter((m) => m.active || m.code === p.method)
                        .map((m) => (
                          <SelectItem
                            key={m.code}
                            value={m.code}
                            disabled={m.code === "conta" && !customer}
                          >
                            {m.code === "conta" && !customer
                              ? `${m.label} — escolha o cliente`
                              : m.label}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <Input
                    key={`a-${p.key}-${p.amount}`}
                    className="h-8 text-right"
                    defaultValue={p.amount.toFixed(2).replace(".", ",")}
                    onBlur={(e) => {
                      const v = round2(parseDecimal(e.target.value));
                      setPays((ps) => ps.map((x) => (x.key === p.key ? { ...x, amount: v } : x)));
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                  {Math.abs(remaining) > 0.009 && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      onClick={() => fillRemaining(p.key)}
                      title="Ajustar esta forma para fechar o total"
                    >
                      {remaining > 0 ? "+" : "−"}
                      {fmtBRL(Math.abs(remaining))}
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => setPays((ps) => ps.filter((x) => x.key !== p.key))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={addPay}
                  disabled={pays.length >= methods.length}
                >
                  <Plus className="mr-1 h-3 w-3" /> Forma de pagamento
                </Button>
                <span
                  className={
                    Math.abs(remaining) > 0.009 ? "font-semibold text-destructive" : "text-success"
                  }
                >
                  {Math.abs(remaining) <= 0.009
                    ? "Pagamento fecha o total"
                    : `${remaining > 0 ? "Falta" : "Sobra"} ${fmtBRL(Math.abs(remaining))}`}
                </span>
              </div>
            </div>

            <div className="space-y-1 border-t pt-3">
              <Label>Motivo da alteração (obrigatório — fica no histórico da venda)</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ex.: cliente trocou o tamanho; pagou no PIX e não no cartão"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Estoque e conta do cliente são acertados pela diferença. O número, o caixa e a data da
              venda continuam os mesmos.
              {lines.some((l) => l.original_price == null) &&
                " Item novo entra com o custo atual do produto."}
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Voltar
            </Button>
            <Button
              onClick={save}
              disabled={busy || lines.length === 0 || Math.abs(remaining) > 0.009 || !reason.trim()}
            >
              {busy
                ? "Salvando…"
                : `Salvar alteração (${fmtNum(lines.length)} ${lines.length === 1 ? "item" : "itens"})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Junta linhas do mesmo produto (a venda pode ter o mesmo produto em duas linhas). */
function mergeLines(ls: Line[]): Line[] {
  const out: Line[] = [];
  for (const l of ls) {
    const i = out.findIndex((x) => x.product_id === l.product_id && x.unit_price === l.unit_price);
    if (i >= 0) out[i] = { ...out[i], qty: out[i].qty + l.qty };
    else out.push(l);
  }
  return out;
}
