import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any) {
  const { data: isAdmin, error } = await supabase.rpc("shop_is_admin");
  if (error || !isAdmin) throw new Error("Apenas administradores podem gerenciar usuários");
}

function cleanRedirect(url: unknown): string {
  if (typeof url !== "string") throw new Error("Endereço de retorno inválido");
  const u = new URL(url);
  if (u.protocol !== "https:" && u.hostname !== "localhost") throw new Error("Endereço de retorno inválido");
  return `${u.origin}/definir-senha`;
}

/** Link de uso único para a pessoa definir (ou trocar) a própria senha. Vale ~1 h (configuração do Supabase). */
async function passwordLink(supabaseAdmin: any, email: string, redirectTo: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });
  if (error || !data?.properties?.action_link) throw new Error(error?.message ?? "Não foi possível gerar o link");
  return data.properties.action_link as string;
}

/** Cria um login para a loja (ou dá acesso à loja a um e-mail que já existe no Supabase). */
export const createShopUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      email: string;
      password?: string;
      fullName: string;
      role: "admin" | "vendedor";
      /** Sem senha: devolve um link para a própria pessoa criar a senha. */
      origin?: string;
    }) => {
      if (!input?.email || !input.fullName) throw new Error("Nome e e-mail são obrigatórios");
      if (input.role !== "admin" && input.role !== "vendedor") throw new Error("Papel inválido");
      const password = input.password?.trim() ? input.password : undefined;
      if (password && password.length < 6) throw new Error("Senha precisa ter no mínimo 6 caracteres");
      if (!password && !input.origin) throw new Error("Informe a senha ou gere o link");
      return {
        ...input,
        password,
        email: input.email.trim().toLowerCase(),
        redirectTo: password ? null : cleanRedirect(input.origin),
      };
    },
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let userId: string | null = null;
    const created = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.fullName },
    });
    if (created.data.user) {
      userId = created.data.user.id;
    } else {
      // Já existe (ex.: mesmo projeto do squashtenniscenter): só vincula à loja.
      for (let page = 1; page <= 20 && !userId; page++) {
        const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw new Error(error.message);
        userId = list.users.find((u) => u.email?.toLowerCase() === data.email)?.id ?? null;
        if (list.users.length < 200) break;
      }
      if (!userId) throw new Error(created.error?.message ?? "Não foi possível criar o usuário");
    }

    const { error } = await supabaseAdmin
      .from("shop_user_roles")
      .upsert({ user_id: userId, full_name: data.fullName, role: data.role });
    if (error) throw new Error(error.message);
    // Login que já existia (ex.: academia) mantém a senha atual: não gera link para não trocá-la sem querer.
    const link = data.redirectTo && created.data.user ? await passwordLink(supabaseAdmin, data.email, data.redirectTo) : null;
    return { ok: true, existed: !created.data.user, link };
  });

export const removeShopUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string }) => {
    if (!input?.userId) throw new Error("userId obrigatório");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    if (data.userId === context.userId) throw new Error("Você não pode remover o próprio acesso");
    // Remove só o acesso à loja; o login continua existindo (pode ser usado em outro sistema).
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("shop_user_roles").delete().eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Gera um novo link de senha para um usuário da loja (link anterior expirou, esqueceu a senha…). */
export const shopUserPasswordLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; origin: string }) => {
    if (!input?.userId) throw new Error("userId obrigatório");
    return { userId: input.userId, redirectTo: cleanRedirect(input.origin) };
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: member } = await supabaseAdmin
      .from("shop_user_roles")
      .select("user_id")
      .eq("user_id", data.userId)
      .maybeSingle();
    if (!member) throw new Error("Usuário não tem acesso à loja");
    const { data: u, error } = await supabaseAdmin.auth.admin.getUserById(data.userId);
    if (error || !u.user?.email) throw new Error(error?.message ?? "Usuário sem e-mail");
    return { link: await passwordLink(supabaseAdmin, u.user.email, data.redirectTo) };
  });
