import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/hooks/useAuth";
import { errMsg } from "@/lib/data";
import { fmtDateTime } from "@/lib/format";
import {
  createShopUser,
  listShopUsers,
  removeShopUser,
  setShopUserPassword,
  updateShopUser,
  type ShopUserInfo,
} from "@/lib/users.functions";
import { toast } from "sonner";
import { Eye, EyeOff, KeyRound, Pencil, UserPlus } from "lucide-react";

export const Route = createFileRoute("/usuarios")({
  head: () => ({ meta: [{ title: "Usuários — Squash Tennis Shop" }] }),
  component: UsuariosPage,
});

type Role = "admin" | "vendedor";
const ROLE_LABEL: Record<Role, string> = { admin: "Administrador", vendedor: "Vendedor" };

function UsuariosPage() {
  const { user } = useAuth();
  const list = useServerFn(listShopUsers);
  const [users, setUsers] = useState<ShopUserInfo[] | null>(null);
  const [pwFor, setPwFor] = useState<ShopUserInfo | null>(null);
  const [editFor, setEditFor] = useState<ShopUserInfo | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setUsers(await list());
    } catch (e) {
      toast.error(errMsg(e));
      setUsers([]);
    }
  }, [list]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <AppLayout
      title="Usuários"
      adminOnly
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <UserPlus className="mr-1 h-4 w-4" /> Novo usuário
        </Button>
      }
    >
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nome</TableHead>
                <TableHead>E-mail (login)</TableHead>
                <TableHead>Papel</TableHead>
                <TableHead>Último acesso</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users === null && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Carregando…
                  </TableCell>
                </TableRow>
              )}
              {users?.map((u) => (
                <TableRow key={u.user_id}>
                  <TableCell className="font-medium">
                    {u.full_name || "—"}
                    {u.user_id === user?.id && <span className="ml-1 text-xs text-muted-foreground">(você)</span>}
                  </TableCell>
                  <TableCell className="text-sm">
                    {u.email ?? "—"}
                    {!u.email_confirmed && (
                      <Badge variant="outline" className="ml-2">
                        e-mail não confirmado
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.role === "admin" ? "default" : "secondary"}>{ROLE_LABEL[u.role]}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{u.last_sign_in_at ? fmtDateTime(u.last_sign_in_at) : "Nunca entrou"}</TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    <Button size="sm" variant="outline" onClick={() => setPwFor(u)}>
                      <KeyRound className="mr-1 h-4 w-4" /> Trocar senha
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditFor(u)}>
                      <Pencil className="mr-1 h-4 w-4" /> Editar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {users?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Nenhum usuário.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="mt-3 text-xs text-muted-foreground">
        Se o Supabase for o mesmo do sistema da academia, o login é um só: trocar a senha aqui troca também lá.
      </p>

      <PasswordDialog target={pwFor} onClose={() => setPwFor(null)} />
      <EditDialog target={editFor} selfId={user?.id} onClose={() => setEditFor(null)} onDone={load} />
      <CreateDialog open={creating} onClose={() => setCreating(false)} onDone={load} />
    </AppLayout>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10"
      />
      <button
        type="button"
        className="absolute right-2 top-2 text-muted-foreground"
        onClick={() => setShow((s) => !s)}
        title={show ? "Esconder" : "Mostrar"}
      >
        {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
}

function PasswordDialog({ target, onClose }: { target: ShopUserInfo | null; onClose: () => void }) {
  const setPassword = useServerFn(setShopUserPassword);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPw("");
    setPw2("");
  }, [target]);
  if (!target) return null;

  const save = async () => {
    if (pw.length < 6) return toast.error("A senha precisa ter pelo menos 6 caracteres");
    if (pw !== pw2) return toast.error("As duas senhas não são iguais");
    setBusy(true);
    try {
      await setPassword({ data: { userId: target.user_id, password: pw } });
      toast.success(`Senha de ${target.full_name || target.email} alterada`);
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trocar senha — {target.full_name || target.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Login: <b>{target.email}</b>
          </p>
          <div className="space-y-1">
            <Label>Senha nova (mín. 6)</Label>
            <PasswordField value={pw} onChange={setPw} />
          </div>
          <div className="space-y-1">
            <Label>Repita a senha</Label>
            <PasswordField value={pw2} onChange={setPw2} />
          </div>
          <p className="text-xs text-muted-foreground">
            Maiúsculas e minúsculas fazem diferença. Passe a senha à pessoa pessoalmente, não por grupo de WhatsApp.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy ? "Salvando…" : "Salvar senha"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  target,
  selfId,
  onClose,
  onDone,
}: {
  target: ShopUserInfo | null;
  selfId?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const update = useServerFn(updateShopUser);
  const remove = useServerFn(removeShopUser);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("vendedor");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!target) return;
    setName(target.full_name);
    setRole(target.role);
  }, [target]);
  if (!target) return null;
  const isSelf = target.user_id === selfId;

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      onClose();
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar usuário</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Login: <b>{target.email}</b>
          </p>
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Papel</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)} disabled={isSelf}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vendedor">Vendedor (caixa, vendas, encordoamento)</SelectItem>
                <SelectItem value="admin">Administrador (tudo)</SelectItem>
              </SelectContent>
            </Select>
            {isSelf && <p className="text-xs text-muted-foreground">Você não pode mudar o seu próprio papel.</p>}
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {!isSelf ? (
            <Button
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => {
                if (!confirm(`Remover o acesso de ${target.full_name || target.email} à loja?`)) return;
                run(() => remove({ data: { userId: target.user_id } }), "Acesso removido");
              }}
            >
              Remover acesso
            </Button>
          ) : (
            <span />
          )}
          <Button
            disabled={busy}
            onClick={() => run(() => update({ data: { userId: target.user_id, fullName: name, role } }), "Usuário atualizado")}
          >
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const create = useServerFn(createShopUser);
  const [nu, setNu] = useState({ fullName: "", email: "", password: "", role: "vendedor" as Role });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setNu({ fullName: "", email: "", password: "", role: "vendedor" });
  }, [open]);
  if (!open) return null;

  const save = async () => {
    if (nu.password.length < 6) return toast.error("A senha precisa ter pelo menos 6 caracteres");
    setBusy(true);
    try {
      const r = await create({ data: nu });
      toast.success(
        r.existed
          ? "Esse e-mail já tinha login: acesso liberado, mas a senha continua a antiga. Use \"Trocar senha\" se precisar."
          : "Usuário criado",
        { duration: r.existed ? 10000 : 4000 },
      );
      onClose();
      onDone();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo usuário</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Nome</Label>
            <Input value={nu.fullName} onChange={(e) => setNu({ ...nu, fullName: e.target.value })} autoFocus />
          </div>
          <div className="space-y-1">
            <Label>E-mail (login)</Label>
            <Input type="email" autoCapitalize="none" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Senha (mín. 6)</Label>
            <PasswordField value={nu.password} onChange={(v) => setNu({ ...nu, password: v })} />
          </div>
          <div className="space-y-1">
            <Label>Papel</Label>
            <Select value={nu.role} onValueChange={(v) => setNu({ ...nu, role: v as Role })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vendedor">Vendedor (caixa, vendas, encordoamento)</SelectItem>
                <SelectItem value="admin">Administrador (tudo)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy}>
            {busy ? "Criando…" : "Criar usuário"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
