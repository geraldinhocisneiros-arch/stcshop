import { useEffect, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { errMsg, loadCustomers, type CustomerWithBalance } from "@/lib/data";
import { fmtBRL, matchesSearch } from "@/lib/format";
import { ChevronsUpDown, Plus, UserRound, X } from "lucide-react";
import { toast } from "sonner";

/** Escolher cliente (busca por nome ou telefone), com cadastro rápido de nome + WhatsApp. */
export function CustomerPicker({
  value,
  onChange,
}: {
  value: CustomerWithBalance | null;
  onChange: (c: CustomerWithBalance | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<CustomerWithBalance[]>([]);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState<{ name: string; phone: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setCreating(null);
    loadCustomers()
      .then((cs) => setList(cs.filter((c) => c.active)))
      .catch((e) => toast.error(errMsg(e)));
  }, [open]);

  const pick = (c: CustomerWithBalance | null) => {
    onChange(c);
    setOpen(false);
  };

  const create = async () => {
    if (!creating?.name.trim()) return toast.error("Informe o nome");
    const { data, error } = await supabase
      .from("shop_customers")
      .insert({ name: creating.name.trim(), phone: creating.phone.trim() || null })
      .select("*")
      .single();
    if (error) return toast.error(error.message);
    toast.success("Cliente cadastrado");
    pick({ ...(data as CustomerWithBalance), balance: 0, last_debit_at: null, last_payment_at: null });
  };

  const typed = search.trim();
  const looksLikePhone = /^[\d\s()+-]{8,}$/.test(typed);

  return (
    <div className="flex gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-full justify-between font-normal">
            <span className={`flex min-w-0 items-center gap-2 ${value ? "" : "text-muted-foreground"}`}>
              <UserRound className="h-4 w-4 shrink-0" />
              <span className="truncate">{value ? value.name : "Sem cliente"}</span>
            </span>
            <ChevronsUpDown className="ml-1 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          {creating ? (
            <div className="space-y-2 p-3">
              <div className="text-sm font-medium">Cadastrar cliente</div>
              <Input placeholder="Nome" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} autoFocus />
              <Input
                placeholder="WhatsApp (ex.: 81 99999-9999)"
                inputMode="tel"
                value={creating.phone}
                onChange={(e) => setCreating({ ...creating, phone: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setCreating(null)}>
                  Voltar
                </Button>
                <Button size="sm" onClick={create}>
                  Cadastrar
                </Button>
              </div>
            </div>
          ) : (
            <Command filter={(v, s) => (v === "__new__" || matchesSearch(v, s) ? 1 : 0)}>
              <CommandInput placeholder="Buscar por nome ou telefone…" value={search} onValueChange={setSearch} />
              <CommandList>
                <CommandEmpty>Nenhum cliente.</CommandEmpty>
                <CommandGroup>
                  {list.map((c) => (
                    <CommandItem key={c.id} value={`${c.name} ${c.phone ?? ""} ${(c.phone ?? "").replace(/\D/g, "")}`} onSelect={() => pick(c)}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.phone ?? "sem telefone"}</div>
                      </div>
                      {c.balance > 0 && <span className="text-xs font-medium text-destructive">deve {fmtBRL(c.balance)}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandGroup>
                  <CommandItem
                    value="__new__"
                    onSelect={() => setCreating({ name: looksLikePhone ? "" : typed, phone: looksLikePhone ? typed : "" })}
                    className="text-primary"
                  >
                    <Plus className="mr-2 h-4 w-4" /> {typed ? `Cadastrar "${typed}"` : "Cadastrar novo cliente"}
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          )}
        </PopoverContent>
      </Popover>
      {value && (
        <Button size="icon" variant="ghost" title="Tirar cliente" onClick={() => onChange(null)}>
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
