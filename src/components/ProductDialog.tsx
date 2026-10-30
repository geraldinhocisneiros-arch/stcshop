import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtPct, parseDecimal, round2 } from "@/lib/format";
import { analyzePrice, PRICE_STATUS_LABEL, type CostStructure } from "@/lib/pricing";
import type { Product } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type ProductPrefill = Partial<Pick<Product, "name" | "nf_name" | "code" | "barcode" | "unit" | "cost_price">>;

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const dec = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v).replace(".", ","));

export function ProductDialog({
  open,
  onOpenChange,
  product,
  prefill,
  categories,
  cs,
  targetMargin,
  onSaved,
  allowInitialStock = true,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  product?: Product | null;
  prefill?: ProductPrefill;
  categories: string[];
  cs?: CostStructure | null;
  targetMargin?: number;
  onSaved: (p: Product) => void;
  allowInitialStock?: boolean;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [kind, setKind] = useState<"produto" | "servico">("produto");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const p = product;
    setKind(p?.kind ?? "produto");
    setActive(p?.active ?? true);
    setF({
      name: str(p?.name ?? prefill?.name),
      nf_name: str(p?.nf_name ?? prefill?.nf_name),
      code: str(p?.code ?? prefill?.code),
      barcode: str(p?.barcode ?? prefill?.barcode),
      category: str(p?.category),
      brand: str(p?.brand),
      unit: str(p?.unit ?? prefill?.unit ?? "UN"),
      nf_unit_factor: dec(p?.nf_unit_factor ?? 1),
      sale_price: dec(p?.sale_price),
      promo_price: dec(p?.promo_price),
      promo_until: str(p?.promo_until),
      cost_price: dec(p?.cost_price ?? prefill?.cost_price),
      min_stock: dec(p?.min_stock ?? 0),
      initial_stock: "",
      notes: str(p?.notes),
    });
  }, [open, product, prefill]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const price = parseDecimal(f.sale_price);
  const cost = parseDecimal(f.cost_price);
  const pa = cs ? analyzePrice(price, cost, cs, targetMargin ?? 0) : null;

  const save = async () => {
    if (!f.name?.trim()) return toast.error("Informe o apelido do produto");
    const factor = parseDecimal(f.nf_unit_factor) || 1;
    const row = {
      kind,
      active,
      name: f.name.trim(),
      nf_name: f.nf_name.trim() || null,
      code: f.code.trim() || null,
      barcode: f.barcode.trim() || null,
      category: f.category.trim() || null,
      brand: f.brand.trim() || null,
      unit: f.unit.trim() || "UN",
      nf_unit_factor: factor,
      sale_price: round2(price),
      promo_price: f.promo_price.trim() ? round2(parseDecimal(f.promo_price)) : null,
      promo_until: f.promo_price.trim() && f.promo_until ? f.promo_until : null,
      cost_price: cost,
      min_stock: parseDecimal(f.min_stock),
      notes: f.notes.trim() || null,
    };
    setBusy(true);
    const res = product
      ? await supabase.from("shop_products").update(row).eq("id", product.id).select().single()
      : await supabase.from("shop_products").insert(row).select().single();
    if (res.error) {
      setBusy(false);
      return toast.error(
        res.error.message.includes("shop_products_barcode_uq") ? "Já existe produto com este código de barras" : res.error.message,
      );
    }
    let saved = res.data as Product;
    const initial = parseDecimal(f.initial_stock);
    if (!product && kind === "produto" && initial > 0) {
      const { error } = await supabase.rpc("shop_adjust_stock", {
        p_product_id: saved.id,
        p_kind: "entrada_manual",
        p_qty: initial,
        p_unit_cost: cost || null,
        p_notes: "Estoque inicial",
      });
      if (error) toast.error(`Produto salvo, mas o estoque inicial falhou: ${error.message}`);
      else saved = { ...saved, stock_qty: initial };
    }
    setBusy(false);
    toast.success(product ? "Produto atualizado" : "Produto cadastrado");
    onSaved(saved);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{product ? "Editar produto" : "Novo produto"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label>Tipo</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "produto" | "servico")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="produto">Produto (controla estoque)</SelectItem>
                <SelectItem value="servico">Serviço (ex.: encordoamento)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end gap-2 pb-2">
            <Switch checked={active} onCheckedChange={setActive} id="active" />
            <Label htmlFor="active">Ativo (aparece no caixa)</Label>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Apelido — como você procura no caixa *</Label>
            <Input value={f.name ?? ""} onChange={set("name")} placeholder="Ex.: Bola Wilson US Open" autoFocus />
          </div>
          {kind === "produto" && (
            <div className="space-y-1 md:col-span-2">
              <Label>Nome na nota fiscal</Label>
              <Input value={f.nf_name ?? ""} onChange={set("nf_name")} placeholder="Ex.: BOLA TENIS WILSON US OPEN TB C/3" />
              <p className="text-xs text-muted-foreground">
                Igual à descrição da nota do fornecedor. Não precisa digitar: na primeira importação de nota o sistema preenche e
                memoriza.
              </p>
            </div>
          )}
          <div className="space-y-1">
            <Label>Categoria</Label>
            <Input value={f.category ?? ""} onChange={set("category")} list="cats" placeholder="Ex.: Bolas, Cordas, Raquetes" />
            <datalist id="cats">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label>Marca</Label>
            <Input value={f.brand ?? ""} onChange={set("brand")} />
          </div>
          {kind === "produto" && (
            <>
              <div className="space-y-1">
                <Label>Código de barras (EAN)</Label>
                <Input value={f.barcode ?? ""} onChange={set("barcode")} />
              </div>
              <div className="space-y-1">
                <Label>Código do fornecedor / interno</Label>
                <Input value={f.code ?? ""} onChange={set("code")} />
              </div>
              <div className="space-y-1">
                <Label>Unidade de venda</Label>
                <Input value={f.unit ?? ""} onChange={set("unit")} placeholder="UN, TUBO, SET…" />
              </div>
              <div className="space-y-1">
                <Label>1 unidade da nota = quantas de venda?</Label>
                <Input value={f.nf_unit_factor ?? ""} onChange={set("nf_unit_factor")} />
                <p className="text-xs text-muted-foreground">Ex.: rolo de corda de 200 m que rende 16 encordoamentos = 16.</p>
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label>Preço de venda (R$)</Label>
            <Input value={f.sale_price ?? ""} onChange={set("sale_price")} className="text-lg font-semibold" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>Preço promocional</Label>
              <Input value={f.promo_price ?? ""} onChange={set("promo_price")} placeholder="—" />
            </div>
            <div className="space-y-1">
              <Label>Promoção até</Label>
              <Input type="date" value={f.promo_until ?? ""} onChange={set("promo_until")} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>{kind === "produto" ? "Custo médio (R$)" : "Custo direto por serviço (R$)"}</Label>
            <Input value={f.cost_price ?? ""} onChange={set("cost_price")} />
            <p className="text-xs text-muted-foreground">
              {kind === "produto"
                ? "Atualizado automaticamente a cada nota importada (média ponderada)."
                : "Ex.: comissão paga ao encordoador por raquete. A mão de obra fixa entra em Custos."}
            </p>
          </div>
          {kind === "produto" && (
            <>
              <div className="space-y-1">
                <Label>Estoque mínimo</Label>
                <Input value={f.min_stock ?? ""} onChange={set("min_stock")} />
              </div>
              {!product && allowInitialStock && (
                <div className="space-y-1">
                  <Label>Estoque inicial</Label>
                  <Input value={f.initial_stock ?? ""} onChange={set("initial_stock")} placeholder="0" />
                </div>
              )}
            </>
          )}
          <div className="space-y-1 md:col-span-2">
            <Label>Observações</Label>
            <Textarea value={f.notes ?? ""} onChange={set("notes")} rows={2} />
          </div>
        </div>

        {pa && price > 0 && (
          <div
            className={cn(
              "mt-2 rounded-md border p-3 text-sm",
              pa.status === "prejuizo" && "border-destructive/50 bg-destructive/5",
              pa.status === "abaixo_meta" && "border-warning/60 bg-warning/10",
            )}
          >
            <div className="mb-2 font-medium">
              Análise do preço: {PRICE_STATUS_LABEL[pa.status]}
              {pa.status !== "sem_custo" && ` — lucro líquido de ${fmtBRL(pa.netProfitPerUnit)} por unidade (${fmtPct(pa.netMargin)})`}
            </div>
            {pa.status !== "sem_custo" && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-4">
                <span>Margem bruta: {fmtPct(pa.grossMargin)}</span>
                <span>Contribuição: {fmtPct(pa.contributionMargin)}</span>
                <span>Equilíbrio: {fmtBRL(pa.breakEvenPrice)}</span>
                <span>
                  Para {fmtPct(targetMargin, 0)} de lucro: <b>{fmtBRL(pa.suggestedPrice)}</b>
                </span>
              </div>
            )}
            {pa.suggestedPrice && Math.abs(pa.suggestedPrice - price) > 0.5 && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setF({ ...f, sale_price: dec(Math.ceil(pa.suggestedPrice! * 10) / 10) })}
              >
                Usar preço sugerido
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Salvando…" : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
