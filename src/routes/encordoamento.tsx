import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { ProductPicker } from "@/components/ProductPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { errMsg, loadProducts } from "@/lib/data";
import { fmtBRL, fmtDateTime, parseDecimal } from "@/lib/format";
import type { Product, StringingOrder } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MessageCircle, Plus } from "lucide-react";

export const Route = createFileRoute("/encordoamento")({
  head: () => ({ meta: [{ title: "Encordoamento — Squash Tennis Shop" }] }),
  component: EncordoamentoPage,
});

const STATUS: Record<StringingOrder["status"], { label: string; next?: StringingOrder["status"]; nextLabel?: string }> = {
  recebida: { label: "Recebida", next: "em_andamento", nextLabel: "Iniciar" },
  em_andamento: { label: "Em andamento", next: "pronta", nextLabel: "Marcar pronta" },
  pronta: { label: "Pronta" },
  entregue: { label: "Entregue" },
  cancelada: { label: "Cancelada" },
};

function EncordoamentoPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<StringingOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [tab, setTab] = useState<"abertas" | "pronta" | "entregue">("abertas");
  const [dialog, setDialog] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, p] = await Promise.all([
        supabase.from("shop_stringing_orders").select("*").order("created_at", { ascending: false }).limit(500),
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
    tab === "abertas" ? o.status === "recebida" || o.status === "em_andamento" : tab === "pronta" ? o.status === "pronta" : o.status === "entregue" || o.status === "cancelada",
  );
  const counts = {
    abertas: orders.filter((o) => o.status === "recebida" || o.status === "em_andamento").length,
    pronta: orders.filter((o) => o.status === "pronta").length,
  };

  const setStatus = async (o: StringingOrder, status: StringingOrder["status"]) => {
    const patch: Partial<StringingOrder> = { status };
    if (status === "pronta") patch.ready_at = new Date().toISOString();
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
        <Button size="sm" onClick={() => setDialog(true)}>
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
          const late = o.due_at && new Date(o.due_at) < new Date() && (o.status === "recebida" || o.status === "em_andamento");
          const st = STATUS[o.status];
          const str = o.string_product_id ? byId.get(o.string_product_id)?.name : o.string_description;
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
                  <Badge variant={o.status === "pronta" ? "default" : "secondary"}>{st.label}</Badge>
                </div>
                <div>
                  <b>Raquete:</b> {o.racket || "—"}
                </div>
                <div>
                  <b>Corda:</b> {str || "—"} {!o.string_product_id && o.string_description && <span className="text-xs">(do cliente)</span>}
                </div>
                <div>
                  <b>Tensão:</b> {o.tension_main ?? "—"}
                  {o.tension_cross && o.tension_cross !== o.tension_main ? ` / ${o.tension_cross}` : ""} lb
                </div>
                {o.due_at && (
                  <div className={cn(late && "font-semibold text-destructive")}>
                    <b>Entrega:</b> {fmtDateTime(o.due_at)}
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
                      <Button size="sm" onClick={() => navigate({ to: "/caixa", search: { ordem: o.id } })}>
                        Cobrar no caixa
                      </Button>
                      {o.customer_phone && (
                        <Button size="sm" variant="outline" onClick={() => whatsapp(o)}>
                          <MessageCircle className="mr-1 h-4 w-4" /> Avisar
                        </Button>
                      )}
                    </>
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

      <NewOrderDialog open={dialog} onOpenChange={setDialog} products={products} userId={user?.id} onDone={load} />
    </AppLayout>
  );
}

function NewOrderDialog({
  open,
  onOpenChange,
  products,
  userId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  products: Product[];
  userId?: string;
  onDone: () => void;
}) {
  const services = products.filter((p) => p.kind === "servico");
  const strings = products.filter((p) => p.kind === "produto");
  const [f, setF] = useState<Record<string, string>>({});
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [stringId, setStringId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const svc = services.find((s) => /encord/i.test(s.name)) ?? services[0];
    setServiceId(svc?.id ?? null);
    setStringId(null);
    setF({ price: svc ? String(svc.sale_price).replace(".", ",") : "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.customer_name?.trim()) return toast.error("Informe o cliente");
    if (!serviceId) return toast.error("Cadastre um serviço de encordoamento em Produtos (tipo Serviço)");
    const main = f.tension_main ? parseDecimal(f.tension_main) : null;
    const { error } = await supabase.from("shop_stringing_orders").insert({
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
      created_by: userId,
    });
    if (error) return toast.error(error.message);
    toast.success("Ordem criada");
    onOpenChange(false);
    onDone();
  };

  const stringProduct = strings.find((s) => s.id === stringId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Nova ordem de encordoamento</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label>Cliente *</Label>
            <Input value={f.customer_name ?? ""} onChange={set("customer_name")} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>WhatsApp</Label>
            <Input value={f.customer_phone ?? ""} onChange={set("customer_phone")} placeholder="(81) 99999-9999" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Raquete</Label>
            <Input value={f.racket ?? ""} onChange={set("racket")} placeholder="Ex.: Babolat Pure Aero 2023" />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Serviço</Label>
            <ProductPicker
              products={services}
              value={serviceId}
              onChange={(id) => {
                setServiceId(id);
                const s = services.find((x) => x.id === id);
                if (s) setF({ ...f, price: String(s.sale_price).replace(".", ",") });
              }}
              placeholder="Escolher serviço…"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Corda da loja (sai do estoque e é cobrada à parte)</Label>
            <div className="flex gap-2">
              <ProductPicker products={strings} value={stringId} onChange={setStringId} placeholder="Nenhuma — cliente trouxe a corda" />
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
              <Input value={f.string_description ?? ""} onChange={set("string_description")} placeholder="Ex.: Luxilon ALU Power 1.25" />
            </div>
          )}
          <div className="space-y-1">
            <Label>Tensão verticais (lb)</Label>
            <Input value={f.tension_main ?? ""} onChange={set("tension_main")} />
          </div>
          <div className="space-y-1">
            <Label>Tensão horizontais (lb)</Label>
            <Input value={f.tension_cross ?? ""} onChange={set("tension_cross")} placeholder="igual" />
          </div>
          <div className="space-y-1">
            <Label>Entrega</Label>
            <Input type="datetime-local" value={f.due_at ?? ""} onChange={set("due_at")} />
          </div>
          <div className="space-y-1">
            <Label>Valor do serviço (R$)</Label>
            <Input value={f.price ?? ""} onChange={set("price")} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Observações</Label>
            <Textarea rows={2} value={f.notes ?? ""} onChange={set("notes")} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>Criar ordem</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
