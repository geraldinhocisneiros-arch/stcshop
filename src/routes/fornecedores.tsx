import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadSuppliers } from "@/lib/data";
import { fetchAll } from "@/lib/fetchAll";
import { fmtBRL, fmtDate, matchesSearch } from "@/lib/format";
import { fmtCnpj, supplierLabel, type Supplier } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MessageCircle, Plus } from "lucide-react";

export const Route = createFileRoute("/fornecedores")({
  head: () => ({ meta: [{ title: "Fornecedores — Squash Tennis Shop" }] }),
  component: FornecedoresPage,
});

interface Stats {
  count: number;
  total: number;
  last: string | null;
}

function FornecedoresPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({});
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Partial<Supplier> | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, inv] = await Promise.all([
        loadSuppliers(),
        fetchAll<{ supplier_id: string | null; total: number | null; issue_date: string | null; created_at: string }>(
          "shop_invoices",
          "supplier_id, total, issue_date, created_at",
        ),
      ]);
      setSuppliers(s);
      const st: Record<string, Stats> = {};
      for (const i of inv) {
        if (!i.supplier_id) continue;
        const r = (st[i.supplier_id] ??= { count: 0, total: 0, last: null });
        r.count++;
        r.total += Number(i.total ?? 0);
        const d = i.issue_date ?? i.created_at;
        if (!r.last || d > r.last) r.last = d;
      }
      setStats(st);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(
    () =>
      suppliers
        .filter((s) => showInactive || s.active)
        .filter((s) => matchesSearch(`${s.name} ${s.trade_name ?? ""} ${s.cnpj ?? ""} ${s.contact_name ?? ""} ${s.city ?? ""}`, search)),
    [suppliers, search, showInactive],
  );

  return (
    <AppLayout
      title="Fornecedores"
      adminOnly
      actions={
        <Button size="sm" onClick={() => setEditing({ active: true })}>
          <Plus className="mr-1 h-4 w-4" /> Novo
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Input className="max-w-sm" placeholder="Buscar por nome, CNPJ, contato…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button size="sm" variant={showInactive ? "default" : "outline"} onClick={() => setShowInactive(!showInactive)}>
          Mostrar inativos
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">{rows.length} fornecedores</span>
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornecedor</TableHead>
                <TableHead>Contato</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead className="text-right">Notas</TableHead>
                <TableHead className="text-right">Total comprado</TableHead>
                <TableHead className="text-right">Última compra</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => {
                const st = stats[s.id];
                return (
                  <TableRow key={s.id} className={cn("cursor-pointer", !s.active && "opacity-50")} onClick={() => setEditing(s)}>
                    <TableCell>
                      <div className="font-medium">{supplierLabel(s)}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.trade_name ? `${s.name} · ` : ""}
                        {fmtCnpj(s.cnpj) || "sem CNPJ"}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {s.contact_name}
                      {s.phone && (
                        <a
                          className="flex items-center gap-1 text-xs text-primary underline"
                          href={`https://wa.me/${whats(s.phone)}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MessageCircle className="h-3 w-3" /> {s.phone}
                        </a>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{s.city ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{st?.count ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtBRL(st?.total ?? 0)}</TableCell>
                    <TableCell className="text-right">{st?.last ? fmtDate(st.last) : "—"}</TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Nenhum fornecedor. Cadastre aqui, ou eles são criados sozinhos ao importar o XML de uma nota.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SupplierDialog supplier={editing} invoices={editing?.id ? (stats[editing.id]?.count ?? 0) : 0} onClose={() => setEditing(null)} onDone={load} />
    </AppLayout>
  );
}

const whats = (phone: string) => {
  const d = phone.replace(/\D/g, "");
  return d.length <= 11 ? `55${d}` : d;
};

function SupplierDialog({
  supplier,
  invoices,
  onClose,
  onDone,
}: {
  supplier: Partial<Supplier> | null;
  invoices: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [f, setF] = useState<Partial<Supplier>>({});
  useEffect(() => {
    if (supplier) setF({ ...supplier, cnpj: fmtCnpj(supplier.cnpj) });
  }, [supplier]);
  if (!supplier) return null;

  const set = (k: keyof Supplier) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const clean = (v: unknown) => (typeof v === "string" ? v.trim() || null : null);

  const save = async () => {
    if (!f.name?.trim()) return toast.error("Informe a razão social ou o nome do fornecedor");
    const cnpj = (f.cnpj ?? "").replace(/\D/g, "");
    if (cnpj && cnpj.length !== 14 && cnpj.length !== 11) return toast.error("CNPJ deve ter 14 números (ou CPF com 11)");
    const row = {
      name: f.name.trim(),
      trade_name: clean(f.trade_name),
      cnpj: cnpj || null,
      contact_name: clean(f.contact_name),
      phone: clean(f.phone),
      email: clean(f.email),
      city: clean(f.city),
      notes: clean(f.notes),
      active: f.active ?? true,
    };
    const res = supplier.id
      ? await supabase.from("shop_suppliers").update(row).eq("id", supplier.id)
      : await supabase.from("shop_suppliers").insert(row);
    if (res.error)
      return toast.error(res.error.message.includes("shop_suppliers_cnpj_uq") ? "Já existe um fornecedor com esse CNPJ" : res.error.message);
    toast.success("Fornecedor salvo");
    onClose();
    onDone();
  };

  const remove = async () => {
    const { error } = await supabase.from("shop_suppliers").delete().eq("id", supplier.id!);
    if (error) return toast.error(error.message);
    toast.success("Fornecedor excluído");
    onClose();
    onDone();
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{supplier.id ? "Editar fornecedor" : "Novo fornecedor"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2">
            <Label>Razão social *</Label>
            <Input value={f.name ?? ""} onChange={set("name")} autoFocus placeholder="Como aparece na nota" />
          </div>
          <div className="space-y-1">
            <Label>Nome fantasia</Label>
            <Input value={f.trade_name ?? ""} onChange={set("trade_name")} placeholder="Como você chama" />
          </div>
          <div className="space-y-1">
            <Label>CNPJ</Label>
            <Input value={f.cnpj ?? ""} onChange={set("cnpj")} inputMode="numeric" />
          </div>
          <div className="space-y-1">
            <Label>Contato (vendedor)</Label>
            <Input value={f.contact_name ?? ""} onChange={set("contact_name")} />
          </div>
          <div className="space-y-1">
            <Label>WhatsApp / telefone</Label>
            <Input value={f.phone ?? ""} onChange={set("phone")} inputMode="tel" />
          </div>
          <div className="space-y-1">
            <Label>E-mail</Label>
            <Input value={f.email ?? ""} onChange={set("email")} type="email" />
          </div>
          <div className="space-y-1">
            <Label>Cidade</Label>
            <Input value={f.city ?? ""} onChange={set("city")} />
          </div>
          <div className="space-y-1 md:col-span-2">
            <Label>Observações</Label>
            <Textarea rows={2} value={f.notes ?? ""} onChange={set("notes")} placeholder="Prazo de entrega, pedido mínimo, condições de pagamento…" />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={f.active ?? true} onCheckedChange={(v) => setF({ ...f, active: v })} id="sup-active" />
            <Label htmlFor="sup-active">Ativo</Label>
          </div>
        </div>
        <DialogFooter className="gap-2">
          {supplier.id && invoices === 0 && (
            <Button variant="ghost" className="mr-auto text-destructive" onClick={remove}>
              Excluir
            </Button>
          )}
          {supplier.id && invoices > 0 && (
            <span className="mr-auto self-center text-xs text-muted-foreground">
              Tem {invoices} nota(s): para tirar da lista, desmarque "Ativo".
            </span>
          )}
          <Button onClick={save}>Salvar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
