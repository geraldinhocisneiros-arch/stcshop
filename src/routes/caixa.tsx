import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { CashCloseDialog } from "@/components/CashCloseDialog";
import { CustomerPicker } from "@/components/CustomerPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadCustomers, loadMethods, loadProducts, type CustomerWithBalance } from "@/lib/data";
import { effectivePrice, fmtBRL, fmtDateTime, fmtNum, matchesSearch, parseDecimal, round2 } from "@/lib/format";
import type { CashSession, PaymentMethod, Product, StringingOrder } from "@/lib/types";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { ArrowDownCircle, ArrowUpCircle, Lock, Minus, Plus, Search, Trash2 } from "lucide-react";

export const Route = createFileRoute("/caixa")({
  head: () => ({ meta: [{ title: "Caixa — Squash Tennis Shop" }] }),
  validateSearch: (s: Record<string, unknown>) => ({ ordem: typeof s.ordem === "string" ? s.ordem : undefined }),
  component: CaixaPage,
});

interface CartItem {
  product: Product;
  qty: number;
  unit_price: number;
}
interface PaymentLine {
  method: string;
  amount: number;
}

function CaixaPage() {
  const { isAdmin } = useAuth();
  const { ordem } = Route.useSearch();
  const navigate = useNavigate();
  const [session, setSession] = useState<CashSession | null | undefined>(undefined);
  const [products, setProducts] = useState<Product[]>([]);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [discountInput, setDiscountInput] = useState("");
  const [discountMode, setDiscountMode] = useState<"valor" | "pct">("valor");
  const [customer, setCustomer] = useState<CustomerWithBalance | null>(null);
  const [payments, setPayments] = useState<PaymentLine[]>([]);
  const [cashReceived, setCashReceived] = useState("");
  const [orderRef, setOrderRef] = useState<StringingOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);
  const [moveDialog, setMoveDialog] = useState<"sangria" | "suprimento" | null>(null);
  const [closeDialog, setCloseDialog] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [s, p, m] = await Promise.all([
        supabase.from("shop_cash_sessions").select("*").eq("status", "aberto").maybeSingle(),
        loadProducts({ onlyActive: true }),
        loadMethods(),
      ]);
      setSession((s.data as CashSession) ?? null);
      setProducts(p);
      setMethods(m.filter((x) => x.active));
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Cobrança de uma ordem de encordoamento: ?ordem=<id>
  useEffect(() => {
    if (!ordem || products.length === 0) return;
    (async () => {
      const { data } = await supabase.from("shop_stringing_orders").select("*").eq("id", ordem).maybeSingle();
      const o = data as StringingOrder | null;
      if (!o || o.sale_id) return;
      const items: CartItem[] = [];
      const service = products.find((p) => p.id === o.service_product_id);
      if (service) items.push({ product: service, qty: 1, unit_price: Number(o.price ?? service.sale_price) });
      const str = products.find((p) => p.id === o.string_product_id);
      if (str) items.push({ product: str, qty: 1, unit_price: effectivePrice(str) });
      setCart(items);
      // tenta achar o cliente cadastrado pelo telefone (ou nome) da ordem
      const digits = (o.customer_phone ?? "").replace(/\D/g, "");
      const all = await loadCustomers().catch(() => []);
      setCustomer(
        all.find((c) => digits && (c.phone ?? "").replace(/\D/g, "").endsWith(digits.slice(-8))) ??
          all.find((c) => c.name.trim().toLowerCase() === o.customer_name.trim().toLowerCase()) ??
          null,
      );
      setOrderRef(o);
    })();
  }, [ordem, products]);

  const results = useMemo(() => {
    if (!search.trim()) return [];
    return products
      .filter((p) => matchesSearch(`${p.name} ${p.nf_name ?? ""} ${p.code ?? ""} ${p.barcode ?? ""} ${p.brand ?? ""}`, search))
      .slice(0, 12);
  }, [products, search]);

  const subtotal = round2(cart.reduce((s, i) => s + i.qty * i.unit_price, 0));
  const discountRaw = parseDecimal(discountInput);
  const discount = round2(
    Math.min(subtotal, Math.max(0, discountMode === "pct" ? (subtotal * discountRaw) / 100 : discountRaw)),
  );
  const total = round2(subtotal - discount);
  const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
  const remaining = round2(total - paid);
  const cashLine = payments.find((p) => p.method === "dinheiro");
  const change = cashLine ? round2(parseDecimal(cashReceived) - cashLine.amount) : 0;

  const add = (p: Product) => {
    setCart((c) => {
      const i = c.findIndex((x) => x.product.id === p.id);
      if (i >= 0) return c.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x));
      return [...c, { product: p, qty: 1, unit_price: effectivePrice(p) }];
    });
    if (p.kind === "produto" && Number(p.stock_qty) <= 0) toast.warning(`"${p.name}" está sem estoque no sistema`);
    setSearch("");
    setPayments([]);
    searchRef.current?.focus();
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const code = search.trim();
    // leitor de código de barras: digita o EAN e dá Enter
    const exact = products.find((p) => p.barcode === code || p.code === code);
    if (exact) return add(exact);
    if (results.length === 1) add(results[0]);
  };

  const setQty = (id: string, qty: number) => {
    setPayments([]);
    setCart((c) => (qty <= 0 ? c.filter((x) => x.product.id !== id) : c.map((x) => (x.product.id === id ? { ...x, qty } : x))));
  };

  const addPayment = (method: string) => {
    if (remaining <= 0) return;
    setPayments((ps) => {
      const i = ps.findIndex((p) => p.method === method);
      if (i >= 0) return ps.map((p, j) => (j === i ? { ...p, amount: round2(p.amount + remaining) } : p));
      return [...ps, { method, amount: remaining }];
    });
  };

  const reset = () => {
    setCart([]);
    setPayments([]);
    setDiscountInput("");
    setCustomer(null);
    setCashReceived("");
    setOrderRef(null);
    if (ordem) navigate({ to: "/caixa", search: { ordem: undefined } });
  };

  const finalize = async () => {
    if (cart.length === 0) return toast.error("Carrinho vazio");
    if (Math.abs(remaining) > 0.009) return toast.error("Os pagamentos precisam fechar o total");
    if (cashLine && parseDecimal(cashReceived) > 0 && change < 0) return toast.error("Valor recebido em dinheiro é menor que o devido");
    if (payments.some((p) => p.method === "conta") && !customer) return toast.error("Escolha o cliente para lançar na conta");
    setBusy(true);
    const { data, error } = await supabase.rpc("shop_finalize_sale", {
      p_items: cart.map((i) => ({ product_id: i.product.id, qty: i.qty, unit_price: i.unit_price })),
      p_payments: payments,
      p_discount: discount,
      p_customer_name: customer ? null : (orderRef?.customer_name ?? null),
      p_notes: null,
      p_stringing_order_id: orderRef?.id ?? null,
      p_customer_id: customer?.id ?? null,
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    const r = data as { number: number; total: number };
    const onAccount = payments.find((p) => p.method === "conta")?.amount ?? 0;
    toast.success(
      `Venda nº ${r.number} registrada — ${fmtBRL(r.total)}${change > 0 ? ` · troco ${fmtBRL(change)}` : ""}${
        onAccount > 0 ? ` · ${fmtBRL(onAccount)} na conta de ${customer?.name}` : ""
      }`,
    );
    reset();
    load();
  };

  if (session === undefined) return <AppLayout title="Caixa">Carregando…</AppLayout>;

  return (
    <AppLayout
      title="Caixa (PDV)"
      actions={
        session && (
          <>
            <Button variant="outline" size="sm" onClick={() => setMoveDialog("sangria")}>
              <ArrowUpCircle className="mr-1 h-4 w-4" /> Sangria
            </Button>
            <Button variant="outline" size="sm" onClick={() => setMoveDialog("suprimento")}>
              <ArrowDownCircle className="mr-1 h-4 w-4" /> Suprimento
            </Button>
            <Button size="sm" variant="destructive" onClick={() => setCloseDialog(true)}>
              <Lock className="mr-1 h-4 w-4" /> Fechar caixa
            </Button>
          </>
        )
      }
    >
      {!session ? (
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-4 pt-6 text-center">
            <p className="text-muted-foreground">O caixa está fechado.</p>
            <Button size="lg" onClick={() => setOpenDialog(true)}>
              Abrir caixa
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              Caixa aberto em {fmtDateTime(session.opened_at)} · troco inicial {fmtBRL(session.opening_amount)}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                ref={searchRef}
                autoFocus
                className="h-11 pl-9 text-base"
                placeholder="Buscar pelo apelido, nome da nota, código ou ler código de barras…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={onSearchKey}
              />
              {results.length > 0 && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-lg">
                  {results.map((p) => (
                    <button
                      key={p.id}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted"
                      onClick={() => add(p)}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{p.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          {p.kind === "servico" ? "Serviço" : `Estoque: ${fmtNum(p.stock_qty, 2)}`}
                          {p.nf_name ? ` · ${p.nf_name}` : ""}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        {effectivePrice(p) !== Number(p.sale_price) && (
                          <div className="text-xs text-muted-foreground line-through">{fmtBRL(p.sale_price)}</div>
                        )}
                        <div className="font-semibold tabular-nums">{fmtBRL(effectivePrice(p))}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {orderRef && (
              <div className="rounded-md border border-primary/30 bg-secondary p-3 text-sm">
                Cobrando a ordem de encordoamento nº {orderRef.number} — {orderRef.customer_name}
                {orderRef.racket ? ` (${orderRef.racket})` : ""}. Ao finalizar, a ordem vira "entregue".
              </div>
            )}

            <Card>
              <CardContent className="p-0">
                {cart.length === 0 ? (
                  <p className="p-8 text-center text-muted-foreground">Busque um produto para começar a venda.</p>
                ) : (
                  <div className="divide-y">
                    {cart.map((i) => (
                      <div key={i.product.id} className="flex flex-wrap items-center gap-3 p-3">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{i.product.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {i.product.kind === "servico" ? "Serviço" : `Em estoque: ${fmtNum(i.product.stock_qty, 2)}`}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setQty(i.product.id, i.qty - 1)}>
                            <Minus className="h-3 w-3" />
                          </Button>
                          <Input
                            key={`${i.product.id}-${i.qty}`}
                            className="h-8 w-16 text-center"
                            defaultValue={String(i.qty).replace(".", ",")}
                            onBlur={(e) => setQty(i.product.id, parseDecimal(e.target.value))}
                            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                          />
                          <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => setQty(i.product.id, i.qty + 1)}>
                            <Plus className="h-3 w-3" />
                          </Button>
                        </div>
                        <div className="w-28">
                          {isAdmin ? (
                            <Input
                              key={`${i.product.id}-${i.unit_price}`}
                              className="h-8 text-right"
                              defaultValue={i.unit_price.toFixed(2).replace(".", ",")}
                              onBlur={(e) => {
                                const v = parseDecimal(e.target.value);
                                setPayments([]);
                                setCart((c) => c.map((x) => (x.product.id === i.product.id ? { ...x, unit_price: v } : x)));
                              }}
                            />
                          ) : (
                            <div className="text-right tabular-nums">{fmtBRL(i.unit_price)}</div>
                          )}
                        </div>
                        <div className="w-24 text-right font-semibold tabular-nums">{fmtBRL(i.qty * i.unit_price)}</div>
                        <Button size="icon" variant="ghost" onClick={() => setQty(i.product.id, 0)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="h-fit lg:sticky lg:top-20">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Pagamento</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <Label>Cliente (opcional)</Label>
                <CustomerPicker
                  value={customer}
                  onChange={(c) => {
                    setCustomer(c);
                    if (!c) setPayments((ps) => ps.filter((p) => p.method !== "conta"));
                  }}
                />
                {customer && (
                  <p className="text-xs text-muted-foreground">
                    {customer.balance > 0 ? (
                      <span className="text-destructive">Já deve {fmtBRL(customer.balance)}</span>
                    ) : customer.balance < 0 ? (
                      <span className="text-success">Tem {fmtBRL(-customer.balance)} de crédito</span>
                    ) : (
                      "Conta em dia"
                    )}
                    {customer.credit_limit != null && ` · limite ${fmtBRL(customer.credit_limit)}`}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label>Desconto</Label>
                <div className="flex gap-2">
                  <Input
                    value={discountInput}
                    onChange={(e) => {
                      setDiscountInput(e.target.value);
                      setPayments([]);
                    }}
                    placeholder="0"
                  />
                  <Button
                    variant="outline"
                    className="w-16"
                    onClick={() => {
                      setDiscountMode(discountMode === "valor" ? "pct" : "valor");
                      setPayments([]);
                    }}
                  >
                    {discountMode === "valor" ? "R$" : "%"}
                  </Button>
                </div>
              </div>
              <div className="space-y-1 rounded-md bg-muted p-3 text-sm">
                <Row label="Subtotal" value={fmtBRL(subtotal)} />
                {discount > 0 && <Row label="Desconto" value={`− ${fmtBRL(discount)}`} />}
                <div className="flex justify-between pt-1 text-xl font-bold">
                  <span>Total</span>
                  <span className="tabular-nums">{fmtBRL(total)}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {methods.map((m) => (
                  <Button
                    key={m.code}
                    variant="outline"
                    className={m.code === "conta" ? "col-span-2" : undefined}
                    disabled={remaining <= 0 || cart.length === 0 || (m.code === "conta" && !customer)}
                    title={m.code === "conta" && !customer ? "Escolha o cliente para lançar na conta" : undefined}
                    onClick={() => addPayment(m.code)}
                  >
                    {m.code === "conta" ? (customer ? `Na conta de ${customer.name.split(" ")[0]}` : "Conta do cliente (escolha o cliente)") : m.label}
                  </Button>
                ))}
              </div>

              {payments.length > 0 && (
                <div className="space-y-2">
                  {payments.map((p) => (
                    <div key={p.method} className="flex items-center gap-2">
                      <Badge variant="secondary" className="w-32 justify-center">
                        {methods.find((m) => m.code === p.method)?.label ?? p.method}
                      </Badge>
                      <Input
                        key={`${p.method}-${p.amount}`}
                        className="h-8 text-right"
                        defaultValue={p.amount.toFixed(2).replace(".", ",")}
                        onBlur={(e) => {
                          const v = round2(parseDecimal(e.target.value));
                          setPayments((ps) => ps.map((x) => (x.method === p.method ? { ...x, amount: v } : x)));
                        }}
                      />
                      <Button size="icon" variant="ghost" onClick={() => setPayments((ps) => ps.filter((x) => x.method !== p.method))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  {cashLine && (
                    <div className="flex items-center gap-2">
                      <Label className="w-32 text-xs">Recebido em dinheiro</Label>
                      <Input className="h-8 text-right" value={cashReceived} onChange={(e) => setCashReceived(e.target.value)} />
                    </div>
                  )}
                  {cashLine && change > 0 && (
                    <div className="text-right text-lg font-semibold text-success">Troco: {fmtBRL(change)}</div>
                  )}
                </div>
              )}

              <Row
                label={remaining >= 0 ? "Falta pagar" : "Pago a mais"}
                value={<span className={remaining !== 0 ? "font-semibold text-destructive" : "text-success"}>{fmtBRL(Math.abs(remaining))}</span>}
              />

              <div className="flex gap-2">
                <Button variant="outline" onClick={reset} disabled={busy}>
                  Limpar
                </Button>
                <Button className="flex-1" size="lg" onClick={finalize} disabled={busy || cart.length === 0 || Math.abs(remaining) > 0.009}>
                  {busy ? "Registrando…" : "Finalizar venda"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <OpenCashDialog open={openDialog} onOpenChange={setOpenDialog} onDone={load} />
      <CashMoveDialog kind={moveDialog} onClose={() => setMoveDialog(null)} />
      {session && (
        <CashCloseDialog
          open={closeDialog}
          onOpenChange={setCloseDialog}
          session={session}
          methods={methods}
          onClosed={(id) => navigate({ to: "/fechamentos/$id", params: { id } })}
        />
      )}
    </AppLayout>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function OpenCashDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Abrir caixa</DialogTitle>
        </DialogHeader>
        <div className="space-y-1">
          <Label>Troco inicial em dinheiro (R$)</Label>
          <Input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,00" />
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              const { error } = await supabase.rpc("shop_open_cash", { p_opening_amount: parseDecimal(amount) });
              if (error) return toast.error(error.message);
              toast.success("Caixa aberto");
              onOpenChange(false);
              onDone();
            }}
          >
            Abrir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CashMoveDialog({ kind, onClose }: { kind: "sangria" | "suprimento" | null; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  useEffect(() => {
    setAmount("");
    setReason("");
  }, [kind]);
  return (
    <Dialog open={!!kind} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{kind === "sangria" ? "Sangria (retirar dinheiro)" : "Suprimento (colocar dinheiro)"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Valor (R$)</Label>
            <Input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Motivo</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={kind === "sangria" ? "Ex.: depósito, pagamento de fornecedor" : "Ex.: reforço de troco"} />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={async () => {
              const v = parseDecimal(amount);
              if (v <= 0) return toast.error("Informe o valor");
              const { error } = await supabase.rpc("shop_cash_movement", { p_kind: kind, p_amount: v, p_reason: reason || null });
              if (error) return toast.error(error.message);
              toast.success("Registrado");
              onClose();
            }}
          >
            Registrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
