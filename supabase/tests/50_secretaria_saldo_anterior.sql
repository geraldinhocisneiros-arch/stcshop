-- Rode depois de todas as migrations e dos testes 10..40
\set ON_ERROR_STOP 1
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
update shop_cash_sessions set status='fechado', closed_at=now() where status='aberto';
select shop_open_cash(0) as caixa \gset
insert into shop_customers (id,name) values ('cccccccc-0000-0000-0000-000000000002','João Antigo');
-- débito do sistema antigo com a data original
select shop_customer_adjust('cccccccc-0000-0000-0000-000000000002','ajuste_debito',150,'Raquete (sistema antigo)', date '2026-08-15') is not null as ok;
select (created_at at time zone 'America/Recife')::date as data_original from shop_customer_entries where customer_id='cccccccc-0000-0000-0000-000000000002';
select balance from shop_customer_balances where customer_id='cccccccc-0000-0000-0000-000000000002';
do $$ begin perform shop_customer_adjust('cccccccc-0000-0000-0000-000000000002','ajuste_debito',10,'x', current_date + 5);
  raise exception 'devia falhar'; exception when others then raise notice 'data futura: %', sqlerrm; end $$;
-- venda 39,90 na secretaria + recebimento de dívida na secretaria: nada disso no esperado
select (shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]',
  '[{"method":"secretaria","amount":39.9}]', 0, null, null, null, 'cccccccc-0000-0000-0000-000000000002')->>'total')::numeric as venda;
select shop_customer_payment('cccccccc-0000-0000-0000-000000000002', 50, 'secretaria') is not null as pagou;
select s->'expected' as esperado, s->'secretaria' as secretaria from shop_cash_summary(:'caixa') s;
