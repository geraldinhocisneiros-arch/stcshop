import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { fmtBRL, parseDecimal, round2 } from "@/lib/format";
import type { CashSession, CashSummary, PaymentMethod } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/**
 * Fechamento: o sistema calcula o esperado por forma de pagamento e você
 * informa o que conferiu (dinheiro contado na gaveta; cartão/PIX pelo
 * relatório da maquininha/banco). A diferença fica registrada no fechamento.
 */
export function CashCloseDialog({
  open,
  onOpenChange,
  session,
  methods,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: CashSession;
  methods: PaymentMethod[];
  onClosed: (id: string) => void;
}) {
  const [summary, setSummary] = useState<CashSummary | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    supabase.rpc("shop_cash_summary", { p_session_id: session.id }).then(({ data, error }) => {
      if (error) return toast.error(error.message);
      const s = data as CashSummary;
      setSummary(s);
      // dinheiro começa vazio (tem que contar); os outros vêm preenchidos com o esperado
      setCounted(
        Object.fromEntries(
          Object.entries(s.expected).map(([k, v]) => [k, k === "dinheiro" ? "" : String(v).replace(".", ",")]),
        ),
      );
    });
  }, [open, session.id]);

  const label = (code: string) => methods.find((m) => m.code === code)?.label ?? code;
  const codes = summary
    ? Object.keys(summary.expected).filter((k) => summary.expected[k] !== 0 || k === "dinheiro")
    : [];

  const confirm = async () => {
    if (!summary) return;
    if (counted.dinheiro === "" || counted.dinheiro === undefined) return toast.error("Conte o dinheiro da gaveta");
    setBusy(true);
    const payload = Object.fromEntries(codes.map((c) => [c, round2(parseDecimal(counted[c]))]));
    const { error } = await supabase.rpc("shop_close_cash", {
      p_session_id: session.id,
      p_counted: payload,
      p_notes: notes || null,
    });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Caixa fechado");
    onOpenChange(false);
    onClosed(session.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Fechar caixa</DialogTitle>
        </DialogHeader>
        {!summary ? (
          <p className="text-muted-foreground">Calculando…</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center text-sm">
              <div className="rounded-md bg-muted p-2">
                <div className="text-xs text-muted-foreground">Vendas</div>
                <div className="font-semibold">{summary.sales.count}</div>
              </div>
              <div className="rounded-md bg-muted p-2">
                <div className="text-xs text-muted-foreground">Faturado</div>
                <div className="font-semibold">{fmtBRL(summary.sales.total)}</div>
              </div>
              <div className="rounded-md bg-muted p-2">
                <div className="text-xs text-muted-foreground">Canceladas</div>
                <div className="font-semibold">{summary.sales.canceled}</div>
              </div>
            </div>
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_100px_110px_90px] gap-2 text-xs font-medium text-muted-foreground">
                <span>Forma</span>
                <span className="text-right">Esperado</span>
                <span className="text-right">Conferido</span>
                <span className="text-right">Diferença</span>
              </div>
              {codes.map((c) => {
                const exp = Number(summary.expected[c]);
                const diff = counted[c] === "" ? null : round2(parseDecimal(counted[c]) - exp);
                return (
                  <div key={c} className="grid grid-cols-[1fr_100px_110px_90px] items-center gap-2 text-sm">
                    <span>{label(c)}</span>
                    <span className="text-right tabular-nums">{fmtBRL(exp)}</span>
                    <Input
                      className="h-8 text-right"
                      value={counted[c] ?? ""}
                      onChange={(e) => setCounted({ ...counted, [c]: e.target.value })}
                      autoFocus={c === "dinheiro"}
                    />
                    <span
                      className={cn(
                        "text-right tabular-nums",
                        diff !== null && diff < 0 && "text-destructive",
                        diff !== null && diff > 0 && "text-warning-foreground",
                      )}
                    >
                      {diff === null ? "—" : fmtBRL(diff)}
                    </span>
                  </div>
                );
              })}
              {(summary.on_account ?? 0) > 0 && (
                <p className="text-xs">
                  Vendido na conta de clientes (fiado): <b>{fmtBRL(summary.on_account)}</b> — não entra no caixa, fica em Pendências.
                </p>
              )}
              {summary.receipts && Object.keys(summary.receipts).length > 0 && (
                <p className="text-xs">
                  Recebido de dívidas de clientes (já somado no esperado):{" "}
                  {Object.entries(summary.receipts)
                    .map(([k, v]) => `${label(k)} ${fmtBRL(v)}`)
                    .join(" · ")}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Dinheiro esperado = troco inicial {fmtBRL(session.opening_amount)} + vendas e recebimentos em dinheiro + suprimentos{" "}
                {fmtBRL(summary.suprimento)} − sangrias {fmtBRL(summary.sangria)}.
              </p>
            </div>
            <div className="space-y-1">
              <Label>Observações</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Explique diferenças, se houver" />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Voltar
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy || !summary}>
            {busy ? "Fechando…" : "Confirmar fechamento"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
