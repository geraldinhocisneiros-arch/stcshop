import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { CustomerDialog } from "@/components/CustomerDialogs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errMsg, loadCustomers, type CustomerWithBalance } from "@/lib/data";
import { fmtBRL, fmtDate, matchesSearch } from "@/lib/format";
import type { Customer } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Plus } from "lucide-react";

export const Route = createFileRoute("/clientes/")({
  head: () => ({ meta: [{ title: "Clientes — Squash Tennis Shop" }] }),
  component: ClientesPage,
});

function ClientesPage() {
  const navigate = useNavigate();
  const [list, setList] = useState<CustomerWithBalance[]>([]);
  const [search, setSearch] = useState("");
  const [onlyDebt, setOnlyDebt] = useState(false);
  const [editing, setEditing] = useState<Partial<Customer> | null>(null);

  const load = useCallback(() => {
    loadCustomers()
      .then(setList)
      .catch((e) => toast.error(errMsg(e)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () =>
      list
        .filter((c) => !onlyDebt || c.balance > 0)
        .filter((c) => matchesSearch(`${c.name} ${c.phone ?? ""} ${(c.phone ?? "").replace(/\D/g, "")} ${c.document ?? ""}`, search)),
    [list, search, onlyDebt],
  );
  const totalDue = list.reduce((s, c) => s + Math.max(0, c.balance), 0);
  const debtors = list.filter((c) => c.balance > 0).length;

  return (
    <AppLayout
      title="Clientes"
      actions={
        <Button size="sm" onClick={() => setEditing({ active: true })}>
          <Plus className="mr-1 h-4 w-4" /> Novo
        </Button>
      }
    >
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Clientes" value={list.filter((c) => c.active).length} />
        <Stat label="A receber" value={fmtBRL(totalDue)} tone={totalDue > 0 ? "warn" : undefined} hint={`${debtors} com saldo devedor`} />
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input className="max-w-sm" placeholder="Buscar por nome, telefone ou CPF…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button size="sm" variant={onlyDebt ? "default" : "outline"} onClick={() => setOnlyDebt(!onlyDebt)}>
          Só quem deve
        </Button>
        <Link to="/pendencias" className="ml-auto text-sm text-primary underline">
          Ver pendências e cobrar
        </Link>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cliente</TableHead>
                <TableHead>WhatsApp</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right">Limite</TableHead>
                <TableHead className="text-right">Última compra na conta</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow
                  key={c.id}
                  className={cn("cursor-pointer", !c.active && "opacity-50")}
                  onClick={() => navigate({ to: "/clientes/$id", params: { id: c.id } })}
                >
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>{c.phone ?? "—"}</TableCell>
                  <TableCell className={cn("text-right font-medium tabular-nums", c.balance > 0 && "text-destructive", c.balance < 0 && "text-success")}>
                    {c.balance > 0 ? fmtBRL(c.balance) : c.balance < 0 ? `crédito ${fmtBRL(-c.balance)}` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{c.credit_limit != null ? fmtBRL(c.credit_limit) : "—"}</TableCell>
                  <TableCell className="text-right">{c.last_debit_at ? fmtDate(c.last_debit_at) : "—"}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Nenhum cliente. Cadastre aqui ou direto no caixa, na hora da venda.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <CustomerDialog
        customer={editing}
        onClose={() => setEditing(null)}
        onSaved={(c) => navigate({ to: "/clientes/$id", params: { id: c.id } })}
      />
    </AppLayout>
  );
}
