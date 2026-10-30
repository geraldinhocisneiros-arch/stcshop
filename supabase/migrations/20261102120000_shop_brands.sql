-- Cadastro de marcas (lista suspensa no produto), com código próprio da marca.
-- O produto continua guardando o nome da marca (shop_products.brand).
-- O código da marca é diferente do "código do produto no fornecedor"
-- (shop_products.code), que é de cada item e vem na nota.

create table public.shop_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  created_at timestamptz not null default now()
);
create unique index shop_brands_name_uq on public.shop_brands (lower(name));
create unique index shop_brands_code_uq on public.shop_brands (lower(code)) where code is not null and code <> '';

-- traz as marcas que já foram digitadas nos produtos
insert into public.shop_brands (name)
select distinct on (lower(trim(brand))) trim(brand)
from public.shop_products
where coalesce(trim(brand), '') <> ''
order by lower(trim(brand)), trim(brand);

alter table public.shop_brands enable row level security;
create policy "membros leem" on public.shop_brands for select using (public.shop_is_member());
create policy "admin escreve" on public.shop_brands for all using (public.shop_is_admin()) with check (public.shop_is_admin());

-- Renomear: atualiza a marca e todos os produtos dela de uma vez.
create or replace function public.shop_rename_brand(p_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text; v_new text := trim(p_name);
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador altera marcas'; end if;
  if coalesce(v_new, '') = '' then raise exception 'Informe o nome'; end if;
  select name into v_old from shop_brands where id = p_id for update;
  if v_old is null then raise exception 'Marca não encontrada'; end if;
  if exists (select 1 from shop_brands where lower(name) = lower(v_new) and id <> p_id) then
    raise exception 'Já existe a marca "%"', v_new;
  end if;
  update shop_brands set name = v_new where id = p_id;
  update shop_products set brand = v_new where lower(trim(brand)) = lower(trim(v_old));
end $$;

-- Excluir: os produtos dessa marca ficam "sem marca".
create or replace function public.shop_delete_brand(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_old text;
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador altera marcas'; end if;
  delete from shop_brands where id = p_id returning name into v_old;
  if v_old is null then raise exception 'Marca não encontrada'; end if;
  update shop_products set brand = null where lower(trim(brand)) = lower(trim(v_old));
end $$;
