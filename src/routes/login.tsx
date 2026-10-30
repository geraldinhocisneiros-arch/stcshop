import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: [{ title: "Entrar — Squash Tennis Shop" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { signIn, session, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  const [signup, setSignup] = useState(false);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/" });
  }, [loading, session, navigate]);

  useEffect(() => {
    supabase.rpc("shop_has_any_user").then(({ data }) => setFirstRun(data === false));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    if (signup) {
      const { error } = await supabase.auth.signUp({ email: email.trim(), password });
      setBusy(false);
      if (error) return toast.error(error.message);
      toast.success("Conta criada. Se o Supabase pedir confirmação, confira seu e-mail e depois entre.");
      setSignup(false);
      return;
    }
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) toast.error(error);
    else navigate({ to: "/" });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-primary to-[oklch(0.3_0.12_262)] p-4">
      <Card className="w-full max-w-sm">
        <CardContent className="pt-6">
          <img src="/logo.webp" alt="Squash Tennis Shop" className="mx-auto mb-6 h-24" />
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pw">Senha</Label>
              <Input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Aguarde…" : signup ? "Criar conta de administrador" : "Entrar"}
            </Button>
          </form>
          {firstRun && (
            <button className="mt-4 w-full text-center text-sm text-primary underline" onClick={() => setSignup(!signup)}>
              {signup ? "Já tenho conta — entrar" : "Primeiro acesso? Criar a conta do administrador"}
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
