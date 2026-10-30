-- Cadastro de categorias de produto.
-- O produto continua guardando o nome da categoria (shop_products.category);
-- esta tabela é a lista oficial que aparece na lista suspensa.

create table public.shop_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create unique index shop_categories_name_uq on public.shop_categories (lower(name));

-- traz as categorias que já foram digitadas nos produtos
insert into public.shop_categories (name)
select distinct on (lower(trim(category))) trim(category)
from public.shop_products
where coalesce(trim(category), '') <> ''
order by lower(trim(category)), trim(category);

alter table public.shop_categories enable row level security;
create policy "membros leem" on public.shop_categories for select using (public.shop_is_member());
create policy "admin escreve" on public.shop_categories for all using (public.shop_is_admin()) with check (public.shop_is_admin());

-- Renomear: atualiza a categoria e todos os produtos dela de uma vez.
create or replace function public.shop_rename_category(p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text; v_new text := trim(p_name);
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador altera categorias'; end if;
  if coalesce(v_new, '') = '' then raise exception 'Informe o nome'; end if;
  select name into v_old from shop_categories where id = p_id for update;
  if v_old is null then raise exception 'Categoria não encontrada'; end if;
  if exists (select 1 from shop_categories where lower(name) = lower(v_new) and id <> p_id) then
    raise exception 'Já existe a categoria "%"', v_new;
  end if;
  update shop_categories set name = v_new where id = p_id;
  update shop_products set category = v_new where lower(trim(category)) = lower(trim(v_old));
end $$;

-- Excluir: os produtos dessa categoria ficam "sem categoria".
create or replace function public.shop_delete_category(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador altera categorias'; end if;
  delete from shop_categories where id = p_id returning name into v_old;
  if v_old is null then raise exception 'Categoria não encontrada'; end if;
  update shop_products set category = null where lower(trim(category)) = lower(trim(v_old));
end $$;
