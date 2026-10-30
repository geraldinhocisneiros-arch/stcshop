import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard,
  ShoppingCart,
  Receipt,
  Package,
  Boxes,
  FileInput,
  Wallet,
  BarChart3,
  Lightbulb,
  Calculator,
  Settings,
  LogOut,
  Menu,
  X,
  Wrench,
  Truck,
  Users,
  AlertCircle,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Painel", icon: LayoutDashboard },
  { to: "/caixa", label: "Caixa (PDV)", icon: ShoppingCart },
  { to: "/vendas", label: "Vendas", icon: Receipt },
  { to: "/encordoamento", label: "Encordoamento", icon: Wrench },
  { to: "/clientes", label: "Clientes", icon: Users },
  { to: "/pendencias", label: "Pendências", icon: AlertCircle },
  { to: "/produtos", label: "Produtos", icon: Package },
  { to: "/estoque", label: "Estoque", icon: Boxes },
  { to: "/notas", label: "Notas fiscais", icon: FileInput, adminOnly: true },
  { to: "/fornecedores", label: "Fornecedores", icon: Truck, adminOnly: true },
  { to: "/fechamentos", label: "Fechamentos", icon: Wallet },
  { to: "/relatorios", label: "Relatórios", icon: BarChart3, adminOnly: true },
  { to: "/inteligencia", label: "Inteligência", icon: Lightbulb, adminOnly: true },
  { to: "/custos", label: "Custos e preços", icon: Calculator, adminOnly: true },
  { to: "/configuracoes", label: "Configurações", icon: Settings, adminOnly: true },
];

export function AppLayout({
  children,
  title,
  actions,
  adminOnly,
}: {
  children: ReactNode;
  title: string;
  actions?: ReactNode;
  adminOnly?: boolean;
}) {
  const { session, role, isAdmin, loading, fullName, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!loading && !session) navigate({ to: "/login" });
  }, [loading, session, navigate]);

  useEffect(() => setOpen(false), [location.pathname]);

  if (loading || !session) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Carregando…</div>;
  }
  if (!role) return <NoAccess />;

  const items = NAV.filter((n) => !n.adminOnly || isAdmin);

  const sidebar = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between gap-2 p-4">
        <Link to="/" className="block rounded-md bg-white p-2">
          <img src="/logo.webp" alt="Squash Tennis Shop" className="h-12 w-auto" />
        </Link>
        <button className="md:hidden" onClick={() => setOpen(false)} aria-label="Fechar menu">
          <X className="h-5 w-5" />
        </button>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
        {items.map((n) => {
          const active = n.to === "/" ? location.pathname === "/" : location.pathname.startsWith(n.to);
          return (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <n.icon className="h-4 w-4" />
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-sidebar-border p-3 text-sm">
        <div className="truncate font-medium">{fullName || session.user.email}</div>
        <div className="mb-2 text-xs opacity-70">{role === "admin" ? "Administrador" : "Vendedor"}</div>
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          onClick={async () => {
            await signOut();
            navigate({ to: "/login" });
          }}
        >
          <LogOut className="mr-2 h-4 w-4" /> Sair
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 md:block print:hidden">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden print:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64">{sidebar}</aside>
        </div>
      )}
      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur print:hidden">
          <button className="md:hidden" onClick={() => setOpen(true)} aria-label="Abrir menu">
            <Menu className="h-5 w-5" />
          </button>
          <h1 className="flex-1 truncate text-lg font-semibold">{title}</h1>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
        <div className="p-4 md:p-6">
          {adminOnly && !isAdmin ? (
            <p className="text-muted-foreground">Esta área é só para o administrador.</p>
          ) : (
            children
          )}
        </div>
      </main>
    </div>
  );
}

/** Usuário logado mas sem papel na loja. No primeiro acesso, ele pode se tornar o admin. */
function NoAccess() {
  const { session, signOut, refreshRole } = useAuth();
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    supabase.rpc("shop_has_any_user").then(({ data }) => setFirstRun(data === false));
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 pt-6">
          <img src="/logo.webp" alt="Squash Tennis Shop" className="mx-auto h-20" />
          {firstRun ? (
            <>
              <p className="text-sm">
                Primeiro acesso ao sistema. Você (<b>{session?.user.email}</b>) será o administrador da loja.
              </p>
              <div className="space-y-1">
                <Label>Seu nome</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button
                className="w-full"
                onClick={async () => {
                  const { error } = await supabase.rpc("shop_claim_first_admin", { p_full_name: name });
                  if (error) return toast.error(error.message);
                  await refreshRole();
                }}
              >
                Tornar-me administrador
              </Button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Sua conta (<b>{session?.user.email}</b>) ainda não tem acesso à loja. Peça ao administrador para liberar
              em Configurações → Usuários.
            </p>
          )}
          <Button variant="outline" className="w-full" onClick={() => signOut()}>
            Sair
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** Cartão de indicador usado em várias telas. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "good" | "bad" | "warn";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div
          className={cn(
            "mt-1 text-2xl font-semibold tabular-nums",
            tone === "good" && "text-success",
            tone === "bad" && "text-destructive",
            tone === "warn" && "text-warning-foreground",
          )}
        >
          {value}
        </div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
