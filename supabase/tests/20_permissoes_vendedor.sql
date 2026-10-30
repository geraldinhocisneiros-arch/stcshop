\set ON_ERROR_STOP 0
insert into auth.users values ('22222222-2222-2222-2222-222222222222','v@v');
insert into shop_user_roles values ('22222222-2222-2222-2222-222222222222','Vendedor','vendedor');
select shop_open_cash(0);
select set_config('test.uid','22222222-2222-2222-2222-222222222222',false);
select shop_open_cash(0) is not null as seller_opened;
-- preço alterado: deve falhar
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":10}]','[{"method":"pix","amount":10}]');
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
