import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { errMsg } from "@/lib/data";
import { matchesSearch, normalizeText } from "@/lib/format";
import { LISTS, type ListKind } from "@/lib/lists";
import type { Category } from "@/lib/types";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { toast } from "sonner";

/** Lista suspensa de categoria ou marca, com busca e "criar nova" direto na lista. */
export function ListPicker({ kind, value, onChange }: { kind: ListKind; value: string; onChange: (name: string) => void }) {
  const cfg = LISTS[kind];
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Category[]>([]);
  const [search, setSearch] = useState("");

  // carrega ao montar (para mostrar o código da marca já no campo) e de novo a cada abertura
  useEffect(() => {
    setSearch("");
    cfg
      .load()
      .then(setItems)
      .catch((e) => toast.error(`Não consegui carregar as ${cfg.plural.toLowerCase()}: ${errMsg(e)}`));
  }, [open, cfg]);

  const typed = search.trim();
  const exists = items.some((c) => normalizeText(c.name) === normalizeText(typed));
  const selected = items.find((c) => c.name === value);

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  const create = async () => {
    const { data, error } = await supabase.from(cfg.table).insert({ name: typed }).select("*").single();
    if (error) return toast.error(error.message);
    setItems((cs) => [...cs, data as Category]);
    toast.success(`${cfg.singular[0].toUpperCase()}${cfg.singular.slice(1)} "${typed}" criada`);
    pick(typed);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-full justify-between font-normal">
          <span className={value ? "truncate" : "truncate text-muted-foreground"}>
            {value ? (selected?.code ? `${value} · cód. ${selected.code}` : value) : `Escolher ${cfg.singular}…`}
          </span>
          <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command filter={(v, s) => (v === "__new__" || matchesSearch(v, s) ? 1 : 0)}>
          <CommandInput placeholder={cfg.hasCode ? "Buscar por nome ou código…" : "Buscar ou digitar nova…"} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>Nenhuma {cfg.singular}.</CommandEmpty>
            <CommandGroup>
              {items.map((c) => (
                <CommandItem key={c.id} value={`${c.name} ${c.code ?? ""}`} onSelect={() => pick(c.name)}>
                  <Check className={`mr-2 h-4 w-4 ${value === c.name ? "opacity-100" : "opacity-0"}`} />
                  <span className="flex-1">{c.name}</span>
                  {c.code && <span className="text-xs text-muted-foreground">cód. {c.code}</span>}
                </CommandItem>
              ))}
              {value && (
                <CommandItem value={`sem ${cfg.singular}`} onSelect={() => pick("")} className="text-muted-foreground">
                  <span className="ml-6">Sem {cfg.singular}</span>
                </CommandItem>
              )}
            </CommandGroup>
            {typed && !exists && (
              <CommandGroup>
                <CommandItem value="__new__" onSelect={create} className="text-primary">
                  <Plus className="mr-2 h-4 w-4" /> Criar {cfg.singular} "{typed}"
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
