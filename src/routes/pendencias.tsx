import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { AccountEntryDialog } from "@/components/CustomerDialogs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { buildCharge, debtDescription } from "@/lib/accounts";
import { errMsg, loadCustomerEntries, loadCustomers, loadSaleDescriptions, loadSettings, type CustomerWithBalance } from "@/lib/data";
import { fmtBRL, fmtDate, matchesSearch } from "@/lib/format";
import type { CustomerEntry } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { HandCoins, MessageCircle } from "lucide-react";

export const Route = createFileRoute("/pendencias")({
  head: () => ({ meta: [{ title: "Pendências — Squash Tennis Shop" }] }),
  component: PendenciasPage,
});

function PendenciasPage() {
  const [customers, setCustomers] = useState<CustomerWithBalance[]>([]);
  const [entries, setEntries] = useState<CustomerEntry[]>([]);
  const [sales, setSales] = useState<Record<string, { number: number; items: string }>>({});
  const [pixKey, setPixKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [paying, setPaying] = useState<CustomerWithBalance | null>(null);

  const load = useCallback(async () => {
    try {
      const [cs, st] = await Promise.all([loadCustomers(), loadSettings()]);
      const debtors = cs.filter((c) => c.balance > 0);
      const es = await loadCustomerEntries(debtors.map((c) => c.id));
      setCustomers(debtors);
      setEntries(es);
      setPixKey(st.pix_key ?? null);
      setSales(await loadSaleDescriptions(es.map((e) => e.sale_id).filter(Boolean) as string[]));
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () =>
      customers
        .map((c) => ({ c, charge: buildCharge(c, entries.filter((e) => e.customer_id === c.id), sales, pixKey) }))
        .filter((r) => r.charge.debts.length > 0)
        .filter((r) => matchesSearch(`${r.c.name} ${r.c.phone ?? ""}`, search))
        // quem deve há mais tempo primeiro
        .sort((a, b) => b.charge.debts[0].daysOpen - a.charge.debts[0].daysOpen),
    [customers, entries, sales, pixKey, search],
  );
  const total = rows.reduce((s, r) => s + r.charge.total, 0);
  const late = rows.filter((r) => r.charge.debts[0].daysOpen > 30);

  return (
    <AppLayout title="Pendências">
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Total a receber" value={fmtBRL(total)} tone={total > 0 ? "warn" : undefined} hint={`${rows.length} clientes`} />
        <Stat
          label="Há mais de 30 dias"
          value={fmtBRL(late.reduce((s, r) => s + r.charge.total, 0))}
          tone={late.length ? "bad" : undefined}
          hint={`${late.length} clientes`}
        />
      </div>
      <Input className="mb-3 max-w-sm" placeholder="Buscar cliente…" value={search} onChange={(e) => setSearch(e.target.value)} />

      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map(({ c, charge }) => (
          <Card key={c.id} className={cn(charge.debts[0].daysOpen > 30 && "border-destructive/50")}>
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <Link to="/clientes/$id" params={{ id: c.id }} className="font-semibold hover:underline">
                    {c.name}
                  </Link>
                  <div className="text-sm text-muted-foreground">{c.phone ?? "sem WhatsApp cadastrado"}</div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-bold text-destructive tabular-nums">{fmtBRL(charge.total)}</div>
                  <div className="text-xs text-muted-foreground">mais antiga há {charge.debts[0].daysOpen} dias</div>
                </div>
              </div>
              <div className="divide-y rounded-md border text-sm">
                {charge.debts.map((d) => (
                  <div key={d.entry.id} className="flex justify-between gap-3 p-2">
                    <div className="min-w-0">
                      <span className="font-medium">{fmtDate(d.entry.created_at)}</span>{" "}
                      <span className="text-muted-foreground">{debtDescription(d.entry, sales)}</span>
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      {fmtBRL(d.remaining)}
                      {d.remaining < Number(d.entry.amount) && (
                        <div className="text-xs text-muted-foreground">de {fmtBRL(d.entry.amount)}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={!charge.link} onClick={() => charge.link && window.open(charge.link, "_blank")}>
                  <MessageCircle className="mr-1 h-4 w-4" /> Cobrar no WhatsApp
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPaying(c)}>
                  <HandCoins className="mr-1 h-4 w-4" /> Receber
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
        {rows.length === 0 && <p className="text-muted-foreground">Nenhuma pendência. Todo mundo em dia.</p>}
      </div>

      {paying && (
        <AccountEntryDialog
          mode="pagamento"
          customer={paying}
          balance={paying.balance}
          onClose={() => setPaying(null)}
          onDone={load}
        />
      )}
    </AppLayout>
  );
}
