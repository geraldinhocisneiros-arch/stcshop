import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { errMsg } from "@/lib/data";
import { normalizeText } from "@/lib/format";
import { LISTS, productListValue, type ListKind } from "@/lib/lists";
import type { Category, Product } from "@/lib/types";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

/** Cadastro de categorias ou marcas: criar, renomear (leva junto os produtos), código (marcas) e excluir. */
export function ListManagerDialog({
  kind,
  open,
  onOpenChange,
  products,
  onChanged,
}: {
  kind: ListKind;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  products: Product[];
  onChanged: () => void;
}) {
  const cfg = LISTS[kind];
  const [items, setItems] = useState<Category[]>([]);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; code: string } | null>(null);

  const load = useCallback(() => {
    cfg
      .load()
      .then(setItems)
      .catch((e) => toast.error(`Não consegui carregar as ${cfg.plural.toLowerCase()}: ${errMsg(e)}`));
  }, [cfg]);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const count = (name: string) => products.filter((p) => normalizeText(productListValue(p, kind)) === normalizeText(name)).length;
  const dupMsg = (m: string) =>
    m.includes("_code_uq") ? "Esse código já é de outra marca" : m.includes("_name_uq") ? `Ess${cfg.article} ${cfg.singular} já existe` : m;

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    const row: Record<string, string | null> = cfg.hasCode ? { name, code: newCode.trim() || null } : { name };
    const { error } = await supabase.from(cfg.table).insert(row);
    if (error) return toast.error(dupMsg(error.message));
    setNewName("");
    setNewCode("");
    load();
  };

  const save = async () => {
    if (!editing) return;
    const current = items.find((c) => c.id === editing.id);
    if (current && current.name !== editing.name.trim()) {
      const { error } = await supabase.rpc(cfg.rename, { p_id: editing.id, p_name: editing.name });
      if (error) return toast.error(error.message);
    }
    if (cfg.hasCode && (current?.code ?? "") !== editing.code.trim()) {
      const { error } = await supabase.from(cfg.table).update({ code: editing.code.trim() || null }).eq("id", editing.id);
      if (error) return toast.error(dupMsg(error.message));
    }
    setEditing(null);
    load();
    onChanged();
  };

  const remove = async (c: Category) => {
    const n = count(c.name);
    if (n > 0 && !window.confirm(`${n} produto(s) estão em "${c.name}" e ficarão sem ${cfg.singular}. Excluir mesmo assim?`)) return;
    const { error } = await supabase.rpc(cfg.remove, { p_id: c.id });
    if (error) return toast.error(error.message);
    load();
    onChanged();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{cfg.plural}</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder={cfg.placeholder}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            autoFocus
          />
          {cfg.hasCode && (
            <Input className="w-24" placeholder="Código" value={newCode} onChange={(e) => setNewCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          )}
          <Button onClick={add} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="divide-y rounded-md border">
          {items.map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-2 text-sm">
              {editing?.id === c.id ? (
                <>
                  <Input
                    className="h-8"
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && save()}
                    autoFocus
                  />
                  {cfg.hasCode && (
                    <Input
                      className="h-8 w-20"
                      placeholder="Cód."
                      value={editing.code}
                      onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                      onKeyDown={(e) => e.key === "Enter" && save()}
                    />
                  )}
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={save}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  {cfg.hasCode && <span className="w-10 text-xs tabular-nums text-muted-foreground">{c.code ?? "—"}</span>}
                  <span className="flex-1">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{count(c.name)} produtos</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    title="Editar"
                    onClick={() => setEditing({ id: c.id, name: c.name, code: c.code ?? "" })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="Excluir" onClick={() => remove(c)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          ))}
          {items.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">Nenhum{cfg.article === "a" ? "a" : ""} {cfg.singular} ainda.</p>}
        </div>
        <p className="text-xs text-muted-foreground">
          Renomear atualiza todos os produtos d{cfg.article} {cfg.singular}. Excluir deixa os produtos sem {cfg.singular}.
        </p>
      </DialogContent>
    </Dialog>
  );
}
