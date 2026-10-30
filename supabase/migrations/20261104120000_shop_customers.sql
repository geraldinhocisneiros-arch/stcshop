-- =====================================================================
-- Clientes e conta corrente (fiado)
--
-- - Forma de pagamento "conta": a venda vira débito no extrato do cliente
--   e NÃO entra no dinheiro esperado do caixa.
-- - Pagamento de dívida entra no caixa aberto (aparece no fechamento).
-- - Venda cancelada estorna o débito.
-- - Limite de crédito opcional: vendedor não passa dele; admin passa.
-- =====================================================================

create table public.shop_customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  document text,                 -- CPF (opcional)
  email text,
  credit_limit numeric(12,2),    -- null = sem limite
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index shop_customers_name_idx on public.shop_customers (lower(name));

create table public.shop_customer_entries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.shop_customers(id),
  kind text not null check (kind in ('debito', 'pagamento', 'estorno', 'ajuste_debito', 'ajuste_credito')),
  amount numeric(12,2) not null check (amount > 0),
  sale_id uuid references public.shop_sales(id),
  session_id uuid references public.shop_cash_sessions(id),
  method text references public.shop_payment_methods(code),
  fee_amount numeric(12,2) not null default 0,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index shop_customer_entries_customer_idx on public.shop_customer_entries (customer_id, created_at);
create index shop_customer_entries_session_idx on public.shop_customer_entries (session_id);

alter table public.shop_sales add column customer_id uuid references public.shop_customers(id);
create index shop_sales_customer_idx on public.shop_sales (customer_id);

alter table public.shop_settings add column if not exists pix_key text;  -- vai na mensagem de cobrança

insert into public.shop_payment_methods (code, label, fee_pct, sort_order)
values ('conta', 'Conta do cliente (fiado)', 0, 9)
on conflict (code) do nothing;

-- Saldo de cada cliente (positivo = ele deve à loja)
create view public.shop_customer_balances with (security_invoker = true) as
select c.id as customer_id,
  coalesce(sum(case when e.kind in ('debito', 'ajuste_debito') then e.amount
                    when e.kind in ('pagamento', 'estorno', 'ajuste_credito') then -e.amount end), 0) as balance,
  max(e.created_at) filter (where e.kind in ('debito', 'ajuste_debito')) as last_debit_at,
  max(e.created_at) filter (where e.kind = 'pagamento') as last_payment_at
from public.shop_customers c
left join public.shop_customer_entries e on e.customer_id = c.id
group by c.id;
grant select on public.shop_customer_balances to authenticated;

alter table public.shop_customers enable row level security;
alter table public.shop_customer_entries enable row level security;
create policy "membros leem" on public.shop_customers for select using (public.shop_is_member());
create policy "membros cadastram" on public.shop_customers for insert with check (public.shop_is_member());
create policy "membros editam" on public.shop_customers for update using (public.shop_is_member()) with check (public.shop_is_member());
create policy "admin exclui" on public.shop_customers for delete using (public.shop_is_admin());
create policy "membros leem" on public.shop_customer_entries for select using (public.shop_is_member());
-- lançamentos só pelas funções abaixo

-- Receber pagamento de dívida: entra no caixa aberto
create or replace function public.shop_customer_payment(p_customer_id uuid, p_amount numeric, p_method text, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_session uuid; v_fee numeric; v_id uuid;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Informe o valor'; end if;
  if p_method = 'conta' then raise exception 'Escolha como o cliente pagou'; end if;
  perform 1 from shop_customers where id = p_customer_id;
  if not found then raise exception 'Cliente não encontrado'; end if;
  select id into v_session from shop_cash_sessions where status = 'aberto';
  if v_session is null then raise exception 'Abra o caixa para receber pagamentos'; end if;
  select fee_pct into v_fee from shop_payment_methods where code = p_method;
  if v_fee is null then raise exception 'Forma de pagamento inválida'; end if;
  insert into shop_customer_entries (customer_id, kind, amount, session_id, method, fee_amount, notes, created_by)
  values (p_customer_id, 'pagamento', round(p_amount, 2), v_session, p_method, round(p_amount * v_fee / 100, 2), p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Ajuste (saldo anterior ao sistema, correção, perdão de dívida) — só admin
create or replace function public.shop_customer_adjust(p_customer_id uuid, p_kind text, p_amount numeric, p_notes text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador faz ajustes na conta do cliente'; end if;
  if p_kind not in ('ajuste_debito', 'ajuste_credito') then raise exception 'Tipo de ajuste inválido'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Informe o valor'; end if;
  if coalesce(trim(p_notes), '') = '' then raise exception 'Informe o motivo do ajuste'; end if;
  insert into shop_customer_entries (customer_id, kind, amount, notes, created_by)
  values (p_customer_id, p_kind, round(p_amount, 2), p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Venda agora aceita cliente (troca a assinatura: remove a versão antiga)
drop function if exists public.shop_finalize_sale(jsonb, jsonb, numeric, text, text, uuid);
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
  v_is_admin boolean := public.shop_is_admin(); v_max_disc numeric; v_expected numeric;
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
    -- vendedor vende pelo preço cadastrado (ou promoção vigente / valor da ordem de encordoamento)
    if not v_is_admin then
      v_expected := case
        when v_order.id is not null and v_prod.id = v_order.service_product_id and v_order.price is not null then v_order.price
        when v_prod.promo_price is not null and v_prod.promo_until >= (now() at time zone 'America/Recife')::date then v_prod.promo_price
        else v_prod.sale_price end;
      if abs(v_price - v_expected) > 0.009 then
        raise exception 'Preço de "%" diferente do cadastrado. Só o administrador altera preço.', v_prod.name;
      end if;
    end if;
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

create or replace function public.shop_cancel_sale(p_sale_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_sale shop_sales; v_item shop_sale_items; v_kind text; v_new numeric; v_session_status text;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select * into v_sale from shop_sales where id = p_sale_id for update;
  if v_sale.id is null then raise exception 'Venda não encontrada'; end if;
  if v_sale.status = 'cancelada' then raise exception 'Venda já cancelada'; end if;
  select status into v_session_status from shop_cash_sessions where id = v_sale.session_id;
  if v_session_status <> 'aberto' and not public.shop_is_admin() then
    raise exception 'Só o administrador pode cancelar vendas de um caixa já fechado';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo do cancelamento'; end if;

  for v_item in select * from shop_sale_items where sale_id = p_sale_id loop
    select kind into v_kind from shop_products where id = v_item.product_id for update;
    if v_kind = 'produto' then
      update shop_products set stock_qty = stock_qty + v_item.qty where id = v_item.product_id
        returning stock_qty into v_new;
      insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, sale_id, notes, created_by)
      values (v_item.product_id, 'cancelamento_venda', v_item.qty, v_new, v_item.unit_cost, p_sale_id, p_reason, auth.uid());
    end if;
  end loop;

  update shop_sales set status = 'cancelada', canceled_at = now(), canceled_by = auth.uid(), cancel_reason = p_reason
  where id = p_sale_id;
  update shop_stringing_orders set sale_id = null, status = 'pronta', delivered_at = null where sale_id = p_sale_id;
  -- venda na conta do cliente: estorna o débito
  insert into shop_customer_entries (customer_id, kind, amount, sale_id, notes, created_by)
  select customer_id, 'estorno', amount, sale_id, 'Venda nº ' || v_sale.number || ' cancelada: ' || p_reason, auth.uid()
  from shop_customer_entries where sale_id = p_sale_id and kind = 'debito';
end $$;

create or replace function public.shop_cash_summary(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_s shop_cash_sessions;
  v_by_method jsonb;
  v_sales jsonb;
  v_sangria numeric; v_suprimento numeric;
  v_expected jsonb;
  v_receipts jsonb; v_on_account numeric;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select * into v_s from shop_cash_sessions where id = p_session_id;
  if v_s.id is null then raise exception 'Caixa não encontrado'; end if;

  select coalesce(jsonb_object_agg(method, jsonb_build_object('amount', amount, 'fee', fee, 'count', cnt)), '{}'::jsonb)
    into v_by_method
  from (
    select p.method, sum(p.amount) amount, sum(p.fee_amount) fee, count(distinct p.sale_id) cnt
    from shop_sale_payments p join shop_sales s on s.id = p.sale_id
    where s.session_id = p_session_id and s.status = 'concluida'
    group by p.method
  ) t;

  select jsonb_build_object(
    'count', count(*) filter (where status = 'concluida'),
    'canceled', count(*) filter (where status = 'cancelada'),
    'gross', coalesce(sum(subtotal) filter (where status = 'concluida'), 0),
    'discount', coalesce(sum(discount) filter (where status = 'concluida'), 0),
    'total', coalesce(sum(total) filter (where status = 'concluida'), 0),
    'cost', coalesce(sum(cost_total) filter (where status = 'concluida'), 0),
    'fees', coalesce(sum(fee_total) filter (where status = 'concluida'), 0)
  ) into v_sales
  from shop_sales where session_id = p_session_id;

  select coalesce(sum(amount) filter (where kind = 'sangria'), 0),
         coalesce(sum(amount) filter (where kind = 'suprimento'), 0)
    into v_sangria, v_suprimento
  from shop_cash_movements where session_id = p_session_id;

  -- recebimentos de dívidas de clientes neste caixa (entram na gaveta / maquininha)
  select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) into v_receipts
  from (select method, sum(amount) amount from shop_customer_entries
        where session_id = p_session_id and kind = 'pagamento' group by method) r;
  v_on_account := coalesce((v_by_method -> 'conta' ->> 'amount')::numeric, 0);

  -- esperado por forma: vendas + recebimentos de clientes; dinheiro inclui troco
  -- inicial, suprimentos e sangrias. "Conta do cliente" não é dinheiro: fica de fora.
  select coalesce(jsonb_object_agg(code, val), '{}'::jsonb) into v_expected
  from (
    select m.code,
      coalesce((v_by_method -> m.code ->> 'amount')::numeric, 0)
        + coalesce((v_receipts ->> m.code)::numeric, 0)
        + case when m.code = 'dinheiro' then v_s.opening_amount + v_suprimento - v_sangria else 0 end as val
    from shop_payment_methods m
    where (m.active or v_by_method ? m.code or v_receipts ? m.code) and m.code <> 'conta'
  ) e;

  return jsonb_build_object(
    'session', to_jsonb(v_s),
    'by_method', v_by_method,
    'sales', v_sales,
    'sangria', v_sangria,
    'suprimento', v_suprimento,
    'expected', v_expected,
    'receipts', v_receipts,
    'on_account', v_on_account
  );
end $$;
