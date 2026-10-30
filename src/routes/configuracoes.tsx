import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { errMsg, loadMethods, loadSettings } from "@/lib/data";
import { parseDecimal } from "@/lib/format";
import { createShopUser, removeShopUser } from "@/lib/users.functions";
import type { PaymentMethod, ShopSettings } from "@/lib/types";
import { toast } from "sonner";

export const Route = createFileRoute("/configuracoes")({
  head: () => ({ meta: [{ title: "Configurações — Squash Tennis Shop" }] }),
  component: ConfigPage,
});

const FIELDS: Array<{ key: keyof ShopSettings; label: string; hint: string }> = [
  { key: "target_margin_pct", label: "Meta de lucro líquido (%)", hint: "Quanto sobra de cada venda depois de pagar tudo. Usado no preço sugerido." },
  { key: "expected_monthly_revenue", label: "Faturamento mensal estimado (R$)", hint: "Usado para ratear o custo fixo enquanto não há 1 mês fechado de vendas." },
  { key: "analysis_days", label: "Janela de análise (dias)", hint: "Período usado na curva ABC, giro e reposição." },
  { key: "lead_time_days", label: "Prazo de entrega do fornecedor (dias)", hint: "Do pedido até a mercadoria chegar." },
  { key: "safety_days", label: "Estoque de segurança (dias)", hint: "Folga para atraso ou pico de venda." },
  { key: "coverage_target_days", label: "Comprar para quantos dias", hint: "Tamanho de cada pedido de reposição." },
  { key: "stale_days", label: "Parado após (dias sem venda)", hint: "A partir daqui o produto vira candidato a promoção." },
  { key: "max_seller_discount_pct", label: "Desconto máximo do vendedor (%)", hint: "Acima disso só o administrador. Vale também para quem tentar burlar pela API." },
  { key: "max_promo_discount_pct", label: "Desconto máximo de promoção (%)", hint: "Teto do desconto sugerido." },
];

interface ShopUser {
  user_id: string;
  full_name: string;
  role: "admin" | "vendedor";
}

function ConfigPage() {
  const { user } = useAuth();
  const createUser = useServerFn(createShopUser);
  const removeUser = useServerFn(removeShopUser);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [allowNegative, setAllowNegative] = useState(false);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [users, setUsers] = useState<ShopUser[]>([]);
  const [nu, setNu] = useState({ fullName: "", email: "", password: "", role: "vendedor" as "admin" | "vendedor" });

  const load = useCallback(async () => {
    try {
      const [s, m, u] = await Promise.all([loadSettings(), loadMethods(), supabase.from("shop_user_roles").select("*").order("full_name")]);
      setSettings(Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key]).replace(".", ",")])));
      setAllowNegative(s.allow_negative_stock);
      setMethods(m);
      setUsers((u.data ?? []) as ShopUser[]);
    } catch (e) {
      toast.error(errMsg(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const saveSettings = async () => {
    const row: Record<string, unknown> = { allow_negative_stock: allowNegative, updated_at: new Date().toISOString() };
    for (const f of FIELDS) row[f.key] = parseDecimal(settings[f.key]);
    const { error } = await supabase.from("shop_settings").update(row).eq("id", 1);
    if (error) return toast.error(error.message);
    toast.success("Configurações salvas");
  };

  const saveMethod = async (m: PaymentMethod, patch: Partial<PaymentMethod>) => {
    const { error } = await supabase.from("shop_payment_methods").update(patch).eq("code", m.code);
    if (error) return toast.error(error.message);
    setMethods((ms) => ms.map((x) => (x.code === m.code ? { ...x, ...patch } : x)));
  };

  return (
    <AppLayout title="Configurações" adminOnly>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Parâmetros de preço e inteligência</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="grid gap-1 md:grid-cols-[1fr_140px] md:items-center">
                <div>
                  <Label>{f.label}</Label>
                  <p className="text-xs text-muted-foreground">{f.hint}</p>
                </div>
                <Input value={settings[f.key] ?? ""} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Switch checked={allowNegative} onCheckedChange={setAllowNegative} id="neg" />
              <Label htmlFor="neg">Permitir vender sem estoque no sistema (estoque negativo)</Label>
            </div>
            <Button onClick={saveSettings}>Salvar</Button>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Formas de pagamento e taxas</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Forma</TableHead>
                    <TableHead className="w-32">Taxa (%)</TableHead>
                    <TableHead className="w-20">Ativa</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {methods.map((m) => (
                    <TableRow key={m.code}>
                      <TableCell>{m.label}</TableCell>
                      <TableCell>
                        <Input
                          className="h-8"
                          defaultValue={String(m.fee_pct).replace(".", ",")}
                          onBlur={(e) => saveMethod(m, { fee_pct: parseDecimal(e.target.value) })}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch checked={m.active} onCheckedChange={(v) => saveMethod(m, { active: v })} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="px-4 py-2 text-xs text-muted-foreground">
                Use a taxa real do contrato da sua maquininha. Ela entra no custo de cada venda e no fechamento do caixa.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Usuários</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="divide-y rounded-md border">
                {users.map((u) => (
                  <div key={u.user_id} className="flex items-center justify-between p-2 text-sm">
                    <div>
                      {u.full_name} <span className="text-xs text-muted-foreground">· {u.role === "admin" ? "Administrador" : "Vendedor"}</span>
                    </div>
                    {u.user_id !== user?.id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={async () => {
                          try {
                            await removeUser({ data: { userId: u.user_id } });
                            toast.success("Acesso removido");
                            load();
                          } catch (e) {
                            toast.error(errMsg(e));
                          }
                        }}
                      >
                        Remover
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <Input placeholder="Nome" value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} />
                <Input placeholder="E-mail" type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
                <Input placeholder="Senha (mín. 6)" type="password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} />
                <Select value={nu.role} onValueChange={(v) => setNu({ ...nu, role: v as "admin" | "vendedor" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vendedor">Vendedor (caixa, vendas, encordoamento)</SelectItem>
                    <SelectItem value="admin">Administrador (tudo)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={async () => {
                  try {
                    const r = await createUser({ data: nu });
                    toast.success(r.existed ? "E-mail já existia: acesso à loja liberado" : "Usuário criado");
                    setNu({ fullName: "", email: "", password: "", role: "vendedor" });
                    load();
                  } catch (e) {
                    toast.error(errMsg(e));
                  }
                }}
              >
                Adicionar usuário
              </Button>
              <p className="text-xs text-muted-foreground">
                Se o e-mail já tiver login (ex.: no sistema da academia, quando o Supabase é o mesmo), ele só ganha acesso à loja e
                continua com a mesma senha.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
