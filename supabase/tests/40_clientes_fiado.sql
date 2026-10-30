-- Rode depois de todas as migrations e dos testes 10/20/30
\set ON_ERROR_STOP 1
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
update shop_cash_sessions set status='fechado', closed_at=now() where status='aberto';
select shop_open_cash(50) as caixa \gset
insert into shop_customers (id,name,phone,credit_limit) values ('cccccccc-0000-0000-0000-000000000001','Maria Souza','81999990000',100);
update shop_products set promo_price=null, promo_until=null, stock_qty=50 where id='aaaaaaaa-0000-0000-0000-000000000001';
-- venda R$ 79,80: 30 no PIX + 49,80 na conta
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2,"unit_price":39.9}]',
  '[{"method":"pix","amount":30},{"method":"conta","amount":49.8}]', 0, null, null, null, 'cccccccc-0000-0000-0000-000000000001')->>'id' as venda \gset
select balance from shop_customer_balances where customer_id='cccccccc-0000-0000-0000-000000000001';
-- conta sem cliente: bloqueia
do $$ begin perform shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"conta","amount":39.9}]');
  raise exception 'devia falhar'; exception when others then raise notice 'sem cliente: %', sqlerrm; end $$;
-- chamada antiga (6 parâmetros, sem cliente) continua funcionando
select (shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"dinheiro","amount":39.9}]', 0, null, null, null)->>'total')::numeric as venda_dinheiro;
-- cliente paga 20 em dinheiro
select shop_customer_payment('cccccccc-0000-0000-0000-000000000001', 20, 'dinheiro', 'parcial') is not null as pagou;
select balance from shop_customer_balances where customer_id='cccccccc-0000-0000-0000-000000000001';
-- caixa: dinheiro esperado = 50 troco + 39,90 venda + 20 recebido = 109,90; conta não aparece no esperado
select s->'expected' as esperado, s->'receipts' as recebido, s->'on_account' as na_conta from shop_cash_summary(:'caixa') s;
-- vendedor estoura limite (deve 29,80; limite 100; nova compra de 79,80 na conta)
select set_config('test.uid','22222222-2222-2222-2222-222222222222',false);
do $$ begin perform shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2,"unit_price":39.9}]','[{"method":"conta","amount":79.8}]',0,null,null,null,'cccccccc-0000-0000-0000-000000000001');
  raise exception 'devia falhar'; exception when others then raise notice 'limite: %', sqlerrm; end $$;
do $$ begin perform shop_customer_adjust('cccccccc-0000-0000-0000-000000000001','ajuste_credito',10,'x');
  raise exception 'devia falhar'; exception when others then raise notice 'vendedor ajuste: %', sqlerrm; end $$;
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
-- cancelar a venda fiada: estorna o débito (saldo vira -20, crédito do cliente)
select shop_cancel_sale(:'venda', 'teste');
select kind, amount from shop_customer_entries where customer_id='cccccccc-0000-0000-0000-000000000001' order by created_at;
select balance from shop_customer_balances where customer_id='cccccccc-0000-0000-0000-000000000001';
select shop_customer_adjust('cccccccc-0000-0000-0000-000000000001','ajuste_debito',20,'acerto do troco') is not null as ajuste;
select balance as saldo_final from shop_customer_balances where customer_id='cccccccc-0000-0000-0000-000000000001';
