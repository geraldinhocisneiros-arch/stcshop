-- =====================================================================
-- Fornecedores + edição/exclusão de notas fiscais de entrada
--
-- Editar uma nota = desfazer a entrada antiga (estoque e custo médio) e
-- lançar a nova, tudo na mesma transação. Vendas feitas antes da edição
-- mantêm o custo que tinham na hora da venda.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fornecedores
-- ---------------------------------------------------------------------
create table public.shop_suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,                 -- razão social (como vem na nota)
  trade_name text,                    -- nome fantasia / como você chama
  cnpj text,                          -- só números
  contact_name text,
  phone text,
  email text,
  city text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index shop_suppliers_cnpj_uq on public.shop_suppliers (cnpj) where cnpj is not null and cnpj <> '';

alter table public.shop_suppliers enable row level security;
create policy "membros leem" on public.shop_suppliers for select using (public.shop_is_member());
create policy "admin escreve" on public.shop_suppliers for all using (public.shop_is_admin()) with check (public.shop_is_admin());

alter table public.shop_invoices add column supplier_id uuid references public.shop_suppliers(id);
create index shop_invoices_supplier_idx on public.shop_invoices (supplier_id);

-- Detalhes do item, para a edição recalcular o custo exatamente como na entrada
alter table public.shop_invoice_items
  add column unit text,
  add column ncm text,
  add column item_discount numeric(12,2),
  add column item_freight numeric(12,2),
  add column item_other numeric(12,2),
  add column item_ipi numeric(12,2),
  add column item_icms_st numeric(12,2);

-- Novo tipo de movimentação: estorno de nota (edição ou exclusão)
alter table public.shop_stock_movements drop constraint shop_stock_movements_kind_check;
alter table public.shop_stock_movements add constraint shop_stock_movements_kind_check
  check (kind in ('entrada_nf', 'estorno_nf', 'entrada_manual', 'venda', 'cancelamento_venda', 'ajuste', 'perda'));

-- Fornecedores a partir das notas já importadas
insert into public.shop_suppliers (name, cnpj)
select distinct on (supplier_cnpj) coalesce(nullif(trim(supplier_name), ''), 'Fornecedor ' || supplier_cnpj), supplier_cnpj
from public.shop_invoices
where coalesce(supplier_cnpj, '') <> ''
order by supplier_cnpj, created_at desc;

update public.shop_invoices i set supplier_id = s.id
from public.shop_suppliers s
where s.cnpj = i.supplier_cnpj and i.supplier_id is null;

-- ---------------------------------------------------------------------
-- Funções internas (não chamadas direto pelo app)
-- ---------------------------------------------------------------------

-- Acha o fornecedor pelo id ou CNPJ; se a nota trouxe CNPJ novo, cadastra.
create or replace function public.shop__resolve_supplier(p_header jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := nullif(p_header->>'supplier_id', '')::uuid;
  v_cnpj text := nullif(regexp_replace(coalesce(p_header->>'supplier_cnpj', ''), '\D', '', 'g'), '');
  v_name text := nullif(trim(p_header->>'supplier_name'), '');
begin
  if v_id is not null then return v_id; end if;
  if v_cnpj is null then return null; end if;
  select id into v_id from shop_suppliers where cnpj = v_cnpj;
  if v_id is null then
    insert into shop_suppliers (name, cnpj) values (coalesce(v_name, 'Fornecedor ' || v_cnpj), v_cnpj)
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- Lança os itens de uma nota: estoque, custo médio, histórico e vínculos.
create or replace function public.shop__apply_invoice_items(p_inv uuid, p_header jsonb, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb; v_prod shop_products;
  v_stock_qty numeric; v_unit_cost numeric; v_new_qty numeric; v_new_cost numeric;
  v_cnpj text := regexp_replace(coalesce(p_header->>'supplier_cnpj', ''), '\D', '', 'g');
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Nota sem itens'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from shop_products where id = (v_item->>'product_id')::uuid for update;
    if v_prod.id is null then raise exception 'Produto não encontrado para "%"', v_item->>'nf_name'; end if;
    if v_prod.kind <> 'produto' then raise exception '"%" é serviço e não pode receber estoque', v_prod.name; end if;
    if coalesce((v_item->>'nf_qty')::numeric, 0) <= 0 then raise exception 'Quantidade inválida em "%"', v_prod.name; end if;

    v_stock_qty := (v_item->>'nf_qty')::numeric * v_prod.nf_unit_factor;
    v_unit_cost := (v_item->>'unit_cost_nf')::numeric / v_prod.nf_unit_factor;
    v_new_qty := v_prod.stock_qty + v_stock_qty;
    v_new_cost := case when v_prod.stock_qty > 0 and v_new_qty > 0
      then (v_prod.stock_qty * v_prod.cost_price + v_stock_qty * v_unit_cost) / v_new_qty
      else v_unit_cost end;

    update shop_products set
      stock_qty = v_new_qty, cost_price = round(v_new_cost, 4), last_cost = round(v_unit_cost, 4),
      nf_name = coalesce(nf_name, nullif(v_item->>'nf_name', '')),
      barcode = coalesce(nullif(barcode, ''), nullif(v_item->>'ean', ''))
    where id = v_prod.id;

    insert into shop_invoice_items (invoice_id, product_id, nf_name, supplier_code, ean, nf_qty, nf_unit_price, stock_qty, unit_cost,
      unit, ncm, item_discount, item_freight, item_other, item_ipi, item_icms_st)
    values (p_inv, v_prod.id, coalesce(nullif(v_item->>'nf_name', ''), v_prod.name), v_item->>'supplier_code', v_item->>'ean',
      (v_item->>'nf_qty')::numeric, (v_item->>'nf_unit_price')::numeric, v_stock_qty, round(v_unit_cost, 4),
      v_item->>'unit', v_item->>'ncm',
      nullif(v_item->>'discount', '')::numeric, nullif(v_item->>'freight', '')::numeric, nullif(v_item->>'other', '')::numeric,
      nullif(v_item->>'ipi', '')::numeric, nullif(v_item->>'icms_st', '')::numeric);

    insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, invoice_id, notes, created_by)
    values (v_prod.id, 'entrada_nf', v_stock_qty, v_new_qty, round(v_unit_cost, 4), p_inv,
      'NF ' || coalesce(p_header->>'number', '') || ' — ' || coalesce(p_header->>'supplier_name', ''), auth.uid());

    if coalesce((v_item->>'remember')::boolean, true) and public.shop_norm(v_item->>'nf_name') is not null then
      insert into shop_product_nf_links (product_id, nf_name_norm, supplier_cnpj, supplier_code)
      values (v_prod.id, public.shop_norm(v_item->>'nf_name'), v_cnpj, v_item->>'supplier_code')
      on conflict (nf_name_norm, supplier_cnpj) do update set product_id = excluded.product_id, supplier_code = excluded.supplier_code;
    end if;
  end loop;
end $$;

-- Desfaz os itens de uma nota: tira do estoque e retira a contribuição
-- dela do custo médio. Se o produto zerar, mantém o último custo médio.
create or replace function public.shop__reverse_invoice_items(p_inv uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_it shop_invoice_items; v_prod shop_products; v_new_qty numeric; v_new_cost numeric; v_number text;
begin
  select number into v_number from shop_invoices where id = p_inv;
  for v_it in select * from shop_invoice_items where invoice_id = p_inv loop
    select * into v_prod from shop_products where id = v_it.product_id for update;
    v_new_qty := v_prod.stock_qty - v_it.stock_qty;
    v_new_cost := case when v_new_qty > 0
      then greatest(0, (v_prod.stock_qty * v_prod.cost_price - v_it.stock_qty * v_it.unit_cost) / v_new_qty)
      else v_prod.cost_price end;
    update shop_products set stock_qty = v_new_qty, cost_price = round(v_new_cost, 4) where id = v_prod.id;
    insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, invoice_id, notes, created_by)
    values (v_prod.id, 'estorno_nf', -v_it.stock_qty, v_new_qty, v_it.unit_cost, p_inv,
      p_reason || ' — NF ' || coalesce(v_number, ''), auth.uid());
  end loop;
  delete from shop_invoice_items where invoice_id = p_inv;
end $$;

revoke execute on function public.shop__resolve_supplier(jsonb) from public, anon, authenticated;
revoke execute on function public.shop__apply_invoice_items(uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.shop__reverse_invoice_items(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Funções chamadas pelo app
-- ---------------------------------------------------------------------

-- Importar (mesma assinatura de antes; agora com fornecedor e detalhes do item)
create or replace function public.shop_import_invoice(p_header jsonb, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_inv uuid;
  v_cnpj text := regexp_replace(coalesce(p_header->>'supplier_cnpj', ''), '\D', '', 'g');
  v_key text := regexp_replace(coalesce(p_header->>'access_key', ''), '\D', '', 'g');
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador importa notas'; end if;
  if v_key <> '' and exists (select 1 from shop_invoices where access_key = v_key) then
    raise exception 'Esta nota (chave %) já foi importada', v_key;
  end if;

  insert into shop_invoices (access_key, number, series, supplier_id, supplier_name, supplier_cnpj, issue_date,
    total_products, freight, discount, other_costs, ipi, icms_st, total, source, created_by)
  values (nullif(v_key, ''), p_header->>'number', p_header->>'series', public.shop__resolve_supplier(p_header),
    p_header->>'supplier_name', nullif(v_cnpj, ''), nullif(p_header->>'issue_date', '')::date,
    nullif(p_header->>'total_products', '')::numeric, coalesce(nullif(p_header->>'freight', '')::numeric, 0),
    coalesce(nullif(p_header->>'discount', '')::numeric, 0), coalesce(nullif(p_header->>'other_costs', '')::numeric, 0),
    coalesce(nullif(p_header->>'ipi', '')::numeric, 0), coalesce(nullif(p_header->>'icms_st', '')::numeric, 0),
    nullif(p_header->>'total', '')::numeric, coalesce(p_header->>'source', 'pdf'), auth.uid())
  returning id into v_inv;

  perform public.shop__apply_invoice_items(v_inv, p_header, p_items);
  return v_inv;
end $$;

-- Editar: desfaz a entrada antiga e lança a nova (cabeçalho e itens)
create or replace function public.shop_update_invoice(p_invoice_id uuid, p_header jsonb, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cnpj text := regexp_replace(coalesce(p_header->>'supplier_cnpj', ''), '\D', '', 'g');
  v_key text := regexp_replace(coalesce(p_header->>'access_key', ''), '\D', '', 'g');
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador edita notas'; end if;
  perform 1 from shop_invoices where id = p_invoice_id for update;
  if not found then raise exception 'Nota não encontrada'; end if;
  if v_key <> '' and exists (select 1 from shop_invoices where access_key = v_key and id <> p_invoice_id) then
    raise exception 'Já existe outra nota com a chave %', v_key;
  end if;

  perform public.shop__reverse_invoice_items(p_invoice_id, 'Edição da nota');

  update shop_invoices set
    access_key = nullif(v_key, ''), number = p_header->>'number', series = p_header->>'series',
    supplier_id = public.shop__resolve_supplier(p_header),
    supplier_name = p_header->>'supplier_name', supplier_cnpj = nullif(v_cnpj, ''),
    issue_date = nullif(p_header->>'issue_date', '')::date,
    total_products = nullif(p_header->>'total_products', '')::numeric,
    freight = coalesce(nullif(p_header->>'freight', '')::numeric, 0),
    discount = coalesce(nullif(p_header->>'discount', '')::numeric, 0),
    other_costs = coalesce(nullif(p_header->>'other_costs', '')::numeric, 0),
    ipi = coalesce(nullif(p_header->>'ipi', '')::numeric, 0),
    icms_st = coalesce(nullif(p_header->>'icms_st', '')::numeric, 0),
    total = nullif(p_header->>'total', '')::numeric
  where id = p_invoice_id;

  perform public.shop__apply_invoice_items(p_invoice_id, p_header, p_items);
end $$;

-- Excluir: desfaz a entrada no estoque e apaga a nota (o histórico do estoque fica)
create or replace function public.shop_delete_invoice(p_invoice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador exclui notas'; end if;
  perform 1 from shop_invoices where id = p_invoice_id for update;
  if not found then raise exception 'Nota não encontrada'; end if;
  perform public.shop__reverse_invoice_items(p_invoice_id, 'Exclusão da nota');
  update shop_stock_movements set invoice_id = null where invoice_id = p_invoice_id;
  delete from shop_invoices where id = p_invoice_id;
end $$;
