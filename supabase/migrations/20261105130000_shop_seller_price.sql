-- Vendedor pode alterar preço de venda
-- - No caixa: o preço do item vale só para aquela venda (fica gravado no item da venda).
-- - No cadastro: o vendedor também muda o preço de venda. Promoção e custo continuam
--   só do administrador (trava shop_products_guard, que veio de 20261105120000).
-- - Toda mudança do preço de venda no cadastro fica em shop_price_changes (quem, de, para, quando),
--   venha ela do vendedor ou do administrador.
-- O limite de desconto do vendedor continua valendo sobre o total da venda.

create table if not exists public.shop_price_changes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  old_price numeric(12,2),
  new_price numeric(12,2) not null,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz not null default now()
);
create index if not exists shop_price_changes_product_idx on public.shop_price_changes (product_id, changed_at desc);
alter table public.shop_price_changes enable row level security;
drop policy if exists "membros leem" on public.shop_price_changes;
create policy "membros leem" on public.shop_price_changes for select using (public.shop_is_member());

create or replace function public.shop_log_price_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.sale_price is distinct from old.sale_price then
    insert into shop_price_changes (product_id, old_price, new_price, changed_by, changed_by_name)
    values (new.id, old.sale_price, new.sale_price, auth.uid(),
            (select full_name from shop_user_roles where user_id = auth.uid()));
  end if;
  return new;
end $$;

drop trigger if exists shop_products_price_log on public.shop_products;
create trigger shop_products_price_log after update of sale_price on public.shop_products
  for each row execute function public.shop_log_price_change();

-- Trava do cadastro: igual à de 20261105120000_shop_seller_products_stock,
-- mas o vendedor agora pode mudar o preço de venda (promoção e custo seguem só do admin).
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
    if new.promo_price is distinct from old.promo_price
       or new.promo_until is distinct from old.promo_until then
      raise exception 'Só o administrador altera promoção';
    end if;
    if new.sale_price is null or new.sale_price < 0 then
      raise exception 'Preço inválido';
    end if;
    new.cost_price := old.cost_price;
    new.last_cost := old.last_cost;
    new.stock_qty := old.stock_qty;
    new.kind := old.kind;
  end if;
  return new;
end $$;

drop function if exists public.shop_set_sale_price(uuid, numeric);

-- Venda: igual à versão anterior, sem a trava "só o administrador altera preço".
create or replace function public.shop_finalize_sale(
  p_items jsonb, p_payments jsonb, p_discount numeric default 0,
  p_customer_name text default null, p_notes text default null,
  p_stringing_order_id uuid default null,
  p_customer_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session uuid; v_sale uuid; v_number bigint;
  v_allow_negative boolean;
  v_subtotal numeric := 0; v_discount numeric := round(coalesce(p_discount, 0), 2);
  v_total numeric; v_paid numeric := 0; v_fee_total numeric := 0; v_cost_total numeric := 0;
  v_item jsonb; v_pay jsonb; v_prod shop_products;
  v_qty numeric; v_price numeric; v_line numeric; v_line_disc numeric; v_disc_left numeric;
  v_fee_pct numeric; v_count int; v_i int := 0;
  v_is_admin boolean := public.shop_is_admin(); v_max_disc numeric;
  v_order shop_stringing_orders;
  v_customer shop_customers; v_on_account numeric := 0; v_balance numeric;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select id into v_session from shop_cash_sessions where status = 'aberto';
  if v_session is null then raise exception 'Abra o caixa antes de vender'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Venda sem itens'; end if;
  select allow_negative_stock, max_seller_discount_pct into v_allow_negative, v_max_disc from shop_settings where id = 1;
  if p_stringing_order_id is not null then
    select * into v_order from shop_stringing_orders where id = p_stringing_order_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_subtotal := v_subtotal + round((v_item->>'qty')::numeric * (v_item->>'unit_price')::numeric, 2);
  end loop;
  if v_discount < 0 or v_discount > v_subtotal then raise exception 'Desconto inválido'; end if;
  if not v_is_admin and v_subtotal > 0 and v_discount > round(v_subtotal * v_max_disc / 100, 2) then
    raise exception 'Desconto acima do limite do vendedor (% %%). Peça ao administrador.', v_max_disc;
  end if;
  v_total := v_subtotal - v_discount;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_paid := v_paid + round((v_pay->>'amount')::numeric, 2);
  end loop;
  if abs(v_paid - v_total) > 0.009 then
    raise exception 'Pagamentos (%) não batem com o total (%)', v_paid, v_total;
  end if;

  -- cliente e "conta do cliente" (fiado)
  if p_customer_id is not null then
    select * into v_customer from shop_customers where id = p_customer_id;
    if v_customer.id is null then raise exception 'Cliente não encontrado'; end if;
  end if;
  select coalesce(sum(round((e->>'amount')::numeric, 2)), 0) into v_on_account
  from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) e where e->>'method' = 'conta';
  if v_on_account > 0 then
    if v_customer.id is null then raise exception 'Escolha o cliente para lançar na conta'; end if;
    if not v_customer.active then raise exception 'Cliente "%" está inativo', v_customer.name; end if;
    if v_customer.credit_limit is not null and not v_is_admin then
      select coalesce(balance, 0) into v_balance from shop_customer_balances where customer_id = v_customer.id;
      if coalesce(v_balance, 0) + v_on_account > v_customer.credit_limit + 0.009 then
        raise exception 'Passa do limite de crédito de % (limite %, já deve %). Peça ao administrador.',
          v_customer.name, v_customer.credit_limit, coalesce(v_balance, 0);
      end if;
    end if;
  end if;

  -- valida estoque antes de gravar, para não queimar número de venda à toa
  if not v_allow_negative then
    for v_prod in
      select p.* from shop_products p
      join (select (e->>'product_id')::uuid pid, sum((e->>'qty')::numeric) q
              from jsonb_array_elements(p_items) e group by 1) w on w.pid = p.id
      where p.kind = 'produto' and p.stock_qty < w.q
    loop
      raise exception 'Estoque insuficiente de "%" (tem %)', v_prod.name, v_prod.stock_qty;
    end loop;
  end if;

  insert into shop_sales (session_id, customer_id, customer_name, subtotal, discount, total, notes, created_by)
  values (v_session, v_customer.id, coalesce(v_customer.name, nullif(trim(p_customer_name), '')), v_subtotal, v_discount, v_total, p_notes, auth.uid())
  returning id, number into v_sale, v_number;

  v_count := jsonb_array_length(p_items);
  v_disc_left := v_discount;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    select * into v_prod from shop_products where id = (v_item->>'product_id')::uuid for update;
    if v_prod.id is null then raise exception 'Produto não encontrado'; end if;
    v_qty := (v_item->>'qty')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    if v_qty <= 0 then raise exception 'Quantidade inválida para %', v_prod.name; end if;
    if v_price is null or v_price < 0 then raise exception 'Preço inválido para %', v_prod.name; end if;
    v_line := round(v_qty * v_price, 2);
    -- rateia o desconto proporcionalmente; a última linha leva o resto
    if v_i = v_count then v_line_disc := v_disc_left;
    elsif v_subtotal > 0 then v_line_disc := round(v_discount * v_line / v_subtotal, 2);
    else v_line_disc := 0; end if;
    v_disc_left := v_disc_left - v_line_disc;

    insert into shop_sale_items (sale_id, product_id, description, qty, unit_price, discount, total, unit_cost)
    values (v_sale, v_prod.id, v_prod.name, v_qty, v_price, v_line_disc, v_line - v_line_disc, v_prod.cost_price);
    v_cost_total := v_cost_total + round(v_qty * v_prod.cost_price, 2);

    if v_prod.kind = 'produto' then
      if not v_allow_negative and v_prod.stock_qty < v_qty then
        raise exception 'Estoque insuficiente de "%" (tem %, pediu %)', v_prod.name, v_prod.stock_qty, v_qty;
      end if;
      update shop_products set stock_qty = stock_qty - v_qty where id = v_prod.id;
      insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, sale_id, created_by)
      values (v_prod.id, 'venda', -v_qty, v_prod.stock_qty - v_qty, v_prod.cost_price, v_sale, auth.uid());
    end if;
  end loop;

  for v_pay in select * from jsonb_array_elements(p_payments) loop
    select fee_pct into v_fee_pct from shop_payment_methods where code = v_pay->>'method';
    if v_fee_pct is null then raise exception 'Forma de pagamento inválida: %', v_pay->>'method'; end if;
    insert into shop_sale_payments (sale_id, method, amount, fee_pct, fee_amount)
    values (v_sale, v_pay->>'method', round((v_pay->>'amount')::numeric, 2), v_fee_pct,
            round((v_pay->>'amount')::numeric * v_fee_pct / 100, 2));
    v_fee_total := v_fee_total + round((v_pay->>'amount')::numeric * v_fee_pct / 100, 2);
  end loop;

  update shop_sales set cost_total = v_cost_total, fee_total = v_fee_total where id = v_sale;

  if v_on_account > 0 then
    insert into shop_customer_entries (customer_id, kind, amount, sale_id, session_id, notes, created_by)
    values (v_customer.id, 'debito', v_on_account, v_sale, v_session, 'Venda nº ' || v_number, auth.uid());
  end if;

  if p_stringing_order_id is not null then
    update shop_stringing_orders
      set sale_id = v_sale, status = 'entregue', delivered_at = coalesce(delivered_at, now())
    where id = p_stringing_order_id;
  end if;

  return jsonb_build_object('id', v_sale, 'number', v_number, 'total', v_total);
end $$;
