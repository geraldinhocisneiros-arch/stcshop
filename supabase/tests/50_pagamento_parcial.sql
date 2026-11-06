-- Rode depois do 40_clientes_fiado.sql
\set ON_ERROR_STOP 1
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
update shop_cash_sessions set status='fechado', closed_at=now() where status='aberto';
select shop_open_cash(0) as caixa \gset
insert into shop_customers (id,name,phone) values ('cccccccc-0000-0000-0000-000000000002','João Parcelado','81988880000');
select shop_customer_adjust('cccccccc-0000-0000-0000-000000000002','ajuste_debito',1000,'deixou mil reais') is not null as divida;

-- paga 200 (dinheiro) e depois 300 (pix): sobra 500
select shop_customer_payment('cccccccc-0000-0000-0000-000000000002', 200, 'dinheiro') as pag1 \gset
select shop_customer_payment('cccccccc-0000-0000-0000-000000000002', 300, 'pix') is not null as pag2;
do $$ begin
  if (select balance from shop_customer_balances where customer_id='cccccccc-0000-0000-0000-000000000002') <> 500 then
    raise exception 'saldo devia ser 500'; end if; end $$;

-- não recebe mais do que deve
do $$ begin perform shop_customer_payment('cccccccc-0000-0000-0000-000000000002', 600, 'pix');
  raise exception 'devia falhar'; exception when others then
  if sqlerrm = 'devia falhar' then raise; end if; raise notice 'acima da dívida: %', sqlerrm; end $$;

-- vendedor estorna os 200 lançados errado: dívida volta a 700, dinheiro esperado sai do caixa
select set_config('test.uid','22222222-2222-2222-2222-222222222222',false);
select shop_customer_payment_reverse(:'pag1', 'lançado errado') is not null as estornou;
do $$ begin perform shop_customer_payment_reverse((select id from shop_customer_entries where kind='pagamento' and amount=200 and customer_id='cccccccc-0000-0000-0000-000000000002'), 'de novo');
  raise exception 'devia falhar'; exception when others then
  if sqlerrm = 'devia falhar' then raise; end if; raise notice 'estorno duplo: %', sqlerrm; end $$;
do $$ declare s jsonb; begin
  if (select balance from shop_customer_balances where customer_id='cccccccc-0000-0000-0000-000000000002') <> 700 then
    raise exception 'saldo devia ser 700'; end if;
  s := shop_cash_summary((select id from shop_cash_sessions where status='aberto'));
  if (s->'expected'->>'dinheiro')::numeric <> 0 then raise exception 'dinheiro esperado devia ser 0: %', s->'expected'; end if;
  if (s->'expected'->>'pix')::numeric <> 300 then raise exception 'pix esperado devia ser 300: %', s->'expected'; end if;
  if s->'receipts' ? 'dinheiro' then raise exception 'recebimento estornado não devia aparecer: %', s->'receipts'; end if;
end $$;

-- caixa fechado: não estorna mais (só ajuste do admin)
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
update shop_cash_sessions set status='fechado', closed_at=now() where status='aberto';
do $$ begin perform shop_customer_payment_reverse((select id from shop_customer_entries where kind='pagamento' and amount=300 and customer_id='cccccccc-0000-0000-0000-000000000002'), 'tarde');
  raise exception 'devia falhar'; exception when others then
  if sqlerrm = 'devia falhar' then raise; end if; raise notice 'caixa fechado: %', sqlerrm; end $$;
select 'ok pagamento parcial' as resultado;
