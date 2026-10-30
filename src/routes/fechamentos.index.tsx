import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, fmtDateTime, round2 } from "@/lib/format";
import type { CashSession } from "@/lib/types";
import { toast } from "sonner";

export const Route = createFileRoute("/fechamentos/")({
  head: () => ({ meta: [{ title: "Fechamentos — Squash Tennis Shop" }] }),
  component: FechamentosPage,
});

function FechamentosPage() {
  const [rows, setRows] = useState<CashSession[]>([]);
  useEffect(() => {
    supabase
      .from("shop_cash_sessions")
      .select("*")
      .order("opened_at", { ascending: false })
      .limit(200)
      .then(({ data, error }) => (error ? toast.error(error.message) : setRows((data ?? []) as CashSession[])));
  }, []);

  return (
    <AppLayout title="Fechamentos de caixa">
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Abertura</TableHead>
                <TableHead>Fechamento</TableHead>
                <TableHead className="text-right">Vendas</TableHead>
                <TableHead className="text-right">Faturado</TableHead>
                <TableHead className="text-right">Diferença</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const diff =
                  r.expected && r.counted
                    ? round2(Object.keys(r.counted).reduce((s, k) => s + Number(r.counted![k]) - Number(r.expected![k] ?? 0), 0))
                    : null;
                return (
                  <TableRow key={r.id}>
                    <TableCell>{fmtDateTime(r.opened_at)}</TableCell>
                    <TableCell>{r.status === "aberto" ? <Badge>Aberto</Badge> : fmtDateTime(r.closed_at)}</TableCell>
                    <TableCell className="text-right">{r.summary?.sales.count ?? "—"}</TableCell>
                    <TableCell className="text-right">{r.summary ? fmtBRL(r.summary.sales.total) : "—"}</TableCell>
                    <TableCell className={`text-right ${diff && diff < 0 ? "text-destructive" : ""}`}>
                      {diff === null ? "—" : fmtBRL(diff)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link to="/fechamentos/$id" params={{ id: r.id }} className="text-sm text-primary underline">
                        {r.status === "aberto" ? "Parcial" : "Relatório"}
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nenhum caixa ainda.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </AppLayout>
  );
}
