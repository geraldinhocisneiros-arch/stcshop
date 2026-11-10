import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { CustomerPicker } from "@/components/CustomerPicker";
import { ProductPicker } from "@/components/ProductPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { errMsg, loadCustomers, loadMethods, loadProducts, type CustomerWithBalance } from "@/lib/data";
import { effectivePrice, fmtBRL, fmtDateTime, parseDecimal, round2 } from "@/lib/format";
import type { PaymentMethod, Product, StringingOrder } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Gift, HandCoins, MessageCircle, Pencil, Plus, Undo2 } from "lucide-react";

export const Route = createFileRoute("/encordoamento")({
  head: () => ({ meta: [{ title: "Encordoamento — Squash Tennis Shop" }] }),
  component: EncordoamentoPage,
});

type StatusInfo = {
  label: string;
  next?: StringingOrder["status"];
  nextLabel?: string;
  prev?: StringingOrder["status"];
  prevLabel?: string;
};

// "entregue" não volta por aqui: está amarrada a uma venda. Para desfazer, cancela-se a venda no caixa,
// e a função de cancelamento devolve a ordem para "pronta".
const STATUS: Record<StringingOrder["status"], StatusInfo> = {
  recebida: { label: "Recebida", next: "em_andamento", nextLabel: "Iniciar" },
  em_andamento: {
    label: "Em andamento",
    next: "pronta",
    nextLabel: "Marcar pronta",
    prev: "recebida",
    prevLabel: "Voltar p/ Recebida",
  },
  pronta: { label: "Pronta", prev: "em_andamento", prevLabel: "Voltar p/ Em andamento" },
  entregue: { label: "Entregue" },
  cancelada: { label: "Cancelada", prev: "recebida", prevLabel: "Reabrir" },
};

function EncordoamentoPage() {
  const { user, isAdmin } = useAuth();
  const [orders, setOrders] = useState<StringingOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tab, setTab] = useState<"abertas" | "pronta" | "entregue">("abertas");
  const [dialog, setDialog] = useState(false);
  const [delivering, setDelivering] = useState<StringingOrder | null>(null);
  const [editing, setEditing] = useState<StringingOrder | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, p] = await Promise.all([
        supabase
          .from("shop_stringing_orders")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(500),
        loadProducts({ onlyActive: true }),
      ]);
      setOrders((o.data ?? []) as StringingOrder[]);
      setProducts(p);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const list = orders.filter((o) =>
    tab === "abertas"
      ? o.status === "recebida" || o.status === "em_andamento"
      : tab === "pronta"
        ? o.status === "pronta"
        : o.status === "entregue" || o.status === "cancelada",
  );
  const counts = {
    abertas: orders.filter((o) => o.status === "recebida" || o.status === "em_andamento").length,
    pronta: orders.filter((o) => o.status === "pronta").length,
  };

  const setStatus = async (o: StringingOrder, status: StringingOrder["status"]) => {
    const patch: Partial<StringingOrder> = { status };
    if (status === "pronta") patch.ready_at = new Date().toISOString();
    else if (o.status === "pronta") patch.ready_at = null;
    const { error } = await supabase.from("shop_stringing_orders").update(patch).eq("id", o.id);
    if (error) return toast.error(error.message);
    load();
  };

  const whatsapp = (o: StringingOrder) => {
    const digits = (o.customer_phone ?? "").replace(/\D/g, "");
    const phone = digits.length <= 11 ? `55${digits}` : digits;
    const msg = `Olá, ${o.customer_name.split(" ")[0]}! Sua raquete${o.racket ? ` (${o.racket})` : ""} está encordoada e pronta para retirada na Squash Tennis Shop.`;
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`, "_blank");
  };

  return (
    <AppLayout
      title="Encordoamento"
      actions={
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setDialog(true);
          }}
        >
          <Plus className="mr-1 h-4 w-4" /> Nova ordem
        </Button>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="mb-4">
        <TabsList>
          <TabsTrigger value="abertas">Na fila ({counts.abertas})</TabsTrigger>
          <TabsTrigger value="pronta">Prontas para retirar ({counts.pronta})</TabsTrigger>
          <TabsTrigger value="entregue">Histórico</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((o) => {
          const late =
            o.due_at &&
            new Date(o.due_at) < new Date() &&
            (o.status === "recebida" || o.status === "em_andamento");
          const st = STATUS[o.status];
          const str = o.string_product_id
            ? byId.get(o.string_product_id)?.name
            : o.string_description;
          return (
            <Card key={o.id} className={cn(late && "border-destructive")}>
              <CardContent className="space-y-2 p-4 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">
                      #{o.number} · {o.customer_name}
                    </div>
                    <div className="text-xs text-muted-foreground">{o.customer_phone}</div>
                  </div>
                  <Badge variant={o.status === "pronta" ? "default" : "secondary"}>
                    {st.label}
                  </Badge>
                </div>
                <div>
                  <b>Raquete:</b> {o.racket || "—"}
                </div>
                <div>
                  <b>Corda:</b> {str || "—"}{" "}
                  {!o.string_product_id && o.string_description && (
                    <span className="text-xs">(do cliente)</span>
                  )}
                </div>
                <div>
                  <b>Tensão:</b> {o.tension_main ?? "—"}
                  {o.tension_cross && o.tension_cross !== o.tension_main
                    ? ` / ${o.tension_cross}`
                    : ""}{" "}
                  lb
                </div>
                {o.due_at && (
                  <div className={cn(late && "font-semibold text-destructive")}>
                    <b>Entrega:</b> {fmtDateTime(o.due_at)}
                  </div>
                )}
                {o.delivered_at && o.status === "entregue" && (
                  <div>
                    <b>Entregue em:</b> {fmtDateTime(o.delivered_at)}
                  </div>
                )}
                {o.status === "entregue" && (
                  <div className="text-xs text-muted-foreground">
                    Para desfazer a entrega, cancele a venda no caixa.
                  </div>
                )}
                {o.notes && <div className="text-xs text-muted-foreground">{o.notes}</div>}
                <div className="font-medium">{fmtBRL(o.price)}</div>
                <div className="flex flex-wrap gap-2 pt-1">
                  {st.next && (
                    <Button size="sm" onClick={() => setStatus(o, st.next!)}>
                      {st.nextLabel}
                    </Button>
                  )}
                  {o.status === "pronta" && (
                    <>
                      <Button size="sm" onClick={() => setDelivering(o)}>
                        Entregue
                      </Button>
                      {o.customer_phone && (
                        <Button size="sm" variant="outline" onClick={() => whatsapp(o)}>
                          <MessageCircle className="mr-1 h-4 w-4" /> Avisar
                        </Button>
                      )}
                    </>
                  )}
                  {st.prev && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (window.confirm(`Ordem #${o.number}: ${st.prevLabel}?`))
                          setStatus(o, st.prev!);
                      }}
                    >
                      <Undo2 className="mr-1 h-4 w-4" /> {st.prevLabel}
                    </Button>
                  )}
                  {EDITABLE.includes(o.status) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(o);
                        setDialog(true);
                      }}
                    >
                      <Pencil className="mr-1 h-4 w-4" /> Editar
                    </Button>
                  )}
                  {(o.status === "recebida" || o.status === "em_andamento") && (
                    <Button size="sm" variant="ghost" onClick={() => setStatus(o, "cancelada")}>
                      Cancelar
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
        {list.length === 0 && <p className="text-muted-foreground">Nenhuma ordem aqui.</p>}
      </div>

      <DeliverDialog order={delivering} products={products} onClose={() => setDelivering(null)} onDone={load} />
      <OrderDialog
        open={dialog}
        onOpenChange={setDialog}
        order={editing}
        products={products}
        userId={user?.id}
        canEditPrice={isAdmin}
        onDone={load}
      />
    </AppLayout>
  );
}

type DeliverChoice = { kind: "pago"; method: string } | { kind: "pendente" } | { kind: "cortesia" };

/**
 * Entrega da raquete pronta. Sempre pergunta como ficou o pagamento e registra
 * a venda (serviço + corda da loja) — assim o valor entra no caixa/relatórios,
 * a corda sai do estoque e o fiado aparece em Pendências.
 */
function DeliverDialog({
  order,
  products,
  onClose,
  onDone,
}: {
  order: StringingOrder | null;
  products: Product[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { isAdmin } = useAuth();
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [cashOpen, setCashOpen] = useState<boolean | null>(null);
  const [customer, setCustomer] = useState<CustomerWithBalance | null>(null);
  const [choice, setChoice] = useState<DeliverChoice | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!order) return;
    setChoice(null);
    setCustomer(null);
    setCashOpen(null);
    (async () => {
      try {
        const [m, s, cs] = await Promise.all([
          loadMethods(),
          supabase.from("shop_cash_sessions").select("id").eq("status", "aberto").maybeSingle(),
          loadCustomers(),
        ]);
        setMethods(m.filter((x) => x.active && x.code !== "conta"));
        setCashOpen(!!s.data);
        // tenta achar o cliente cadastrado pelo telefone (ou nome) da ordem
        const digits = (order.customer_phone ?? "").replace(/\D/g, "");
        setCustomer(
          cs.find((c) => c.active && digits.length >= 8 && (c.phone ?? "").replace(/\D/g, "").endsWith(digits.slice(-8))) ??
            cs.find((c) => c.active && c.name.trim().toLowerCase() === order.customer_name.trim().toLowerCase()) ??
            null,
        );
      } catch (e) {
        toast.error(errMsg(e));
      }
    })();
  }, [order]);

  if (!order) return null;

  const items: { product: Product; unit_price: number }[] = [];
  const service = products.find((p) => p.id === order.service_product_id);
  if (service) items.push({ product: service, unit_price: Number(order.price ?? service.sale_price) });
  const str = order.string_product_id ? products.find((p) => p.id === order.string_product_id) : undefined;
  if (str) items.push({ product: str, unit_price: effectivePrice(str) });
  const total = round2(items.reduce((s, i) => s + i.unit_price, 0));

  const registerCustomer = async () => {
    const { data, error } = await supabase
      .from("shop_customers")
      .insert({ name: order.customer_name.trim(), phone: order.customer_phone?.trim() || null })
      .select("*")
      .single();
    if (error) return toast.error(error.message);
    toast.success("Cliente cadastrado");
    setCustomer({ ...(data as CustomerWithBalance), balance: 0, last_debit_at: null, last_payment_at: null });
  };

  const confirm = async () => {
    if (!choice) return toast.error("Escolha como ficou o pagamento");
    if (!service) return toast.error("Serviço da ordem não encontrado em Produtos");
    if (choice.kind === "pendente" && !customer) return toast.error("Escolha o cliente para lançar como pendente");
    setBusy(true);
    const { data, error } = await supabase.rpc("shop_finalize_sale", {
      p_items: items.map((i) => ({ product_id: i.product.id, qty: 1, unit_price: i.unit_price })),
      p_payments:
        choice.kind === "cortesia" || total === 0
          ? []
          : [{ method: choice.kind === "pendente" ? "conta" : choice.method, amount: total }],
      p_discount: choice.kind === "cortesia" ? total : 0,
      p_customer_name: customer ? null : order.customer_name,
      p_notes: `${choice.kind === "cortesia" ? "Cortesia — " : ""}Encordoamento nº ${order.number}`,
      p_stringing_order_id: order.id,
      p_customer_id: customer?.id ?? null,
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    const r = data as { number: number };
    toast.success(
      choice.kind === "pendente"
        ? `Entregue — ${fmtBRL(total)} lançado como pendente na conta de ${customer?.name}`
        : choice.kind === "cortesia"
          ? `Entregue como cortesia (venda nº ${r.number})`
          : `Entregue — venda nº ${r.number} de ${fmtBRL(total)} registrada`,
    );
    onClose();
    onDone();
  };

  const isSel = (c: DeliverChoice) =>
    choice?.kind === c.kind && (c.kind !== "pago" || (choice.kind === "pago" && choice.method === c.method));

  return (
    <Dialog open={!!order} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Entregar ordem #{order.number} · {order.customer_name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <div className="rounded-md border p-3">
            {items.map((i) => (
              <div key={i.product.id} className="flex justify-between">
                <span>{i.product.name}</span>
                <span className="tabular-nums">{fmtBRL(i.unit_price)}</span>
              </div>
            ))}
            <div className="mt-1 flex justify-between border-t pt-1 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{fmtBRL(total)}</span>
            </div>
          </div>

          {cashOpen === false && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
              O caixa está fechado. Para registrar a entrega,{" "}
              <Link to="/caixa" search={{ ordem: undefined }} className="font-medium underline">
                abra o caixa
              </Link>{" "}
              primeiro.
            </div>
          )}

          <div className="space-y-2">
            <Label>Já foi pago?</Label>
            <div className="grid grid-cols-2 gap-2">
              {methods.map((m) => (
                <Button
                  key={m.code}
                  variant={isSel({ kind: "pago", method: m.code }) ? "default" : "outline"}
                  onClick={() => setChoice({ kind: "pago", method: m.code })}
                >
                  {m.label}
                </Button>
              ))}
              <Button
                variant={isSel({ kind: "pendente" }) ? "default" : "outline"}
                onClick={() => setChoice({ kind: "pendente" })}
              >
                <HandCoins className="mr-1 h-4 w-4" /> Pendente
              </Button>
              <Button
                variant={isSel({ kind: "cortesia" }) ? "default" : "outline"}
                onClick={() => setChoice({ kind: "cortesia" })}
              >
                <Gift className="mr-1 h-4 w-4" /> Cortesia
              </Button>
            </div>
            {choice?.kind === "pendente" && (
              <p className="text-xs text-muted-foreground">O valor vai para a conta do cliente e aparece em Pendências.</p>
            )}
            {choice?.kind === "cortesia" && (
              <p className="text-xs text-muted-foreground">
                Registra a venda com 100% de desconto (o custo da corda continua contando).
                {!isAdmin && " Só o administrador pode dar cortesia."}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label>Cliente{choice?.kind === "pendente" ? " *" : ""}</Label>
            <CustomerPicker value={customer} onChange={setCustomer} />
            {!customer && choice?.kind === "pendente" && (
              <Button size="sm" variant="link" className="h-auto p-0" onClick={registerCustomer}>
                Cadastrar "{order.customer_name}"{order.customer_phone ? ` (${order.customer_phone})` : ""}
              </Button>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button onClick={confirm} disabled={busy || !choice || cashOpen === false}>
            Confirmar entrega
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Só dá para editar enquanto a ordem não foi cobrada nem cancelada.
const EDITABLE: StringingOrder["status"][] = ["recebida", "em_andamento", "pronta"];

const numStr = (n: number | null | undefined) => (n == null ? "" : String(n).replace(".", ","));

// datetime-local espera "YYYY-MM-DDTHH:mm" no fuso local
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function OrderDialog({
  open,
  onOpenChange,
  order,
  products,
  userId,
  canEditPrice,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  order: StringingOrder | null;
  products: Product[];
  userId?: string;
  canEditPrice: boolean;
  onDone: () => void;
}) {
  const isEdit = !!order;
  // na criação qualquer um define o valor; depois de criada, só admin altera
  const priceLocked = isEdit && !canEditPrice;
  const services = products.filter((p) => p.kind === "servico");
  const strings = products.filter((p) => p.kind === "produto");
  const [f, setF] = useState<Record<string, string>>({});
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [stringId, setStringId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (order) {
      setServiceId(order.service_product_id);
      setStringId(order.string_product_id);
      setF({
        customer_name: order.customer_name,
        customer_phone: order.customer_phone ?? "",
        racket: order.racket ?? "",
        string_description: order.string_description ?? "",
        tension_main: numStr(order.tension_main),
        tension_cross: numStr(order.tension_cross),
        due_at: toLocalInput(order.due_at),
        price: numStr(order.price),
        notes: order.notes ?? "",
      });
      return;
    }
    const svc = services.find((s) => /encord/i.test(s.name)) ?? services[0];
    setServiceId(svc?.id ?? null);
    setStringId(null);
    setF({ price: svc ? String(svc.sale_price).replace(".", ",") : "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.customer_name?.trim()) return toast.error("Informe o cliente");
    if (!serviceId)
      return toast.error("Cadastre um serviço de encordoamento em Produtos (tipo Serviço)");
    const main = f.tension_main ? parseDecimal(f.tension_main) : null;
    const data = {
      customer_name: f.customer_name.trim(),
      customer_phone: f.customer_phone?.trim() || null,
      racket: f.racket?.trim() || null,
      service_product_id: serviceId,
      string_product_id: stringId,
      string_description: stringId ? null : f.string_description?.trim() || null,
      tension_main: main,
      tension_cross: f.tension_cross ? parseDecimal(f.tension_cross) : main,
      due_at: f.due_at ? new Date(f.due_at).toISOString() : null,
      price: parseDecimal(f.price),
      notes: f.notes?.trim() || null,
    };
    if (priceLocked) delete (data as Partial<typeof data>).price;
    const { error } = order
      ? await supabase.from("shop_stringing_orders").update(data).eq("id", order.id)
      : await supabase.from("shop_stringing_orders").insert({ ...data, created_by: userId });
    if (error) return toast.error(error.message);
    toast.success(order ? "Ordem atualizada" : "Ordem criada");
    onOpenChange(false);
    onDone();
  };

  const stringProduct = strings.find((s) => s.id === stringId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {order ? `Editar ordem #${order.number}` : "Nova ordem de encordoamento"}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label>Cliente *</Label>
            <Input value={f.customer_name ?? ""} onChange={set("customer_name")} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>WhatsApp</Label>
            <Input
              value={f.customer_phone ?? ""}
              onChange={set("customer_phone")}
              placeholder="(81) 99999-9999"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Raquete</Label>
            <Input
              value={f.racket ?? ""}
              onChange={set("racket")}
              placeholder="Ex.: Babolat Pure Aero 2023"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Serviço</Label>
            <ProductPicker
              products={services}
              value={serviceId}
              onChange={(id) => {
                setServiceId(id);
                const s = services.find((x) => x.id === id);
                if (s && !priceLocked)
                  setF({ ...f, price: String(s.sale_price).replace(".", ",") });
              }}
              placeholder="Escolher serviço…"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Corda da loja (sai do estoque e é cobrada à parte)</Label>
            <div className="flex gap-2">
              <ProductPicker
                products={strings}
                value={stringId}
                onChange={setStringId}
                placeholder="Nenhuma — cliente trouxe a corda"
              />
              {stringId && (
                <Button variant="ghost" size="sm" onClick={() => setStringId(null)}>
                  Limpar
                </Button>
              )}
            </div>
            {stringProduct && (
              <p className="text-xs text-muted-foreground">
                {fmtBRL(stringProduct.sale_price)} · estoque {stringProduct.stock_qty}
              </p>
            )}
          </div>
          {!stringId && (
            <div className="space-y-1 md:col-span-2">
              <Label>Corda do cliente</Label>
              <Input
                value={f.string_description ?? ""}
                onChange={set("string_description")}
                placeholder="Ex.: Luxilon ALU Power 1.25"
              />
            </div>
          )}
          <div className="space-y-1">
            <Label>Tensão verticais (lb)</Label>
            <Input value={f.tension_main ?? ""} onChange={set("tension_main")} />
          </div>
          <div className="space-y-1">
            <Label>Tensão horizontais (lb)</Label>
            <Input
              value={f.tension_cross ?? ""}
              onChange={set("tension_cross")}
              placeholder="igual"
            />
          </div>
          <div className="space-y-1">
            <Label>Entrega</Label>
            <Input type="datetime-local" value={f.due_at ?? ""} onChange={set("due_at")} />
          </div>
          <div className="space-y-1">
            <Label>Valor do serviço (R$)</Label>
            <Input value={f.price ?? ""} onChange={set("price")} disabled={priceLocked} />
            {priceLocked && (
              <p className="text-xs text-muted-foreground">Só administrador altera o valor.</p>
            )}
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Observações</Label>
            <Textarea rows={2} value={f.notes ?? ""} onChange={set("notes")} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>{order ? "Salvar alterações" : "Criar ordem"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
