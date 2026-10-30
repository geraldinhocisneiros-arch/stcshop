\set ON_ERROR_STOP 1
insert into auth.users values ('11111111-1111-1111-1111-111111111111','a@a');
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
select shop_claim_first_admin('Geraldinho') as admin_claimed;
select shop_claim_first_admin('Outro') as second_claim;
insert into shop_products (id,name,nf_name,sale_price,nf_unit_factor) values
 ('aaaaaaaa-0000-0000-0000-000000000001','Bola Wilson US Open','BOLA TENIS WILSON US OPEN TB C/3',39.90,1),
 ('aaaaaaaa-0000-0000-0000-000000000002','Corda Babolat RPM set do rolo','CORDA BABOLAT RPM BLAST 200M',45,16);
insert into shop_products (id,kind,name,sale_price) values ('aaaaaaaa-0000-0000-0000-000000000003','servico','Encordoamento',40);
-- nota 1: 10 tubos a 20, 1 rolo a 800
select shop_import_invoice('{"access_key":"3526 1012","number":"123","supplier_name":"Dist X","supplier_cnpj":"12.345.678/0001-99","source":"xml"}',
 '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","nf_name":"BOLA TENIS WILSON US OPEN TB C/3","nf_qty":10,"nf_unit_price":20,"unit_cost_nf":20},
   {"product_id":"aaaaaaaa-0000-0000-0000-000000000002","nf_name":"CORDA BABOLAT RPM BLAST 200M","nf_qty":1,"nf_unit_price":800,"unit_cost_nf":800}]') is not null as inv1;
-- duplicate must fail
do $$ begin perform shop_import_invoice('{"access_key":"35261012"}','[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","nf_name":"x","nf_qty":1,"nf_unit_price":1,"unit_cost_nf":1}]'); raise exception 'should fail';
exception when others then raise notice 'dup blocked: %', sqlerrm; end $$;
-- nota 2: 10 tubos a 26 -> médio 23
select shop_import_invoice('{"number":"124","supplier_cnpj":"12345678000199"}','[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","nf_name":"Bola  Tênis Wilson US Open TB C/3","nf_qty":10,"nf_unit_price":26,"unit_cost_nf":26}]') is not null as inv2;
select name, stock_qty, cost_price, last_cost from shop_products order by name;
select nf_name_norm, supplier_cnpj from shop_product_nf_links;
-- venda sem caixa deve falhar
do $$ begin perform shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"pix","amount":39.9}]'); raise exception 'should fail';
exception when others then raise notice 'no cash: %', sqlerrm; end $$;
select shop_open_cash(100) is not null as opened;
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2,"unit_price":39.9},{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","qty":1,"unit_price":45},{"product_id":"aaaaaaaa-0000-0000-0000-000000000003","qty":1,"unit_price":40}]',
  '[{"method":"credito","amount":100},{"method":"dinheiro","amount":59.8}]', 5, 'João') as sale1;
select number, subtotal, discount, total, cost_total, fee_total from shop_sales;
select description, qty, total, discount, unit_cost from shop_sale_items order by description;
-- estoque insuficiente
do $$ begin perform shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":99,"unit_price":39.9}]','[{"method":"pix","amount":3950.1}]'); raise exception 'should fail';
exception when others then raise notice 'stock: %', sqlerrm; end $$;
-- pagamento errado
do $$ begin perform shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"pix","amount":30}]'); raise exception 'should fail';
exception when others then raise notice 'payment: %', sqlerrm; end $$;
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"pix","amount":39.9}]')->>'number' as sale2;
select shop_cancel_sale((select id from shop_sales order by number desc limit 1),'cliente desistiu');
select shop_cash_movement('sangria', 50, 'depósito');
select name, stock_qty from shop_products where kind='produto' order by name;
select kind, qty, balance_after from shop_stock_movements order by created_at, kind;
select jsonb_pretty(shop_close_cash((select id from shop_cash_sessions where status='aberto'), '{"dinheiro":109.8,"credito":100}', 'ok') - 'session');
select product_name, qty, total, cost_total, fee_share from shop_sale_lines order by product_name;
select shop_adjust_stock('aaaaaaaa-0000-0000-0000-000000000001','ajuste',15,null,'inventário');
select shop_adjust_stock('aaaaaaaa-0000-0000-0000-000000000001','entrada_manual',5,30,'compra balcão');
select stock_qty, cost_price from shop_products where id='aaaaaaaa-0000-0000-0000-000000000001';
