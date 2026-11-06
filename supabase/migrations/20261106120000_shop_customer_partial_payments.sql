-- =====================================================================
-- Pagamento parcial de dívida (abater aos poucos)
--
-- - Não aceita receber mais do que o cliente deve (evita digitar 2000 em
--   vez de 200 e o caixa não bater).
-- - Estornar um pagamento lançado errado: só enquanto o caixa em que ele
--   entrou estiver aberto; o valor sai do esperado daquele caixa e volta
--   para a dívida do cliente. Caixa já fechado: o admin faz um ajuste.
-- =====================================================================

alter table public.shop_customer_entries
  add column if not exists reverses_id uuid unique references public.shop_customer_entries(id);

alter table public.shop_customer_entries drop constraint if exists shop_customer_entries_kind_check;
alter table public.shop_customer_entries add constraint shop_customer_entries_kind_check
  check (kind in ('debito', 'pagamento', 'estorno', 'ajuste_debito', 'ajuste_credito', 'estorno_pagamento'));

-- Saldo: pagamento estornado volta a ser dívida
create or replace view public.shop_customer_balances with (security_invoker = true) as
select c.id as customer_id,
  coalesce(sum(case when e.kind in ('debito', 'ajuste_debito', 'estorno_pagamento') then e.amount
                    when e.kind in ('pagamento', 'estorno', 'ajuste_credito') then -e.amount end), 0) as balance,
  max(e.created_at) filter (where e.kind in ('debito', 'ajuste_debito')) as last_debit_at,
  max(e.created_at) filter (where e.kind = 'pagamento' and not exists (
    select 1 from public.shop_customer_entries r where r.reverses_id = e.id)) as last_payment_at
from public.shop_customers c
left join public.shop_customer_entries e on e.customer_id = c.id
group by c.id;
grant select on public.shop_customer_balances to authenticated;

-- Receber pagamento (parcial ou total): entra no caixa aberto
create or replace function public.shop_customer_payment(p_customer_id uuid, p_amount numeric, p_method text, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_session uuid; v_fee numeric; v_id uuid; v_balance numeric; v_amount numeric := round(coalesce(p_amount, 0), 2);
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  if v_amount <= 0 then raise exception 'Informe o valor'; end if;
  if p_method = 'conta' then raise exception 'Escolha como o cliente pagou'; end if;
  -- trava o cliente: dois recebimentos ao mesmo tempo não passam do saldo
  perform 1 from shop_customers where id = p_customer_id for update;
  if not found then raise exception 'Cliente não encontrado'; end if;
  select id into v_session from shop_cash_sessions where status = 'aberto';
  if v_session is null then raise exception 'Abra o caixa para receber pagamentos'; end if;
  select fee_pct into v_fee from shop_payment_methods where code = p_method;
  if v_fee is null then raise exception 'Forma de pagamento inválida'; end if;
  select coalesce(balance, 0) into v_balance from shop_customer_balances where customer_id = p_customer_id;
  if v_amount > coalesce(v_balance, 0) + 0.009 then
    raise exception 'Valor maior que a dívida: o cliente deve %', to_char(greatest(coalesce(v_balance, 0), 0), 'FM999G999G990D00');
  end if;
  insert into shop_customer_entries (customer_id, kind, amount, session_id, method, fee_amount, notes, created_by)
  values (p_customer_id, 'pagamento', v_amount, v_session, p_method, round(v_amount * v_fee / 100, 2), p_notes, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Estornar pagamento lançado errado
create or replace function public.shop_customer_payment_reverse(p_entry_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_e shop_customer_entries; v_status text; v_id uuid;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo do estorno'; end if;
  select * into v_e from shop_customer_entries where id = p_entry_id for update;
  if v_e.id is null or v_e.kind <> 'pagamento' then raise exception 'Pagamento não encontrado'; end if;
  if exists (select 1 from shop_customer_entries where reverses_id = p_entry_id) then
    raise exception 'Esse pagamento já foi estornado';
  end if;
  select status into v_status from shop_cash_sessions where id = v_e.session_id;
  if v_status is distinct from 'aberto' then
    raise exception 'O caixa desse pagamento já foi fechado. Peça ao administrador um ajuste na conta do cliente.';
  end if;
  insert into shop_customer_entries (customer_id, kind, amount, session_id, method, fee_amount, notes, reverses_id, created_by)
  values (v_e.customer_id, 'estorno_pagamento', v_e.amount, v_e.session_id, v_e.method, v_e.fee_amount,
          'Estorno: ' || p_reason, v_e.id, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Fechamento: recebimentos de clientes já descontam os estornos
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

  -- recebimentos de dívidas de clientes neste caixa, menos os estornados
  select coalesce(jsonb_object_agg(method, amount), '{}'::jsonb) into v_receipts
  from (select method, sum(case when kind = 'pagamento' then amount else -amount end) amount
        from shop_customer_entries
        where session_id = p_session_id and kind in ('pagamento', 'estorno_pagamento')
        group by method
        having sum(case when kind = 'pagamento' then amount else -amount end) <> 0) r;
  v_on_account := coalesce((v_by_method -> 'conta' ->> 'amount')::numeric, 0);

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
