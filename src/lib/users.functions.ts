import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(supabase: any) {
  const { data: isAdmin, error } = await supabase.rpc("shop_is_admin");
  if (error || !isAdmin) throw new Error("Apenas administradores podem gerenciar usuários");
}

/** Cria um login para a loja (ou dá acesso à loja a um e-mail que já existe no Supabase). */
export const createShopUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { email: string; password: string; fullName: string; role: "admin" | "vendedor" }) => {
      if (!input?.email || !input.fullName) throw new Error("Nome e e-mail são obrigatórios");
      if (input.role !== "admin" && input.role !== "vendedor") throw new Error("Papel inválido");
      return { ...input, email: input.email.trim().toLowerCase() };
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
    return { ok: true, existed: !created.data.user };
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

export interface ShopUserInfo {
  user_id: string;
  full_name: string;
  role: "admin" | "vendedor";
  email: string | null;
  last_sign_in_at: string | null;
  created_at: string | null;
  email_confirmed: boolean;
}

/** Lista quem tem acesso à loja, com e-mail e último acesso (vem do Auth, por isso roda no servidor). */
export const listShopUsers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ShopUserInfo[]> => {
    await assertAdmin(context.supabase);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: roles, error } = await supabaseAdmin.from("shop_user_roles").select("user_id, full_name, role").order("full_name");
    if (error) throw new Error(error.message);
    return Promise.all(
      (roles ?? []).map(async (r: { user_id: string; full_name: string; role: "admin" | "vendedor" }) => {
        const { data } = await supabaseAdmin.auth.admin.getUserById(r.user_id);
        const u = data?.user;
        return {
          ...r,
          email: u?.email ?? null,
          last_sign_in_at: u?.last_sign_in_at ?? null,
          created_at: u?.created_at ?? null,
          email_confirmed: !!u?.email_confirmed_at,
        };
      }),
    );
  });

async function assertShopUser(supabaseAdmin: any, userId: string) {
  const { data } = await supabaseAdmin.from("shop_user_roles").select("user_id").eq("user_id", userId).maybeSingle();
  if (!data) throw new Error("Este usuário não tem acesso à loja");
}

/** Define uma senha nova para um usuário da loja (o admin troca sem precisar da senha antiga). */
export const setShopUserPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; password: string }) => {
    if (!input?.userId) throw new Error("userId obrigatório");
    if (!input.password || input.password.length < 6) throw new Error("A senha precisa ter pelo menos 6 caracteres");
    if (input.password !== input.password.trim()) throw new Error("A senha não pode começar nem terminar com espaço");
    return input;
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await assertShopUser(supabaseAdmin, data.userId);
    // confirma o e-mail junto: e-mail não confirmado também bloqueia o login
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, { password: data.password, email_confirm: true });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Muda nome e papel (admin / vendedor) de um usuário da loja. */
export const updateShopUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; fullName: string; role: "admin" | "vendedor" }) => {
    if (!input?.userId) throw new Error("userId obrigatório");
    if (!input.fullName?.trim()) throw new Error("Informe o nome");
    if (input.role !== "admin" && input.role !== "vendedor") throw new Error("Papel inválido");
    return { ...input, fullName: input.fullName.trim() };
  })
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase);
    if (data.userId === context.userId && data.role !== "admin") throw new Error("Você não pode tirar o seu próprio acesso de administrador");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await assertShopUser(supabaseAdmin, data.userId);
    const { error } = await supabaseAdmin
      .from("shop_user_roles")
      .update({ full_name: data.fullName, role: data.role })
      .eq("user_id", data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
