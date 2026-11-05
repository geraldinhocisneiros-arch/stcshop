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
import { fmtBRL, isoDay, parseDecimal, round2 } from "@/lib/format";
import { useAuth } from "@/hooks/useAuth";
import { Plus, Trash2 } from "lucide-react";
import type { Customer, PaymentMethod } from "@/lib/types";
import { toast } from "sonner";

/** Pendência trazida do sistema antigo, lançada junto com o cadastro. */
interface OldDebt {
  date: string; // YYYY-MM-DD
  description: string;
  amount: string;
}
const emptyDebt = (): OldDebt => ({ date: isoDay(new Date()), description: "", amount: "" });

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
  const { isAdmin } = useAuth();
  const [debts, setDebts] = useState<OldDebt[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!customer) return;
    setActive(customer.active ?? true);
    setDebts(customer.id ? [] : [emptyDebt()]); // novo cliente já abre com uma linha de dívida antiga
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

  const isNew = !customer.id;
  const filledDebts = debts.filter((d) => d.amount.trim() || d.description.trim());
  const debtsTotal = round2(filledDebts.reduce((t, d) => t + parseDecimal(d.amount), 0));
  const setDebt = (i: number, k: keyof OldDebt, v: string) => setDebts((ds) => ds.map((d, j) => (j === i ? { ...d, [k]: v } : d)));

  const save = async () => {
    if (!f.name.trim()) return toast.error("Informe o nome");
    const today = isoDay(new Date());
    for (const d of filledDebts) {
      if (parseDecimal(d.amount) <= 0) return toast.error("Informe o valor de cada pendência");
      if (!d.date || d.date > today) return toast.error("Data da pendência inválida (não pode ser no futuro)");
    }
    const row = {
      name: f.name.trim(),
      phone: f.phone.trim() || null,
      document: f.document.trim() || null,
      email: f.email.trim() || null,
      credit_limit: f.credit_limit.trim() ? parseDecimal(f.credit_limit) : null,
      notes: f.notes.trim() || null,
      active,
    };
    setBusy(true);
    const res = customer.id
      ? await supabase.from("shop_customers").update(row).eq("id", customer.id).select("*").single()
      : await supabase.from("shop_customers").insert(row).select("*").single();
    if (res.error) {
      setBusy(false);
      return toast.error(res.error.message);
    }
    const saved = res.data as Customer;
    // pendências do sistema antigo: viram "ajuste (débito)" com a data original
    let failed = 0;
    for (const d of isNew ? filledDebts : []) {
      const { error } = await supabase.rpc("shop_customer_adjust", {
        p_customer_id: saved.id,
        p_kind: "ajuste_debito",
        p_amount: parseDecimal(d.amount),
        p_notes: d.description.trim() || "Saldo anterior (sistema antigo)",
        p_date: d.date,
      });
      if (error) {
        failed++;
        toast.error(`Pendência não lançada: ${error.message}`);
      }
    }
    setBusy(false);
    if (failed) toast.warning("Cliente salvo, mas confira as pendências no extrato (Dívida antiga / ajuste).");
    else toast.success(filledDebts.length && isNew ? `Cliente salvo com ${fmtBRL(debtsTotal)} em aberto` : "Cliente salvo");
    onSaved(saved);
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
          {isNew && isAdmin && (
            <div className="space-y-2 rounded-md border p-3 md:col-span-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-base">Dívida antiga (sistema anterior)</Label>
                  <p className="text-xs text-muted-foreground">Opcional. Preencha data, o que foi e o valor — deixe em branco se o cliente não deve nada.</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => setDebts((ds) => [...ds, emptyDebt()])}>
                  <Plus className="mr-1 h-4 w-4" /> Outra dívida
                </Button>
              </div>
              {debts.map((d, i) => (
                <div key={i} className="grid grid-cols-[8.5rem_1fr_6rem_auto] items-center gap-2">
                  <Input type="date" value={d.date} max={isoDay(new Date())} onChange={(e) => setDebt(i, "date", e.target.value)} />
                  <Input placeholder="Ex.: corda + encordoamento" value={d.description} onChange={(e) => setDebt(i, "description", e.target.value)} />
                  <Input placeholder="R$" inputMode="decimal" className="text-right" value={d.amount} onChange={(e) => setDebt(i, "amount", e.target.value)} />
                  <Button type="button" size="icon" variant="ghost" onClick={() => setDebts((ds) => ds.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {debtsTotal > 0 && <p className="text-right text-sm">Total em aberto: <b className="text-destructive">{fmtBRL(debtsTotal)}</b></p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy ? "Salvando…" : "Salvar"}
          </Button>
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
  const [date, setDate] = useState(isoDay(new Date()));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mode) return;
    setDate(isoDay(new Date()));
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
        : await supabase.rpc("shop_customer_adjust", { p_customer_id: customer.id, p_kind: kind, p_amount: v, p_notes: notes, p_date: date });
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
          {mode === "ajuste" && (
            <div className="space-y-1">
              <Label>Data</Label>
              <Input type="date" value={date} max={isoDay(new Date())} onChange={(e) => setDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">Para dívida do sistema antigo, use a data da compra original.</p>
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
