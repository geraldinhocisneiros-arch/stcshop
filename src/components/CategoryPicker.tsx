import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadCategories } from "@/lib/data";
import { matchesSearch, normalizeText } from "@/lib/format";
import type { Category } from "@/lib/types";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { toast } from "sonner";

/** Lista suspensa de categorias, com busca e "criar nova" direto na lista. */
export function CategoryPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setSearch("");
    loadCategories()
      .then(setCategories)
      .catch((e) => toast.error(`Não consegui carregar as categorias: ${errMsg(e)}`));
  }, [open]);

  const typed = search.trim();
  const exists = categories.some((c) => normalizeText(c.name) === normalizeText(typed));

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const create = async () => {
    const { data, error } = await supabase.from("shop_categories").insert({ name: typed }).select("id, name").single();
    if (error) return toast.error(error.message);
    setCategories((cs) => [...cs, data as Category]);
    toast.success(`Categoria "${typed}" criada`);
    pick(typed);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          <span className={value ? "" : "text-muted-foreground"}>{value || "Escolher categoria…"}</span>
          <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command filter={(v, s) => (v === "__new__" || matchesSearch(v, s) ? 1 : 0)}>
          <CommandInput placeholder="Buscar ou digitar nova…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>Nenhuma categoria.</CommandEmpty>
            <CommandGroup>
              {categories.map((c) => (
                <CommandItem key={c.id} value={c.name} onSelect={() => pick(c.name)}>
                  <Check className={`mr-2 h-4 w-4 ${value === c.name ? "opacity-100" : "opacity-0"}`} />
                  {c.name}
                </CommandItem>
              ))}
              {value && (
                <CommandItem value="sem categoria" onSelect={() => pick("")} className="text-muted-foreground">
                  <span className="ml-6">Sem categoria</span>
                </CommandItem>
              )}
            </CommandGroup>
            {typed && !exists && (
              <CommandGroup>
                <CommandItem value="__new__" onSelect={create} className="text-primary">
                  <Plus className="mr-2 h-4 w-4" /> Criar categoria "{typed}"
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
