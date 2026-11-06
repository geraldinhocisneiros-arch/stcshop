-- Rode depois de todas as migrations e dos testes 10/20/30/40
\set ON_ERROR_STOP 1
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
update shop_cash_sessions set status='fechado', closed_at=now() where status='aberto';
select shop_open_cash(0) as caixa \gset
update shop_products set promo_price=null, promo_until=null, stock_qty=20 where id in ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000002');
update shop_settings set allow_negative_stock=false where id=1;

-- venda original: 2 bolas no dinheiro (79,80)
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":2,"unit_price":39.9}]',
  '[{"method":"dinheiro","amount":79.8}]')->>'id' as venda \gset
select number as numero_original from shop_sales where id = :'venda' \gset

-- edição: 3 bolas + 1 corda, 10 de desconto, metade PIX metade fiado da Maria
select shop_edit_sale(:'venda',
  '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":3,"unit_price":39.9},{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","qty":1,"unit_price":45}]',
  '[{"method":"pix","amount":80},{"method":"conta","amount":74.7}]', 10, 'cccccccc-0000-0000-0000-000000000001', null, 'cliente levou mais') ->> 'total' as total_editado;
select number = :numero_original as mesmo_numero, total, discount, customer_name, edit_count from shop_sales where id = :'venda';
select stock_qty from shop_products where id='aaaaaaaa-0000-0000-0000-000000000001';  -- 20 - 2 - 1 = 17
select stock_qty from shop_products where id='aaaaaaaa-0000-0000-0000-000000000002';  -- 19
select kind, qty from shop_stock_movements where sale_id = :'venda' order by created_at, kind;
select method, amount from shop_sale_payments where sale_id = :'venda' order by method;
select kind, amount from shop_customer_entries where sale_id = :'venda' order by created_at;  -- débito 74,70

-- segunda edição: reduz o fiado para 30 (estorna 44,70)
select shop_edit_sale(:'venda',
  '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":3,"unit_price":39.9},{"product_id":"aaaaaaaa-0000-0000-0000-000000000002","qty":1,"unit_price":45}]',
  '[{"method":"pix","amount":124.7},{"method":"conta","amount":30}]', 10, 'cccccccc-0000-0000-0000-000000000001', null, 'pagou mais no pix') is not null as edit2;
select coalesce(sum(case when kind='debito' then amount else -amount end),0) as fiado_da_venda
from shop_customer_entries where sale_id = :'venda';  -- 30

-- vendedor: não pode mudar preço nem passar desconto
select set_config('test.uid','22222222-2222-2222-2222-222222222222',false);
do $$ begin perform shop_edit_sale((select id from shop_sales where edit_count = 2 limit 1),
  '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":10}]','[{"method":"pix","amount":10}]', 0, null, null, 'x');
  raise exception 'devia falhar'; exception when others then raise notice 'vendedor preço: %', sqlerrm; end $$;
-- sem motivo: bloqueia
do $$ begin perform shop_edit_sale((select id from shop_sales where edit_count = 2 limit 1),
  '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]','[{"method":"pix","amount":39.9}]', 0, null, null, ' ');
  raise exception 'devia falhar'; exception when others then raise notice 'sem motivo: %', sqlerrm; end $$;
-- vendedor: tira a corda e troca para tudo no PIX, sem cliente (estorna o fiado inteiro)
select shop_edit_sale(:'venda',
  '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":3,"unit_price":39.9}]',
  '[{"method":"pix","amount":119.7}]', 0, null, null, 'devolveu a corda') ->> 'total' as total_vendedor;
select stock_qty from shop_products where id='aaaaaaaa-0000-0000-0000-000000000002';  -- volta a 20
select coalesce(sum(case when kind='debito' then amount else -amount end),0) as fiado_zerado
from shop_customer_entries where sale_id = :'venda';
-- estoque insuficiente na edição
do $$ begin perform shop_edit_sale((select id from shop_sales where edit_count = 3 limit 1),
  '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":99,"unit_price":39.9}]','[{"method":"pix","amount":3950.1}]', 0, null, null, 'x');
  raise exception 'devia falhar'; exception when others then raise notice 'estoque: %', sqlerrm; end $$;

-- caixa fechado: vendedor não edita
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
update shop_cash_sessions set status='fechado', closed_at=now() where id = :'caixa';
select set_config('test.uid','22222222-2222-2222-2222-222222222222',false);
do $$ begin perform shop_edit_sale((select id from shop_sales where edit_count = 3 limit 1),
  '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":3,"unit_price":39.9}]','[{"method":"dinheiro","amount":119.7}]', 0, null, null, 'x');
  raise exception 'devia falhar'; exception when others then raise notice 'caixa fechado: %', sqlerrm; end $$;

-- histórico
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
select count(*) as edicoes, (array_agg(before->>'total' order by edited_at))[1] as total_antes_da_1a_edicao from shop_sale_edits where sale_id = :'venda';

-- cancelar depois de editar com fiado: estorna só o saldo (não estorna duas vezes)
select shop_open_cash(0) is not null as reabriu;
select shop_finalize_sale('[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]',
  '[{"method":"conta","amount":39.9}]', 0, null, null, null, 'cccccccc-0000-0000-0000-000000000001')->>'id' as venda2 \gset
select shop_edit_sale(:'venda2', '[{"product_id":"aaaaaaaa-0000-0000-0000-000000000001","qty":1,"unit_price":39.9}]',
  '[{"method":"dinheiro","amount":19.9},{"method":"conta","amount":20}]', 0, 'cccccccc-0000-0000-0000-000000000001', null, 'deu 19,90') is not null as edit_v2;
select shop_cancel_sale(:'venda2', 'desistiu');
select kind, amount from shop_customer_entries where sale_id = :'venda2' order by created_at;
select coalesce(sum(case when kind='debito' then amount else -amount end),0) as saldo_venda2_zero
from shop_customer_entries where sale_id = :'venda2';
