-- =====================================================================
-- Editar venda já feita (produto, quantidade, preço, desconto, cliente,
-- forma de pagamento) sem cancelar e refazer.
--
-- - Mantém o número, o caixa e a data da venda.
-- - Estoque: lança só a DIFERENÇA de cada produto (movimento "edicao_venda").
-- - Conta do cliente (fiado): lança a diferença (débito ou estorno); se trocou
--   de cliente, estorna tudo do antigo e debita o novo.
-- - Mesmas regras da venda: vendedor só edita no caixa aberto, não muda preço
--   (pode manter o preço original de quem já estava na venda), respeita o
--   desconto máximo e o limite de crédito do cliente.
-- - Motivo obrigatório. Cada edição guarda o "antes" e o "depois" (auditoria).
-- =====================================================================

alter table public.shop_sales
  add column if not exists edited_at timestamptz,
  add column if not exists edit_count int not null default 0;

create table if not exists public.shop_sale_edits (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.shop_sales(id) on delete cascade,
  reason text not null,
  before jsonb not null,
  after jsonb not null,
  edited_by uuid references auth.users(id),
  edited_at timestamptz not null default now()
);
create index if not exists shop_sale_edits_sale_idx on public.shop_sale_edits (sale_id, edited_at);
alter table public.shop_sale_edits enable row level security;
drop policy if exists "membros leem" on public.shop_sale_edits;
create policy "membros leem" on public.shop_sale_edits for select using (public.shop_is_member());
-- gravação só pela função shop_edit_sale

alter table public.shop_stock_movements drop constraint if exists shop_stock_movements_kind_check;
alter table public.shop_stock_movements add constraint shop_stock_movements_kind_check
  check (kind in ('entrada_nf', 'estorno_nf', 'entrada_manual', 'venda', 'cancelamento_venda', 'edicao_venda', 'ajuste', 'perda'));

-- Foto da venda (para o histórico de edições)
create or replace function public.shop__sale_snapshot(p_sale_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'customer_id', s.customer_id,
    'customer_name', s.customer_name,
    'subtotal', s.subtotal,
    'discount', s.discount,
    'total', s.total,
    'items', coalesce((select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'description', i.description,
                         'qty', i.qty, 'unit_price', i.unit_price) order by i.description)
                       from shop_sale_items i where i.sale_id = s.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', p.method, 'amount', p.amount) order by p.method)
                          from shop_sale_payments p where p.sale_id = s.id), '[]'::jsonb)
  )
  from shop_sales s where s.id = p_sale_id
$$;
revoke execute on function public.shop__sale_snapshot(uuid) from public, anon, authenticated;

create or replace function public.shop_edit_sale(
  p_sale_id uuid, p_items jsonb, p_payments jsonb, p_discount numeric default 0,
  p_customer_id uuid default null, p_customer_name text default null, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sale shop_sales; v_session_status text;
  v_allow_negative boolean; v_max_disc numeric;
  v_is_admin boolean := public.shop_is_admin();
  v_order shop_stringing_orders;
  v_before jsonb; v_after jsonb;
  v_old_items jsonb;          -- {product_id: {qty, unit_price, unit_cost}}
  v_subtotal numeric := 0; v_discount numeric := round(coalesce(p_discount, 0), 2);
  v_total numeric; v_paid numeric := 0; v_fee_total numeric := 0; v_cost_total numeric := 0;
  v_item jsonb; v_pay jsonb; v_prod shop_products; v_old jsonb;
  v_qty numeric; v_price numeric; v_cost numeric; v_line numeric; v_line_disc numeric; v_disc_left numeric;
  v_fee_pct numeric; v_count int; v_i int := 0; v_expected numeric;
  v_customer shop_customers; v_on_account numeric := 0; v_old_on_customer numeric := 0; v_balance numeric;
  v_diff record; v_new numeric; v_acc record; v_note text;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select * into v_sale from shop_sales where id = p_sale_id for update;
  if v_sale.id is null then raise exception 'Venda não encontrada'; end if;
  if v_sale.status = 'cancelada' then raise exception 'Venda cancelada não pode ser editada'; end if;
  select status into v_session_status from shop_cash_sessions where id = v_sale.session_id;
  if v_session_status <> 'aberto' and not v_is_admin then
    raise exception 'Só o administrador pode editar vendas de um caixa já fechado';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo da alteração'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Venda sem itens. Para desfazer a venda inteira, use Cancelar venda.';
  end if;
  select allow_negative_stock, max_seller_discount_pct into v_allow_negative, v_max_disc from shop_settings where id = 1;
  select * into v_order from shop_stringing_orders where sale_id = p_sale_id limit 1;

  v_before := public.shop__sale_snapshot(p_sale_id);
  select coalesce(jsonb_object_agg(product_id, jsonb_build_object('qty', qty, 'unit_price', unit_price, 'unit_cost', unit_cost)), '{}'::jsonb)
    into v_old_items
  from (select product_id, sum(qty) qty, max(unit_price) unit_price, max(unit_cost) unit_cost
        from shop_sale_items where sale_id = p_sale_id group by product_id) o;

  -- totais e desconto
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_subtotal := v_subtotal + round((v_item->>'qty')::numeric * (v_item->>'unit_price')::numeric, 2);
  end loop;
  if v_discount < 0 or v_discount > v_subtotal then raise exception 'Desconto inválido'; end if;
  if not v_is_admin and v_subtotal > 0 and v_discount > round(v_subtotal * v_max_disc / 100, 2) then
    raise exception 'Desconto acima do limite do vendedor (% %%). Peça ao administrador.', v_max_disc;
  end if;
  v_total := v_subtotal - v_discount;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    if round((v_pay->>'amount')::numeric, 2) <= 0 then raise exception 'Valor de pagamento inválido'; end if;
    v_paid := v_paid + round((v_pay->>'amount')::numeric, 2);
  end loop;
  if abs(v_paid - v_total) > 0.009 then
    raise exception 'Pagamentos (%) não batem com o total (%)', v_paid, v_total;
  end if;

  -- cliente e fiado
  if p_customer_id is not null then
    select * into v_customer from shop_customers where id = p_customer_id;
    if v_customer.id is null then raise exception 'Cliente não encontrado'; end if;
  end if;
  select coalesce(sum(round((e->>'amount')::numeric, 2)), 0) into v_on_account
  from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) e where e->>'method' = 'conta';
  if v_customer.id is not null then
    select coalesce(sum(case when kind = 'debito' then amount when kind = 'estorno' then -amount end), 0)
      into v_old_on_customer
    from shop_customer_entries where sale_id = p_sale_id and customer_id = v_customer.id;
  end if;
  if v_on_account > 0 then
    if v_customer.id is null then raise exception 'Escolha o cliente para lançar na conta'; end if;
    if v_on_account > v_old_on_customer + 0.009 then
      if not v_customer.active then raise exception 'Cliente "%" está inativo', v_customer.name; end if;
      if v_customer.credit_limit is not null and not v_is_admin then
        select coalesce(balance, 0) into v_balance from shop_customer_balances where customer_id = v_customer.id;
        if coalesce(v_balance, 0) - v_old_on_customer + v_on_account > v_customer.credit_limit + 0.009 then
          raise exception 'Passa do limite de crédito de % (limite %, já deve %). Peça ao administrador.',
            v_customer.name, v_customer.credit_limit, coalesce(v_balance, 0) - v_old_on_customer;
        end if;
      end if;
    end if;
  end if;

  -- produtos e preços
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from shop_products where id = (v_item->>'product_id')::uuid;
    if v_prod.id is null then raise exception 'Produto não encontrado'; end if;
    if (v_item->>'qty')::numeric <= 0 then raise exception 'Quantidade inválida para %', v_prod.name; end if;
    if not v_is_admin then
      v_price := (v_item->>'unit_price')::numeric;
      v_old := v_old_items -> v_prod.id::text;
      v_expected := case
        when v_order.id is not null and v_prod.id = v_order.service_product_id and v_order.price is not null then v_order.price
        when v_prod.promo_price is not null and v_prod.promo_until >= (now() at time zone 'America/Recife')::date then v_prod.promo_price
        else v_prod.sale_price end;
      -- pode manter o preço com que o item já estava na venda (ex.: promoção que acabou)
      if abs(v_price - v_expected) > 0.009 and (v_old is null or abs(v_price - (v_old->>'unit_price')::numeric) > 0.009) then
        raise exception 'Preço de "%" diferente do cadastrado. Só o administrador altera preço.', v_prod.name;
      end if;
    end if;
  end loop;

  -- estoque: aplica só a diferença por produto
  for v_diff in
    select p.id, p.name, p.kind, p.stock_qty, p.cost_price,
           coalesce(n.q, 0) - coalesce(o.q, 0) as delta,
           (v_old_items -> p.id::text ->> 'unit_cost')::numeric as old_cost
    from shop_products p
    left join (select (e->>'product_id')::uuid pid, sum((e->>'qty')::numeric) q from jsonb_array_elements(p_items) e group by 1) n on n.pid = p.id
    left join (select product_id pid, sum(qty) q from shop_sale_items where sale_id = p_sale_id group by 1) o on o.pid = p.id
    where (n.pid is not null or o.pid is not null) and p.kind = 'produto'
      and coalesce(n.q, 0) - coalesce(o.q, 0) <> 0
    order by p.id
    for update of p
  loop
    if v_diff.delta > 0 and not v_allow_negative and v_diff.stock_qty < v_diff.delta then
      raise exception 'Estoque insuficiente de "%" (tem %, precisa de mais %)', v_diff.name, v_diff.stock_qty, v_diff.delta;
    end if;
    update shop_products set stock_qty = stock_qty - v_diff.delta where id = v_diff.id returning stock_qty into v_new;
    insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, sale_id, notes, created_by)
    values (v_diff.id, 'edicao_venda', -v_diff.delta, v_new, coalesce(v_diff.old_cost, v_diff.cost_price), p_sale_id,
            'Venda nº ' || v_sale.number || ' editada: ' || p_reason, auth.uid());
  end loop;

  -- regrava itens e pagamentos
  delete from shop_sale_items where sale_id = p_sale_id;
  delete from shop_sale_payments where sale_id = p_sale_id;

  v_count := jsonb_array_length(p_items);
  v_disc_left := v_discount;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    select * into v_prod from shop_products where id = (v_item->>'product_id')::uuid;
    v_qty := (v_item->>'qty')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    -- item que já estava na venda mantém o custo da época; item novo usa o custo atual
    v_cost := coalesce((v_old_items -> v_prod.id::text ->> 'unit_cost')::numeric, v_prod.cost_price);
    v_line := round(v_qty * v_price, 2);
    if v_i = v_count then v_line_disc := v_disc_left;
    elsif v_subtotal > 0 then v_line_disc := round(v_discount * v_line / v_subtotal, 2);
    else v_line_disc := 0; end if;
    v_disc_left := v_disc_left - v_line_disc;
    insert into shop_sale_items (sale_id, product_id, description, qty, unit_price, discount, total, unit_cost)
    values (p_sale_id, v_prod.id, v_prod.name, v_qty, v_price, v_line_disc, v_line - v_line_disc, v_cost);
    v_cost_total := v_cost_total + round(v_qty * v_cost, 2);
  end loop;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    select fee_pct into v_fee_pct from shop_payment_methods where code = v_pay->>'method';
    if v_fee_pct is null then raise exception 'Forma de pagamento inválida: %', v_pay->>'method'; end if;
    insert into shop_sale_payments (sale_id, method, amount, fee_pct, fee_amount)
    values (p_sale_id, v_pay->>'method', round((v_pay->>'amount')::numeric, 2), v_fee_pct,
            round((v_pay->>'amount')::numeric * v_fee_pct / 100, 2));
    v_fee_total := v_fee_total + round((v_pay->>'amount')::numeric * v_fee_pct / 100, 2);
  end loop;

  update shop_sales set
    customer_id = v_customer.id,
    customer_name = coalesce(v_customer.name, nullif(trim(p_customer_name), '')),
    subtotal = v_subtotal, discount = v_discount, total = v_total,
    cost_total = v_cost_total, fee_total = v_fee_total,
    edited_at = now(), edit_count = edit_count + 1
  where id = p_sale_id;

  -- conta do cliente: acerta a diferença
  v_note := 'Venda nº ' || v_sale.number || ' editada: ' || p_reason;
  for v_acc in
    select customer_id, sum(case when kind = 'debito' then amount when kind = 'estorno' then -amount end) net
    from shop_customer_entries where sale_id = p_sale_id group by customer_id
  loop
    if v_acc.customer_id is distinct from v_customer.id and v_acc.net > 0.004 then
      insert into shop_customer_entries (customer_id, kind, amount, sale_id, notes, created_by)
      values (v_acc.customer_id, 'estorno', v_acc.net, p_sale_id, v_note, auth.uid());
    end if;
  end loop;
  if v_customer.id is not null then
    if v_on_account - v_old_on_customer > 0.004 then
      insert into shop_customer_entries (customer_id, kind, amount, sale_id, session_id, notes, created_by)
      values (v_customer.id, 'debito', v_on_account - v_old_on_customer, p_sale_id, v_sale.session_id, v_note, auth.uid());
    elsif v_old_on_customer - v_on_account > 0.004 then
      insert into shop_customer_entries (customer_id, kind, amount, sale_id, notes, created_by)
      values (v_customer.id, 'estorno', v_old_on_customer - v_on_account, p_sale_id, v_note, auth.uid());
    end if;
  end if;

  v_after := public.shop__sale_snapshot(p_sale_id);
  insert into shop_sale_edits (sale_id, reason, before, after, edited_by)
  values (p_sale_id, trim(p_reason), v_before, v_after, auth.uid());

  return jsonb_build_object('id', p_sale_id, 'number', v_sale.number, 'total', v_total);
end $$;

-- Cancelamento: estorna o SALDO da venda em cada conta (a venda pode ter sido
-- editada e ter vários débitos/estornos).
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
  insert into shop_customer_entries (customer_id, kind, amount, sale_id, notes, created_by)
  select customer_id, 'estorno', net, p_sale_id, 'Venda nº ' || v_sale.number || ' cancelada: ' || p_reason, auth.uid()
  from (select customer_id, sum(case when kind = 'debito' then amount when kind = 'estorno' then -amount end) net
        from shop_customer_entries where sale_id = p_sale_id group by customer_id) t
  where net > 0.004;
end $$;
