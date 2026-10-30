import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { loadMethods } from "@/lib/data";
import { fmtBRL, parseDecimal } from "@/lib/format";
import type { Customer, PaymentMethod } from "@/lib/types";
import { toast } from "sonner";

/** Cadastro / edição de cliente. */
export function CustomerDialog({
  customer,
  onClose,
  onSaved,
}: {
  customer: Partial<Customer> | null;
  onClose: () => void;
  onSaved: (c: Customer) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!customer) return;
    setActive(customer.active ?? true);
    setF({
      name: customer.name ?? "",
      phone: customer.phone ?? "",
      document: customer.document ?? "",
      email: customer.email ?? "",
      credit_limit: customer.credit_limit != null ? String(customer.credit_limit).replace(".", ",") : "",
      notes: customer.notes ?? "",
    });
  }, [customer]);
  if (!customer) return null;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    if (!f.name.trim()) return toast.error("Informe o nome");
    const row = {
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      document: f.document.trim() || null,
      email: f.email.trim() || null,
      credit_limit: f.credit_limit.trim() ? parseDecimal(f.credit_limit) : null,
      notes: f.notes.trim() || null,
      active,
    };
    const res = customer.id
      ? await supabase.from("shop_customers").update(row).eq("id", customer.id).select("*").single()
      : await supabase.from("shop_customers").insert(row).select("*").single();
    if (res.error) return toast.error(res.error.message);
    toast.success("Cliente salvo");
    onSaved(res.data as Customer);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{customer.id ? "Editar cliente" : "Novo cliente"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2">
            <Label>Nome *</Label>
            <Input value={f.name ?? ""} onChange={set("name")} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>WhatsApp</Label>
            <Input value={f.phone ?? ""} onChange={set("phone")} inputMode="tel" placeholder="81 99999-9999" />
          </div>
          <div className="space-y-1">
            <Label>CPF</Label>
            <Input value={f.document ?? ""} onChange={set("document")} inputMode="numeric" />
          </div>
          <div className="space-y-1">
            <Label>E-mail</Label>
            <Input value={f.email ?? ""} onChange={set("email")} type="email" />
          </div>
          <div className="space-y-1">
            <Label>Limite de crédito (R$)</Label>
            <Input value={f.credit_limit ?? ""} onChange={set("credit_limit")} inputMode="decimal" placeholder="Sem limite" />
            <p className="text-xs text-muted-foreground">Vendedor não consegue passar disso no fiado.</p>
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Observações</Label>
            <Textarea rows={2} value={f.notes ?? ""} onChange={set("notes")} placeholder="Ex.: aluno do professor X, paga todo dia 10" />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={active} onCheckedChange={setActive} id="cust-active" />
            <Label htmlFor="cust-active">Ativo</Label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Receber pagamento de dívida (entra no caixa aberto) ou, para o admin, lançar ajuste. */
export function AccountEntryDialog({
  mode,
  customer,
  balance,
  onClose,
  onDone,
}: {
  mode: "pagamento" | "ajuste" | null;
  customer: Customer;
  balance: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("pix");
  const [kind, setKind] = useState<"ajuste_debito" | "ajuste_credito">("ajuste_debito");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mode) return;
    setAmount(mode === "pagamento" && balance > 0 ? String(balance).replace(".", ",") : "");
    setNotes("");
    setKind("ajuste_debito");
    loadMethods().then((m) => setMethods(m.filter((x) => x.active && x.code !== "conta")));
  }, [mode, balance]);
  if (!mode) return null;

  const save = async () => {
    const v = parseDecimal(amount);
    if (v <= 0) return toast.error("Informe o valor");
    setBusy(true);
    const { error } =
      mode === "pagamento"
        ? await supabase.rpc("shop_customer_payment", { p_customer_id: customer.id, p_amount: v, p_method: method, p_notes: notes || null })
        : await supabase.rpc("shop_customer_adjust", { p_customer_id: customer.id, p_kind: kind, p_amount: v, p_notes: notes });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(mode === "pagamento" ? `Pagamento de ${fmtBRL(v)} registrado no caixa` : "Ajuste lançado");
    onClose();
    onDone();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "pagamento" ? "Receber pagamento" : "Ajuste na conta"} — {customer.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Saldo atual: {balance > 0 ? <b className="text-destructive">deve {fmtBRL(balance)}</b> : balance < 0 ? `crédito de ${fmtBRL(-balance)}` : "em dia"}
          </p>
          {mode === "ajuste" && (
            <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ajuste_debito">Lançar débito (ex.: dívida de antes do sistema)</SelectItem>
                <SelectItem value="ajuste_credito">Lançar crédito (ex.: perdão, correção, troca)</SelectItem>
              </SelectContent>
            </Select>
          )}
          <div className="space-y-1">
            <Label>Valor (R$)</Label>
            <Input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {mode === "pagamento" && (
            <div className="space-y-1">
              <Label>Como pagou</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((m) => (
                    <SelectItem key={m.code} value={m.code}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Entra no caixa aberto agora e aparece no fechamento.</p>
            </div>
          )}
          <div className="space-y-1">
            <Label>{mode === "ajuste" ? "Motivo *" : "Observação"}</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy ? "Salvando…" : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
