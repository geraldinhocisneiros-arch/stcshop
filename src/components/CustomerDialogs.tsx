import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { errMsg, loadCustomers, loadMethods, loadSettings, type CustomerWithBalance } from "@/lib/data";
import { receiptMessage, whatsappLink } from "@/lib/accounts";
import { fmtBRL, matchesSearch, parseDecimal, round2 } from "@/lib/format";
import type { Customer, CustomerEntry, PaymentMethod } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { CheckCircle2, MessageCircle } from "lucide-react";

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

/**
 * Receber pagamento de dívida — total ou parcial (abate da dívida e entra no
 * caixa aberto) — ou, para o admin, lançar ajuste.
 */
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
  const [pixKey, setPixKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("pix");
  const [kind, setKind] = useState<"ajuste_debito" | "ajuste_credito">("ajuste_debito");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ amount: number; remaining: number; methodLabel: string; date: string } | null>(null);

  useEffect(() => {
    if (!mode) return;
    // em branco de propósito: no parcelado o cliente quase nunca paga tudo
    setAmount("");
    setNotes("");
    setKind("ajuste_debito");
    setDone(null);
    loadMethods().then((m) => setMethods(m.filter((x) => x.active && x.code !== "conta")));
    loadSettings()
      .then((st) => setPixKey(st.pix_key ?? null))
      .catch(() => setPixKey(null));
  }, [mode]);
  if (!mode) return null;

  const v = parseDecimal(amount);
  const owed = Math.max(0, balance);
  const after = round2(owed - v);
  const tooMuch = mode === "pagamento" && v > owed + 0.004;

  const close = () => {
    onClose();
    if (done) onDone();
  };

  const save = async () => {
    if (v <= 0) return toast.error("Informe o valor");
    if (tooMuch) return toast.error(`O cliente deve só ${fmtBRL(owed)}`);
    setBusy(true);
    const { error } =
      mode === "pagamento"
        ? await supabase.rpc("shop_customer_payment", { p_customer_id: customer.id, p_amount: v, p_method: method, p_notes: notes || null })
        : await supabase.rpc("shop_customer_adjust", { p_customer_id: customer.id, p_kind: kind, p_amount: v, p_notes: notes });
    setBusy(false);
    if (error) return toast.error(error.message);
    if (mode === "ajuste") {
      toast.success("Ajuste lançado");
      onClose();
      onDone();
      return;
    }
    toast.success(`Pagamento de ${fmtBRL(v)} registrado no caixa`);
    // confere o saldo real no banco (pode ter havido outro lançamento)
    const { data } = await supabase.from("shop_customer_balances").select("balance").eq("customer_id", customer.id).maybeSingle();
    setDone({
      amount: v,
      remaining: data ? Math.max(0, Number(data.balance)) : Math.max(0, after),
      methodLabel: methods.find((m) => m.code === method)?.label ?? method,
      date: new Date().toISOString(),
    });
  };

  if (done) {
    const link = whatsappLink(customer.phone, receiptMessage({ customerName: customer.name, ...done, pixKey }));
    return (
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-success" /> Pagamento registrado
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <Row label="Cliente" value={customer.name} />
            <Row label={`Recebido (${done.methodLabel})`} value={fmtBRL(done.amount)} />
            <Row
              label="Saldo restante"
              value={done.remaining > 0.004 ? fmtBRL(done.remaining) : "Quitado"}
              className={done.remaining > 0.004 ? "text-destructive" : "text-success"}
              strong
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={close}>
              Fechar
            </Button>
            <Button
              disabled={!link}
              title={!customer.phone ? "Cadastre o WhatsApp do cliente" : undefined}
              onClick={() => link && window.open(link, "_blank")}
            >
              <MessageCircle className="mr-1 h-4 w-4" /> Enviar comprovante
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
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
            <Select value={kind} onValueChange={(x) => setKind(x as typeof kind)}>
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
            <Label>{mode === "pagamento" ? "Quanto o cliente está pagando agora (R$)" : "Valor (R$)"}</Label>
            <div className="flex gap-2">
              <Input
                autoFocus
                inputMode="decimal"
                placeholder="0,00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && save()}
                className={cn(tooMuch && "border-destructive")}
              />
              {mode === "pagamento" && owed > 0 && (
                <Button type="button" variant="outline" onClick={() => setAmount(String(owed).replace(".", ","))}>
                  Tudo
                </Button>
              )}
            </div>
          </div>
          {mode === "pagamento" && (
            <>
              <div className="space-y-1 rounded-md border p-3 text-sm">
                <Row label="Deve hoje" value={fmtBRL(owed)} />
                <Row label="Abate agora" value={v > 0 ? `− ${fmtBRL(v)}` : "—"} />
                <Row
                  label="Fica devendo"
                  value={tooMuch ? "valor maior que a dívida" : v > 0 && after <= 0.004 ? "Quitado" : fmtBRL(Math.max(0, after))}
                  className={tooMuch ? "text-destructive" : v > 0 && after <= 0.004 ? "text-success" : "text-destructive"}
                  strong
                />
              </div>
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
            </>
          )}
          <div className="space-y-1">
            <Label>{mode === "ajuste" ? "Motivo *" : "Observação"}</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy || tooMuch || v <= 0}>
            {busy ? "Salvando…" : mode === "pagamento" && v > 0 ? `Receber ${fmtBRL(v)}` : "Confirmar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, className, strong }: { label: string; value: React.ReactNode; className?: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", strong && "font-semibold", className)}>{value}</span>
    </div>
  );
}

/** Pelo caixa: escolher quem está pagando (só aparece quem deve) e receber. */
export function ReceiveFromCustomerDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone?: () => void }) {
  const [list, setList] = useState<CustomerWithBalance[]>([]);
  const [picked, setPicked] = useState<CustomerWithBalance | null>(null);

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    loadCustomers()
      .then((cs) => setList(cs.filter((c) => c.balance > 0).sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => toast.error(errMsg(e)));
  }, [open]);
  if (!open) return null;

  if (picked) {
    return (
      <AccountEntryDialog
        mode="pagamento"
        customer={picked}
        balance={picked.balance}
        onClose={onClose}
        onDone={() => onDone?.()}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="p-0">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Receber de cliente — quem está pagando?</DialogTitle>
        </DialogHeader>
        <Command filter={(val, s) => (matchesSearch(val, s) ? 1 : 0)}>
          <CommandInput placeholder="Buscar por nome ou telefone…" autoFocus />
          <CommandList className="max-h-80">
            <CommandEmpty>Ninguém com dívida em aberto.</CommandEmpty>
            <CommandGroup>
              {list.map((c) => (
                <CommandItem key={c.id} value={`${c.name} ${c.phone ?? ""} ${(c.phone ?? "").replace(/\D/g, "")}`} onSelect={() => setPicked(c)}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.phone ?? "sem telefone"}</div>
                  </div>
                  <span className="text-sm font-medium text-destructive tabular-nums">{fmtBRL(c.balance)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** Estornar um pagamento lançado errado (só com o caixa dele ainda aberto). */
export function ReversePaymentDialog({ entry, onClose, onDone }: { entry: CustomerEntry | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setReason(""), [entry]);
  if (!entry) return null;

  const save = async () => {
    if (!reason.trim()) return toast.error("Informe o motivo");
    setBusy(true);
    const { error } = await supabase.rpc("shop_customer_payment_reverse", { p_entry_id: entry.id, p_reason: reason.trim() });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(`Pagamento de ${fmtBRL(entry.amount)} estornado: saiu do caixa e voltou para a dívida`);
    onClose();
    onDone();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Estornar pagamento de {fmtBRL(entry.amount)}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Use quando o valor foi lançado errado. Ele sai do esperado do caixa e volta para a dívida do cliente. Se o certo era outro
          valor, estorne e lance de novo.
        </p>
        <div className="space-y-1">
          <Label>Motivo *</Label>
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: digitei 300, eram 200" />
        </div>
        <DialogFooter>
          <Button variant="destructive" onClick={save} disabled={busy}>
            {busy ? "Estornando…" : "Estornar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
