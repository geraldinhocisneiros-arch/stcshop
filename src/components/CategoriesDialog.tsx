import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadCategories } from "@/lib/data";
import { normalizeText } from "@/lib/format";
import type { Category, Product } from "@/lib/types";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

/** Cadastro de categorias: criar, renomear (leva junto os produtos) e excluir. */
export function CategoriesDialog({
  open,
  onOpenChange,
  products,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  products: Product[];
  onChanged: () => void;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(() => {
    loadCategories()
      .then(setCategories)
      .catch((e) => toast.error(`Não consegui carregar as categorias: ${errMsg(e)}`));
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const count = (name: string) => products.filter((p) => normalizeText(p.category) === normalizeText(name)).length;

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    const { error } = await supabase.from("shop_categories").insert({ name });
    if (error) return toast.error(error.message.includes("shop_categories_name_uq") ? "Essa categoria já existe" : error.message);
    setNewName("");
    load();
  };

  const rename = async () => {
    if (!editing) return;
    const { error } = await supabase.rpc("shop_rename_category", { p_id: editing.id, p_name: editing.name });
    if (error) return toast.error(error.message);
    setEditing(null);
    load();
    onChanged();
  };

  const remove = async (c: Category) => {
    const n = count(c.name);
    if (n > 0 && !window.confirm(`${n} produto(s) estão em "${c.name}" e ficarão sem categoria. Excluir mesmo assim?`)) return;
    const { error } = await supabase.rpc("shop_delete_category", { p_id: c.id });
    if (error) return toast.error(error.message);
    load();
    onChanged();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Categorias</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="Nova categoria (ex.: Bolas, Cordas, Raquetes)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            autoFocus
          />
          <Button onClick={add} disabled={!newName.trim()}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="divide-y rounded-md border">
          {categories.map((c) => (
            <div key={c.id} className="flex items-center gap-2 p-2 text-sm">
              {editing?.id === c.id ? (
                <>
                  <Input
                    className="h-8"
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && rename()}
                    autoFocus
                  />
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={rename}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{count(c.name)} produtos</span>
                  <Button size="icon" variant="ghost" className="h-8 w-8" title="Renomear" onClick={() => setEditing({ id: c.id, name: c.name })}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" title="Excluir" onClick={() => remove(c)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          ))}
          {categories.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">Nenhuma categoria ainda.</p>}
        </div>
        <p className="text-xs text-muted-foreground">Renomear atualiza todos os produtos da categoria. Excluir deixa os produtos sem categoria.</p>
      </DialogContent>
    </Dialog>
  );
}
