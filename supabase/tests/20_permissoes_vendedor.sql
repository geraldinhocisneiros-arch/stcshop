\set ON_ERROR_STOP 0
insert into auth.users values ('22222222-2222-2222-2222-222222222222','v@v');
insert into shop_user_roles values ('22222222-2222-2222-2222-222222222222','Vendedor','vendedor');
select shop_open_cash(0);
select set_config('test.uid','22222222-2222-2222-2222-222222222222',false);
select shop_open_cash(0) is not null as seller_opened;
-- preço alterado no caixa: vendedor pode (vale só para esta venda)
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":10}]','[{"method":"pix","amount":10}]')->>'total' as preco_caixa_ok;
select list_price, unit_price from shop_sale_lines where unit_price = 10 order by created_at desc limit 1;
select sale_price = 39.9 as cadastro_intacto from shop_products where id='aaaaaaaa-0000-0000-0000-000000000001';
-- preço negativo: deve falhar
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":-1}]','[{"method":"pix","amount":0}]');
-- vendedor altera o preço do cadastro pela função e fica registrado
select shop_set_sale_price('aaaaaaaa-0000-0000-0000-000000000001', 42.5);
select sale_price from shop_products where id='aaaaaaaa-0000-0000-0000-000000000001';
select old_price, new_price, changed_by_name from shop_price_changes order by changed_at desc limit 1;
select shop_set_sale_price('aaaaaaaa-0000-0000-0000-000000000001', 39.9);
-- desconto 20%: deve falhar
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"pix","amount":31.92}]', 7.98);
-- desconto 10%: ok
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"pix","amount":35.91}]', 3.99)->>'total' as ok_10pct;
-- promo vigente: ok
update shop_products set promo_price=29.9, promo_until=current_date+5 where id='aaaaaaaa-0000-0000-0000-000000000001';
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":29.9}]','[{"method":"pix","amount":29.9}]')->>'total' as promo_ok;
-- vendedor não ajusta estoque nem importa nota
select shop_adjust_stock('aaaaaaaa-0000-0000-0000-000000000001','ajuste',100);
-- vendedor não pode cancelar venda de caixa fechado
select shop_cancel_sale((select id from shop_sales where number=1),'x');
-- não-membro
select set_config('test.uid','33333333-3333-3333-3333-333333333333',false);
select shop_finalize_sale('[]','[]');
