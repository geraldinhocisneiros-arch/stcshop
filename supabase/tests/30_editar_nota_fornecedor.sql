-- Rode depois de 00, das migrations e de 10_fluxo_admin.sql
\set ON_ERROR_STOP 1
select set_config('test.uid','11111111-1111-1111-1111-111111111111',false);
insert into shop_products (id,name,sale_price) values ('bbbbbbbb-0000-0000-0000-000000000001','Overgrip',20);
-- produto começa com 10 a R$ 5
select shop_adjust_stock('bbbbbbbb-0000-0000-0000-000000000001','entrada_manual',10,5,'inicial');
-- nota nova de fornecedor ainda não cadastrado: cria o fornecedor
select shop_import_invoice('{"number":"900","supplier_name":"Grip Brasil LTDA","supplier_cnpj":"99.888.777/0001-66","source":"manual"}',
  '[{"product_id":"bbbbbbbb-0000-0000-0000-000000000001","nf_name":"OVERGRIP X","nf_qty":10,"nf_unit_price":8,"unit_cost_nf":8,"ipi":1.5}]') as inv \gset
select 'depois da nota' as etapa, stock_qty, cost_price from shop_products where id='bbbbbbbb-0000-0000-0000-000000000001';
select name, cnpj from shop_suppliers where cnpj='99888777000166';
select item_ipi from shop_invoice_items where invoice_id = :'inv';
-- edição inválida (qtd 0) não pode mexer em nada
do $$ begin perform shop_update_invoice((select id from shop_invoices where number='900'), '{"number":"900"}',
  '[{"product_id":"bbbbbbbb-0000-0000-0000-000000000001","nf_name":"OVERGRIP X","nf_qty":0,"nf_unit_price":8,"unit_cost_nf":8}]');
  raise exception 'devia falhar'; exception when others then raise notice 'edição inválida bloqueada: %', sqlerrm; end $$;
select 'após edição inválida' as etapa, stock_qty, cost_price from shop_products where id='bbbbbbbb-0000-0000-0000-000000000001';
-- edição: era 10 a 8, na verdade foram 6 a 9
select shop_update_invoice(:'inv', '{"number":"900","supplier_name":"Grip Brasil LTDA","supplier_cnpj":"99888777000166"}',
  '[{"product_id":"bbbbbbbb-0000-0000-0000-000000000001","nf_name":"OVERGRIP X","nf_qty":6,"nf_unit_price":9,"unit_cost_nf":9}]');
select 'depois da edição' as etapa, stock_qty, cost_price from shop_products where id='bbbbbbbb-0000-0000-0000-000000000001';
select count(*) as fornecedores_com_esse_cnpj from shop_suppliers where cnpj='99888777000166';
-- excluir: volta ao estado inicial (10 a R$ 5)
select shop_delete_invoice(:'inv');
select 'depois de excluir' as etapa, stock_qty, cost_price from shop_products where id='bbbbbbbb-0000-0000-0000-000000000001';
select kind, qty, balance_after from shop_stock_movements where product_id='bbbbbbbb-0000-0000-0000-000000000001' order by created_at;
-- vendedor não edita
select set_config('test.uid','22222222-2222-2222-2222-222222222222',false);
do $$ begin perform shop_delete_invoice(gen_random_uuid()); exception when others then raise notice 'vendedor: %', sqlerrm; end $$;
