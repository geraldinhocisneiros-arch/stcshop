import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { errMsg } from "@/lib/data";
import { fmtBRL, fmtDateTime, parseDecimal, round2 } from "@/lib/format";
import type { Product } from "@/lib/types";
import { toast } from "sonner";

type PriceChange = { id: string; old_price: number | null; new_price: number; changed_by_name: string | null; changed_at: string };

// Janela do vendedor: altera só o preço de venda do cadastro (custo e margem ficam com o administrador).
export function SalePriceDialog({
  open,
  onOpenChange,
  product,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  product: Product | null;
  onSaved: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<PriceChange[]>([]);

  useEffect(() => {
    if (!open || !product) return;
    setValue(String(product.sale_price).replace(".", ","));
    setHistory([]);
    supabase
      .from("shop_price_changes")
      .select("id, old_price, new_price, changed_by_name, changed_at")
      .eq("product_id", product.id)
      .order("changed_at", { ascending: false })
      .limit(5)
      .then(({ data }) => setHistory((data ?? []) as PriceChange[]));
  }, [open, product]);

  const save = async () => {
    if (!product) return;
    const price = round2(parseDecimal(value));
    if (!(price > 0)) return toast.error("Informe um preço válido");
    if (Math.abs(price - Number(product.sale_price)) < 0.005) return onOpenChange(false);
    setBusy(true);
    const { error } = await supabase.rpc("shop_set_sale_price", { p_product_id: product.id, p_price: price });
    setBusy(false);
    if (error) return toast.error(errMsg(error));
    toast.success(`Preço de "${product.name}" alterado para ${fmtBRL(price)}`);
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Alterar preço de venda</DialogTitle>
        </DialogHeader>
        {product && (
          <div className="space-y-3">
            <div className="font-medium">{product.name}</div>
            <div className="space-y-1">
              <Label>Preço de venda (R$)</Label>
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                inputMode="decimal"
                className="text-lg font-semibold"
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Vale para as próximas vendas. A alteração fica registrada com seu nome. Para mudar o preço de uma venda só, altere
                direto no caixa.
              </p>
            </div>
            {history.length > 0 && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Últimas alterações</div>
                {history.map((h) => (
                  <div key={h.id}>
                    {fmtDateTime(h.changed_at)} · {h.changed_by_name || "—"}: {h.old_price == null ? "—" : fmtBRL(h.old_price)} →{" "}
                    {fmtBRL(h.new_price)}
                  </div>
                ))}
              </div>
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
