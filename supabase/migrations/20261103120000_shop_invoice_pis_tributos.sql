-- PIS e valor aproximado dos tributos na nota de entrada.
-- São informativos: já estão embutidos no preço do fornecedor, então NÃO
-- entram no custo do produto (o custo soma frete, IPI, ICMS-ST e outras
-- despesas, menos desconto).

alter table public.shop_invoices
  add column pis numeric(12,2) not null default 0,
  add column approx_taxes numeric(12,2) not null default 0;

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
    total_products, freight, discount, other_costs, ipi, icms_st, pis, approx_taxes, total, source, created_by)
  values (nullif(v_key, ''), p_header->>'number', p_header->>'series', public.shop__resolve_supplier(p_header),
    p_header->>'supplier_name', nullif(v_cnpj, ''), nullif(p_header->>'issue_date', '')::date,
    nullif(p_header->>'total_products', '')::numeric, coalesce(nullif(p_header->>'freight', '')::numeric, 0),
    coalesce(nullif(p_header->>'discount', '')::numeric, 0), coalesce(nullif(p_header->>'other_costs', '')::numeric, 0),
    coalesce(nullif(p_header->>'ipi', '')::numeric, 0), coalesce(nullif(p_header->>'icms_st', '')::numeric, 0),
    coalesce(nullif(p_header->>'pis', '')::numeric, 0), coalesce(nullif(p_header->>'approx_taxes', '')::numeric, 0),
    nullif(p_header->>'total', '')::numeric, coalesce(p_header->>'source', 'pdf'), auth.uid())
  returning id into v_inv;

  perform public.shop__apply_invoice_items(v_inv, p_header, p_items);
  return v_inv;
end $$;

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
    pis = coalesce(nullif(p_header->>'pis', '')::numeric, 0),
    approx_taxes = coalesce(nullif(p_header->>'approx_taxes', '')::numeric, 0),
    total = nullif(p_header->>'total', '')::numeric
  where id = p_invoice_id;

  perform public.shop__apply_invoice_items(p_invoice_id, p_header, p_items);
end $$;

