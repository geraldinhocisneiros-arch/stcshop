import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/definir-senha")({
  head: () => ({ meta: [{ title: "Criar senha — Squash Tennis Shop" }] }),
  component: SetPasswordPage,
});

/** Destino do link gerado em Configurações → Usuários: a pessoa entra pelo link e escolhe a senha. */
function SetPasswordPage() {
  const { session, loading, fullName, user } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    // Link expirado/usado: o Supabase devolve o erro no endereço.
    const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search.slice(1));
    const err = params.get("error_description");
    if (err) setLinkError(err.replace(/\+/g, " "));
    // Dá um tempo para o cliente do Supabase ler o token do link.
    const t = setTimeout(() => setWaited(true), 2500);
    return () => clearTimeout(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) return toast.error("A senha precisa ter no mínimo 6 caracteres");
    if (password !== confirm) return toast.error("As senhas não conferem");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Senha criada! Use seu e-mail e essa senha para entrar.");
    navigate({ to: "/" });
  };

  const ready = !loading && session;
  const failed = linkError || (!loading && !session && waited);

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-primary to-[oklch(0.3_0.12_262)] p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <img src="/logo.webp" alt="Squash Tennis Shop" className="mx-auto mb-6 h-24" />
          {ready ? (
            <form onSubmit={submit} className="space-y-4">
              <div className="text-center text-sm">
                {fullName ? `Olá, ${fullName}!` : "Olá!"} Crie sua senha de acesso.
                <div className="text-xs text-muted-foreground">{user?.email}</div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pw">Nova senha</Label>
                <Input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="pw2">Repita a senha</Label>
                <Input id="pw2" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={6} />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? "Salvando…" : "Salvar senha e entrar"}
              </Button>
            </form>
          ) : failed ? (
            <div className="space-y-3 text-center text-sm">
              <p className="font-medium">Este link expirou ou já foi usado.</p>
              <p className="text-muted-foreground">Peça ao administrador da loja um novo link de senha.</p>
              {linkError && <p className="text-xs text-muted-foreground">({linkError})</p>}
            </div>
          ) : (
            <p className="text-center text-sm text-muted-foreground">Validando o link…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
