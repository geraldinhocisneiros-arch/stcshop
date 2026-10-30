import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AppLayout, Stat } from "@/components/AppLayout";
import { RevenueBars } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadCostStructure, loadSettings } from "@/lib/data";
import { fmtBRL, fmtPct, parseDecimal, round2 } from "@/lib/format";
import { analyzePrice, type CostStructure } from "@/lib/pricing";
import type { Cost, ShopSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute("/custos")({
  head: () => ({ meta: [{ title: "Custos e preços — Squash Tennis Shop" }] }),
  component: CustosPage,
});

const SUGGESTED = [
  "Aluguel / espaço",
  "Salários e encargos",
  "Pró-labore",
  "Energia",
  "Internet / telefone",
  "Sistema / maquininha (mensalidade)",
  "Contador",
  "Marketing",
];

interface Monthly {
  month: string;
  total: number;
  cost: number;
  fees: number;
  sales: number;
}

function CustosPage() {
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [cs, setCs] = useState<CostStructure | null>(null);
  const [costs, setCosts] = useState<Cost[]>([]);
  const [monthly, setMonthly] = useState<Monthly[]>([]);
  const [editing, setEditing] = useState<Partial<Cost> | null>(null);
  const [simCost, setSimCost] = useState("100");

  const load = useCallback(async () => {
    try {
      const s = await loadSettings();
      const r = await loadCostStructure(s);
      setSettings(s);
      setCs(r.cs);
      setCosts(r.costs);
      setMonthly(r.monthly);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (!cs || !settings) return <AppLayout title="Custos e preços" adminOnly>Carregando…</AppLayout>;

  const fixed = costs.filter((c) => c.kind === "fixo");
  const pct = costs.filter((c) => c.kind === "percentual");
  const target = settings.target_margin_pct / 100;

  // margem de contribuição real dos últimos 3 meses fechados (receita − mercadoria − taxas − % variáveis)
  const closed = monthly.slice(0, 4).filter((m) => m.month < new Date().toISOString().slice(0, 7)).slice(0, 3);
  const rev = closed.reduce((s, m) => s + m.total, 0);
  const contribution = rev > 0 ? (rev - closed.reduce((s, m) => s + m.cost + m.fees, 0) - rev * cs.taxesAndCommissions) / rev : null;
  const breakEvenRevenue = contribution && contribution > 0 ? cs.fixedMonthly / contribution : null;

  const sim = analyzePrice(0, parseDecimal(simCost), cs, target);
  const markup = sim.suggestedPrice && sim.cost ? sim.suggestedPrice / sim.cost : null;

  const history = [...monthly].reverse().map((m) => {
    const variable = m.total * cs.taxesAndCommissions;
    return { ...m, result: round2(m.total - m.cost - m.fees - variable - cs.fixedMonthly) };
  });

  return (
    <AppLayout
      title="Custos e preços"
      adminOnly
      actions={
        <Button size="sm" onClick={() => setEditing({ kind: "fixo", active: true, category: "Outros" })}>
          <Plus className="mr-1 h-4 w-4" /> Novo custo
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Custo fixo mensal" value={fmtBRL(cs.fixedMonthly)} hint={`${fixed.filter((c) => c.active).length} itens`} />
          <Stat
            label="Custo fixo / faturamento"
            value={fmtPct(cs.fixed)}
            hint={
              cs.revenueBaseSource === "historico"
                ? `sobre média de ${fmtBRL(cs.revenueBase)}/mês`
                : cs.revenueBaseSource === "estimado"
                  ? `sobre faturamento estimado de ${fmtBRL(cs.revenueBase)}`
                  : "informe o faturamento estimado em Configurações"
            }
            tone={cs.revenueBaseSource === "nenhum" ? "warn" : undefined}
          />
          <Stat
            label="Custos variáveis por venda"
            value={fmtPct(cs.variable)}
            hint={`impostos/comissões ${fmtPct(cs.taxesAndCommissions)} + cartão ${fmtPct(cs.cardFee)}`}
          />
          <Stat
            label="Ponto de equilíbrio"
            value={breakEvenRevenue ? fmtBRL(breakEvenRevenue) : "—"}
            hint={
              breakEvenRevenue
                ? `por mês para pagar tudo (margem de contribuição real ${fmtPct(contribution)})`
                : "precisa de pelo menos 1 mês fechado de vendas"
            }
          />
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <CostTable title="Custos fixos (R$ por mês)" rows={fixed} onEdit={setEditing} money />
          <CostTable title="Custos sobre a venda (% do preço)" rows={pct} onEdit={setEditing} />
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Formação de preço</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 text-sm">
              <p>
                Para cada R$ 100 vendidos hoje: <b>{fmtBRL(cs.variable * 100)}</b> vão para impostos, comissões e cartão,{" "}
                <b>{fmtBRL(cs.fixed * 100)}</b> pagam o custo fixo, e você quer <b>{fmtBRL(target * 100)}</b> de lucro. Sobra{" "}
                <b>{fmtBRL((1 - cs.variable - cs.fixed - target) * 100)}</b> para pagar a mercadoria.
              </p>
              <p className="text-muted-foreground">
                Por isso o preço é custo ÷ (1 − {fmtPct(cs.variable + cs.fixed + target)}), e não custo × um número fixo. Se a soma
                passar de 100%, nenhum preço resolve — o problema é custo fixo alto demais para o faturamento.
              </p>
            </div>
            <div className="space-y-2 rounded-md bg-muted p-3 text-sm">
              <Label>Simular: produto que custa (R$)</Label>
              <Input value={simCost} onChange={(e) => setSimCost(e.target.value)} className="bg-background" />
              <div className="grid grid-cols-2 gap-2 pt-2">
                <span>Liquidação (só custo + variáveis):</span>
                <b className="text-right">{fmtBRL(sim.floorPrice)}</b>
                <span>Equilíbrio (lucro zero):</span>
                <b className="text-right">{fmtBRL(sim.breakEvenPrice)}</b>
                <span>Com {settings.target_margin_pct}% de lucro:</span>
                <b className="text-right text-primary">{fmtBRL(sim.suggestedPrice)}</b>
                <span>Markup equivalente:</span>
                <b className="text-right">{markup ? `${markup.toFixed(2).replace(".", ",")}×` : "—"}</b>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Resultado estimado por mês</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <RevenueBars data={history.map((h) => ({ label: h.month.slice(5) + "/" + h.month.slice(2, 4), value: h.total, hint: `resultado ${fmtBRL(h.result)}` }))} height={200} />
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Mês</TableHead>
                    <TableHead className="text-right">Faturamento</TableHead>
                    <TableHead className="text-right">Mercadoria</TableHead>
                    <TableHead className="text-right">Taxas + impostos</TableHead>
                    <TableHead className="text-right">Custo fixo</TableHead>
                    <TableHead className="text-right">Resultado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...history].reverse().map((h) => (
                    <TableRow key={h.month}>
                      <TableCell>{h.month.split("-").reverse().join("/")}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(h.total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(h.cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(h.fees + h.total * cs.taxesAndCommissions)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmtBRL(cs.fixedMonthly)}</TableCell>
                      <TableCell className={cn("text-right font-semibold tabular-nums", h.result < 0 ? "text-destructive" : "text-success")}>
                        {fmtBRL(h.result)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Usa os custos fixos e percentuais cadastrados hoje para todos os meses. É uma estimativa gerencial, não substitui o
              contador.
            </p>
          </CardContent>
        </Card>
      </div>

      <CostDialog cost={editing} onClose={() => setEditing(null)} onDone={load} />
    </AppLayout>
  );
}

function CostTable({ title, rows, onEdit, money }: { title: string; rows: Cost[]; onEdit: (c: Cost) => void; money?: boolean }) {
  const total = rows.filter((r) => r.active).reduce((s, r) => s + Number(r.amount), 0);
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.id} className={cn("cursor-pointer", !c.active && "opacity-50")} onClick={() => onEdit(c)}>
                <TableCell>
                  {c.name}
                  <div className="text-xs text-muted-foreground">{c.category}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{money ? fmtBRL(c.amount) : `${String(c.amount).replace(".", ",")}%`}</TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell className="py-6 text-center text-muted-foreground">
                  {money ? "Cadastre aluguel, salários, energia, sistema…" : "Cadastre o imposto (ex.: Simples 6%) e comissões"}
                </TableCell>
              </TableRow>
            )}
            <TableRow>
              <TableCell className="font-semibold">Total</TableCell>
              <TableCell className="text-right font-semibold tabular-nums">{money ? fmtBRL(total) : `${total.toFixed(2).replace(".", ",")}%`}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function CostDialog({ cost, onClose, onDone }: { cost: Partial<Cost> | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Partial<Cost> & { amountStr?: string }>({});
  useEffect(() => {
    if (cost) setF({ ...cost, amountStr: cost.amount != null ? String(cost.amount).replace(".", ",") : "" });
  }, [cost]);
  if (!cost) return null;
  const save = async () => {
    if (!f.name?.trim()) return toast.error("Informe o nome");
    const row = {
      name: f.name.trim(),
      category: f.category?.trim() || "Outros",
      kind: f.kind ?? "fixo",
      amount: parseDecimal(f.amountStr),
      active: f.active ?? true,
      notes: f.notes ?? null,
    };
    const res = cost.id ? await supabase.from("shop_costs").update(row).eq("id", cost.id) : await supabase.from("shop_costs").insert(row);
    if (res.error) return toast.error(res.error.message);
    onClose();
    onDone();
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{cost.id ? "Editar custo" : "Novo custo"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v as Cost["kind"] })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixo">Fixo — valor em R$ por mês</SelectItem>
              <SelectItem value="percentual">Sobre a venda — % do preço (imposto, comissão)</SelectItem>
            </SelectContent>
          </Select>
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value })} list="cost-names" autoFocus />
            <datalist id="cost-names">
              {(f.kind === "percentual" ? ["Simples Nacional", "Comissão de vendedor", "Comissão do encordoador"] : SUGGESTED).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label>Categoria</Label>
            <Input value={f.category ?? ""} onChange={(e) => setF({ ...f, category: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>{f.kind === "percentual" ? "Percentual (%)" : "Valor mensal (R$)"}</Label>
            <Input value={f.amountStr ?? ""} onChange={(e) => setF({ ...f, amountStr: e.target.value })} />
            {f.kind === "fixo" && (
              <p className="text-xs text-muted-foreground">
                Se a loja divide espaço/funcionário com a academia, lance só a parte que cabe à loja.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={f.active ?? true} onCheckedChange={(v) => setF({ ...f, active: v })} id="c-active" />
            <Label htmlFor="c-active">Ativo</Label>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {cost.id && (
            <Button
              variant="ghost"
              className="mr-auto text-destructive"
              onClick={async () => {
                const { error } = await supabase.from("shop_costs").delete().eq("id", cost.id!);
                if (error) return toast.error(error.message);
                onClose();
                onDone();
              }}
            >
              <Trash2 className="mr-1 h-4 w-4" /> Excluir
            </Button>
          )}
          <Button onClick={save}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
