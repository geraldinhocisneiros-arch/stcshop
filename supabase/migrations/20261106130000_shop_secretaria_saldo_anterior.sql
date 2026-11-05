-- =====================================================================
-- 1) Forma de pagamento "Secretaria": o cliente acerta na secretaria da
--    academia. Não é dinheiro da loja: fica fora do esperado do caixa e
--    aparece separado no fechamento ("Lançado na secretaria").
-- 2) Ajuste de saldo anterior aceita a DATA original da dívida (débitos
--    trazidos do sistema antigo mantêm a data na cobrança e no extrato).
-- =====================================================================

insert into public.shop_payment_methods (code, label, fee_pct, sort_order)
values ('secretaria', 'Secretaria', 0, 8)
on conflict (code) do nothing;

drop function if exists public.shop_customer_adjust(uuid, text, numeric, text);
create or replace function public.shop_customer_adjust(
  p_customer_id uuid, p_kind text, p_amount numeric, p_notes text, p_date date default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador faz ajustes na conta do cliente'; end if;
  if p_kind not in ('ajuste_debito', 'ajuste_credito') then raise exception 'Tipo de ajuste inválido'; end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Informe o valor'; end if;
  if coalesce(trim(p_notes), '') = '' then raise exception 'Informe o motivo do ajuste'; end if;
  if p_date is not null and p_date > (now() at time zone 'America/Recife')::date then raise exception 'A data não pode ser no futuro'; end if;
  perform 1 from shop_customers where id = p_customer_id;
  if not found then raise exception 'Cliente não encontrado'; end if;
  insert into shop_customer_entries (customer_id, kind, amount, notes, created_by, created_at)
  values (p_customer_id, p_kind, round(p_amount, 2), p_notes, auth.uid(),
          case when p_date is null or p_date = (now() at time zone 'America/Recife')::date then now()
               else (p_date::timestamp + time '12:00') at time zone 'America/Recife' end)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.shop_cash_summary(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_s shop_cash_sessions;
  v_by_method jsonb;
  v_sales jsonb;
  v_sangria numeric; v_suprimento numeric;
  v_expected jsonb;
  v_receipts jsonb; v_on_account numeric; v_secretaria numeric;
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
  -- secretaria: vendas + recebimentos acertados na secretaria da academia
  v_secretaria := coalesce((v_by_method -> 'secretaria' ->> 'amount')::numeric, 0)
                + coalesce((v_receipts ->> 'secretaria')::numeric, 0);

  -- esperado por forma: vendas + recebimentos de clientes; dinheiro inclui troco
  -- inicial, suprimentos e sangrias. "Conta do cliente" não é dinheiro: fica de fora.
  select coalesce(jsonb_object_agg(code, val), '{}'::jsonb) into v_expected
  from (
    select m.code,
      coalesce((v_by_method -> m.code ->> 'amount')::numeric, 0)
        + coalesce((v_receipts ->> m.code)::numeric, 0)
        + case when m.code = 'dinheiro' then v_s.opening_amount + v_suprimento - v_sangria else 0 end as val
    from shop_payment_methods m
    where (m.active or v_by_method ? m.code or v_receipts ? m.code) and m.code not in ('conta', 'secretaria')
  ) e;

  return jsonb_build_object(
    'session', to_jsonb(v_s),
    'by_method', v_by_method,
    'sales', v_sales,
    'sangria', v_sangria,
    'suprimento', v_suprimento,
    'expected', v_expected,
    'receipts', v_receipts,
    'on_account', v_on_account,
    'secretaria', v_secretaria
  );
end $$;
