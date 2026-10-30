import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { matchesSearch } from "@/lib/format";
import type { Product } from "@/lib/types";
import { ChevronsUpDown } from "lucide-react";

export function ProductPicker({
  products,
  value,
  onChange,
  suggestions = [],
  placeholder = "Escolher produto…",
}: {
  products: Product[];
  value: string | null;
  onChange: (id: string) => void;
  suggestions?: Product[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = products.find((p) => p.id === value);
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-8 w-full justify-between font-normal">
          <span className="truncate">{selected ? selected.name : placeholder}</span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command filter={(v, s) => (matchesSearch(v, s) ? 1 : 0)}>
          <CommandInput placeholder="Buscar produto…" />
          <CommandList>
            <CommandEmpty>Nenhum produto.</CommandEmpty>
            {suggestions.length > 0 && (
              <CommandGroup heading="Parecidos">
                {suggestions.map((p) => (
                  <CommandItem key={`s-${p.id}`} value={`sug ${p.name} ${p.nf_name ?? ""}`} onSelect={() => pick(p.id)}>
                    {p.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            <CommandGroup heading="Todos">
              {products.map((p) => (
                <CommandItem key={p.id} value={`${p.name} ${p.nf_name ?? ""} ${p.code ?? ""} ${p.id}`} onSelect={() => pick(p.id)}>
                  <div className="min-w-0">
                    <div className="truncate">{p.name}</div>
                    {p.nf_name && <div className="truncate text-xs text-muted-foreground">{p.nf_name}</div>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
