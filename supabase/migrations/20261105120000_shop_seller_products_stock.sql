-- =====================================================================
-- Vendedor cadastra produtos e movimenta estoque
--
-- - Vendedor pode cadastrar e editar produtos (ficha: nome, categoria,
--   marca, códigos, unidade, mínimo, ativo, observações).
-- - Preço: o vendedor define no cadastro; depois disso só o admin muda
--   preço e promoção (evita baixar preço para vender barato).
-- - Custo: o vendedor não vê nem altera (entra 0 e o admin completa,
--   ou a nota fiscal preenche).
-- - Estoque: nunca editado direto; sempre por shop_adjust_stock, que
--   grava quem fez e o motivo no histórico.
-- - Categorias e marcas: vendedor pode criar novas na lista suspensa;
--   renomear e excluir continua só do admin.
-- =====================================================================

-- Políticas de escrita para membros em produtos (admin já tem "admin escreve")
drop policy if exists "membros cadastram" on public.shop_products;
drop policy if exists "membros editam" on public.shop_products;
create policy "membros cadastram" on public.shop_products for insert with check (public.shop_is_member());
create policy "membros editam" on public.shop_products for update using (public.shop_is_member()) with check (public.shop_is_member());

drop policy if exists "membros criam" on public.shop_categories;
create policy "membros criam" on public.shop_categories for insert with check (public.shop_is_member());
drop policy if exists "membros criam" on public.shop_brands;
create policy "membros criam" on public.shop_brands for insert with check (public.shop_is_member());

-- Trava dos campos sensíveis quando quem grava é o vendedor direto pela API.
-- Dentro das funções security definer (venda, nota, ajuste de estoque)
-- current_user é o dono da função, então elas continuam funcionando.
create or replace function public.shop_products_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') or public.shop_is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.cost_price := 0;
    new.last_cost := null;
    new.stock_qty := 0;
    new.promo_price := null;
    new.promo_until := null;
  else
    if new.sale_price is distinct from old.sale_price
       or new.promo_price is distinct from old.promo_price
       or new.promo_until is distinct from old.promo_until then
      raise exception 'Só o administrador altera preço e promoção';
    end if;
    new.cost_price := old.cost_price;
    new.last_cost := old.last_cost;
    new.stock_qty := old.stock_qty;
    new.kind := old.kind;
  end if;
  return new;
end $$;

drop trigger if exists shop_products_guard on public.shop_products;
create trigger shop_products_guard before insert or update on public.shop_products
  for each row execute function public.shop_products_guard();

-- Ajuste de estoque liberado para membros. Custo na entrada manual só o admin informa.
create or replace function public.shop_adjust_stock(
  p_product_id uuid, p_kind text, p_qty numeric, p_unit_cost numeric default null, p_notes text default null
) returns numeric language plpgsql security definer set search_path = public as $$
declare v_prod shop_products; v_delta numeric; v_new numeric; v_cost numeric;
begin
  if not public.shop_is_member() then raise exception 'Sem acesso'; end if;
  if coalesce(trim(p_notes), '') = '' then raise exception 'Informe o motivo do ajuste'; end if;
  if not public.shop_is_admin() then p_unit_cost := null; end if;
  select * into v_prod from shop_products where id = p_product_id for update;
  if v_prod.id is null then raise exception 'Produto não encontrado'; end if;
  if v_prod.kind <> 'produto' then raise exception 'Serviço não tem estoque'; end if;

  if p_kind = 'ajuste' then            -- p_qty = nova quantidade contada
    v_delta := p_qty - v_prod.stock_qty;
  elsif p_kind = 'perda' then
    v_delta := -abs(p_qty);
  elsif p_kind = 'entrada_manual' then
    v_delta := abs(p_qty);
  else
    raise exception 'Tipo de ajuste inválido';
  end if;
  v_new := v_prod.stock_qty + v_delta;
  v_cost := v_prod.cost_price;

  if p_kind = 'entrada_manual' and p_unit_cost is not null and p_unit_cost > 0 then
    v_cost := case when v_prod.stock_qty > 0
      then (v_prod.stock_qty * v_prod.cost_price + v_delta * p_unit_cost) / v_new
      else p_unit_cost end;
    update shop_products set stock_qty = v_new, cost_price = round(v_cost, 4), last_cost = p_unit_cost where id = p_product_id;
  else
    update shop_products set stock_qty = v_new where id = p_product_id;
  end if;

  insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, notes, created_by)
  values (p_product_id, p_kind, v_delta, v_new, coalesce(p_unit_cost, v_prod.cost_price), p_notes, auth.uid());
  return v_new;
end $$;
