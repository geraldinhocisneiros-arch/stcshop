import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { AccountEntryDialog, CustomerDialog } from "@/components/CustomerDialogs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { balanceOf, buildCharge, DEBIT_KINDS, debtDescription, ENTRY_LABEL } from "@/lib/accounts";
import { errMsg, loadCustomerEntries, loadMethods, loadSaleDescriptions, loadSettings } from "@/lib/data";
import { fmtBRL, fmtDateTime, round2 } from "@/lib/format";
import type { Customer, CustomerEntry, PaymentMethod } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowLeft, HandCoins, MessageCircle, Pencil, SlidersHorizontal } from "lucide-react";

export const Route = createFileRoute("/clientes/$id")({
  head: () => ({ meta: [{ title: "Extrato do cliente — Squash Tennis Shop" }] }),
  component: ExtratoPage,
});

function ExtratoPage() {
  const { id } = Route.useParams();
  const { isAdmin } = useAuth();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [entries, setEntries] = useState<CustomerEntry[]>([]);
  const [sales, setSales] = useState<Record<string, { number: number; items: string }>>({});
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [pixKey, setPixKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [entryMode, setEntryMode] = useState<"pagamento" | "ajuste" | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, e, m, s] = await Promise.all([
        supabase.from("shop_customers").select("*").eq("id", id).single(),
        loadCustomerEntries([id]),
        loadMethods(),
        loadSettings(),
      ]);
      if (c.error) throw c.error;
      setCustomer(c.data as Customer);
      setEntries(e);
      setMethods(m);
      setPixKey(s.pix_key ?? null);
      setSales(await loadSaleDescriptions(e.map((x) => x.sale_id).filter(Boolean) as string[]));
    } catch (err) {
      toast.error(errMsg(err));
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const balance = balanceOf(entries);
  const charge = useMemo(() => (customer ? buildCharge(customer, entries, sales, pixKey) : null), [customer, entries, sales, pixKey]);
  const openIds = new Set(charge?.debts.map((d) => d.entry.id));

  // extrato com saldo acumulado, mais recente primeiro
  const statement = useMemo(() => {
    let run = 0;
    return [...entries]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((e) => {
        run = round2(run + (DEBIT_KINDS.has(e.kind) ? 1 : -1) * Number(e.amount));
        return { e, run };
      })
      .reverse();
  }, [entries]);

  if (!customer) return <AppLayout title="Extrato do cliente">Carregando…</AppLayout>;
  const label = (c: string | null) => methods.find((m) => m.code === c)?.label ?? c ?? "";

  return (
    <AppLayout
      title={customer.name}
      actions={
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil className="mr-1 h-4 w-4" /> Editar
        </Button>
      }
    >
      <Link to="/clientes" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
        <ArrowLeft className="h-4 w-4" /> Clientes
      </Link>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Saldo"
          value={balance > 0 ? fmtBRL(balance) : balance < 0 ? `crédito ${fmtBRL(-balance)}` : "Em dia"}
          tone={balance > 0 ? "bad" : balance < 0 ? "good" : undefined}
          hint={balance > 0 ? "a receber" : undefined}
        />
        <Stat label="Limite" value={customer.credit_limit != null ? fmtBRL(customer.credit_limit) : "Sem limite"} />
        <Stat label="WhatsApp" value={<span className="text-base">{customer.phone ?? "—"}</span>} />
        <Stat
          label="Compra mais antiga em aberto"
          value={charge?.debts[0] ? `${charge.debts[0].daysOpen} dias` : "—"}
          tone={(charge?.debts[0]?.daysOpen ?? 0) > 30 ? "bad" : undefined}
        />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        <Button onClick={() => setEntryMode("pagamento")} disabled={balance <= 0}>
          <HandCoins className="mr-1 h-4 w-4" /> Receber pagamento
        </Button>
        <Button
          variant="outline"
          disabled={!charge?.link || balance <= 0}
          title={!customer.phone ? "Cadastre o WhatsApp do cliente" : undefined}
          onClick={() => charge?.link && window.open(charge.link, "_blank")}
        >
          <MessageCircle className="mr-1 h-4 w-4" /> Cobrar no WhatsApp
        </Button>
        {isAdmin && (
          <Button variant="ghost" onClick={() => setEntryMode("ajuste")}>
            <SlidersHorizontal className="mr-1 h-4 w-4" /> Ajuste / saldo anterior
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Lançamento</TableHead>
                <TableHead className="text-right">Débito</TableHead>
                <TableHead className="text-right">Crédito</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statement.map(({ e, run }) => {
                const debit = DEBIT_KINDS.has(e.kind);
                const sale = e.sale_id ? sales[e.sale_id] : undefined;
                return (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs">{fmtDateTime(e.created_at)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{ENTRY_LABEL[e.kind]}</span>
                        {sale && <span className="text-xs text-muted-foreground">venda nº {sale.number}</span>}
                        {e.kind === "pagamento" && <Badge variant="secondary">{label(e.method)}</Badge>}
                        {openIds.has(e.id) && <Badge variant="destructive">em aberto</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {debit ? debtDescription(e, sales) : e.notes}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">{debit ? fmtBRL(e.amount) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums text-success">{!debit ? fmtBRL(e.amount) : ""}</TableCell>
                    <TableCell className={cn("text-right font-medium tabular-nums", run > 0 && "text-destructive")}>{fmtBRL(run)}</TableCell>
                  </TableRow>
                );
              })}
              {statement.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Nenhum lançamento. Venda na "Conta do cliente" pelo caixa para lançar aqui.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {editing && <CustomerDialog customer={customer} onClose={() => setEditing(false)} onSaved={(c) => setCustomer(c)} />}
      <AccountEntryDialog mode={entryMode} customer={customer} balance={balance} onClose={() => setEntryMode(null)} onDone={load} />
    </AppLayout>
  );
}
