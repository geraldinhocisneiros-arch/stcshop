import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { matchesSearch, normalizeText } from "@/lib/format";
import { fmtCnpj, supplierLabel, type Supplier } from "@/lib/types";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { toast } from "sonner";

/** Lista suspensa de fornecedores, com busca por nome/CNPJ e cadastro rápido. */
export function SupplierPicker({
  suppliers,
  value,
  fallbackName,
  onChange,
  onCreated,
}: {
  suppliers: Supplier[];
  value: string | null;
  /** nome que veio na nota, mostrado quando o fornecedor ainda não está cadastrado */
  fallbackName?: string | null;
  onChange: (s: Supplier | null) => void;
  onCreated: (s: Supplier) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = suppliers.find((s) => s.id === value);
  const typed = search.trim();
  const exists = suppliers.some((s) => normalizeText(s.name) === normalizeText(typed) || normalizeText(s.trade_name) === normalizeText(typed));

  const pick = (s: Supplier | null) => {
    onChange(s);
    setOpen(false);
  };

  const create = async () => {
    const { data, error } = await supabase.from("shop_suppliers").insert({ name: typed }).select("*").single();
    if (error) return toast.error(error.message);
    toast.success(`Fornecedor "${typed}" cadastrado. Complete o CNPJ e o contato em Fornecedores.`);
    onCreated(data as Supplier);
    pick(data as Supplier);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-8 w-full justify-between font-normal">
          <span className={selected || fallbackName ? "truncate" : "truncate text-muted-foreground"}>
            {selected ? supplierLabel(selected) : fallbackName ? `${fallbackName} (novo)` : "Escolher fornecedor…"}
          </span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command filter={(v, s) => (v === "__new__" || matchesSearch(v, s) ? 1 : 0)}>
          <CommandInput placeholder="Buscar por nome ou CNPJ…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>Nenhum fornecedor.</CommandEmpty>
            <CommandGroup>
              {suppliers
                .filter((s) => s.active || s.id === value)
                .map((s) => (
                  <CommandItem key={s.id} value={`${s.name} ${s.trade_name ?? ""} ${s.cnpj ?? ""}`} onSelect={() => pick(s)}>
                    <Check className={`mr-2 h-4 w-4 shrink-0 ${value === s.id ? "opacity-100" : "opacity-0"}`} />
                    <div className="min-w-0">
                      <div className="truncate">{supplierLabel(s)}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {s.trade_name ? `${s.name} · ` : ""}
                        {fmtCnpj(s.cnpj) || "sem CNPJ"}
                      </div>
                    </div>
                  </CommandItem>
                ))}
            </CommandGroup>
            {typed && !exists && (
              <CommandGroup>
                <CommandItem value="__new__" onSelect={create} className="text-primary">
                  <Plus className="mr-2 h-4 w-4" /> Cadastrar "{typed}"
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
