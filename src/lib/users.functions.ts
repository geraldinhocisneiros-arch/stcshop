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
