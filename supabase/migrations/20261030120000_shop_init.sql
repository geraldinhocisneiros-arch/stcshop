-- =====================================================================
-- Squash Tennis Shop — schema inicial
--
-- Todas as tabelas usam o prefixo shop_ para que o sistema possa rodar
-- num projeto Supabase próprio OU no mesmo projeto do squashtenniscenter
-- (aproveitando os logins já existentes) sem colidir com nada.
--
-- Regras de negócio que mexem em estoque e caixa ficam em funções SQL
-- (RPC) transacionais: venda, cancelamento, entrada de nota, ajuste e
-- fechamento de caixa. Assim o estoque nunca fica pela metade se a
-- internet cair no meio de uma venda.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Usuários e papéis
-- ---------------------------------------------------------------------
create table public.shop_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null check (role in ('admin', 'vendedor')),
  created_at timestamptz not null default now()
);

create or replace function public.shop_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.shop_user_roles where user_id = auth.uid()
$$;

create or replace function public.shop_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shop_user_roles where user_id = auth.uid())
$$;

create or replace function public.shop_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shop_user_roles where user_id = auth.uid() and role = 'admin')
$$;

-- O primeiro usuário que entrar no sistema vira admin (só funciona
-- enquanto a tabela estiver vazia).
create or replace function public.shop_claim_first_admin(p_full_name text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Não autenticado';
  end if;
  lock table public.shop_user_roles in exclusive mode;
  if exists (select 1 from public.shop_user_roles) then
    return false;
  end if;
  insert into public.shop_user_roles (user_id, full_name, role)
  values (auth.uid(), coalesce(nullif(trim(p_full_name), ''), 'Administrador'), 'admin');
  return true;
end $$;

create or replace function public.shop_has_any_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.shop_user_roles)
$$;

-- ---------------------------------------------------------------------
-- Configurações gerais (linha única)
-- ---------------------------------------------------------------------
create table public.shop_settings (
  id smallint primary key default 1 check (id = 1),
  target_margin_pct numeric(6,2) not null default 20,   -- lucro líquido desejado (% do preço)
  allow_negative_stock boolean not null default false,
  analysis_days integer not null default 90,            -- janela p/ curva ABC e giro
  lead_time_days integer not null default 15,           -- prazo do fornecedor
  safety_days integer not null default 10,              -- estoque de segurança
  coverage_target_days integer not null default 45,     -- quanto estoque comprar de uma vez
  stale_days integer not null default 60,               -- sem venda há X dias = parado
  max_promo_discount_pct numeric(6,2) not null default 30,
  max_seller_discount_pct numeric(6,2) not null default 10, -- desconto máximo que o vendedor pode dar na venda
  expected_monthly_revenue numeric(12,2) not null default 0, -- usado p/ ratear custo fixo enquanto não há histórico
  updated_at timestamptz not null default now()
);
insert into public.shop_settings (id) values (1);

-- Taxas por forma de pagamento (maquininha, etc.)
create table public.shop_payment_methods (
  code text primary key,
  label text not null,
  fee_pct numeric(6,3) not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true
);
insert into public.shop_payment_methods (code, label, fee_pct, sort_order) values
  ('dinheiro', 'Dinheiro', 0, 1),
  ('pix', 'PIX', 0, 2),
  ('debito', 'Cartão de débito', 1.5, 3),
  ('credito', 'Cartão de crédito', 3.2, 4),
  ('credito_parcelado', 'Crédito parcelado', 5.5, 5);

-- ---------------------------------------------------------------------
-- Custos da empresa
--   fixo        -> valor em R$ por mês (aluguel, salário, sistema...)
--   percentual  -> % sobre cada venda (imposto do Simples, comissão...)
-- ---------------------------------------------------------------------
create table public.shop_costs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'Outros',
  kind text not null check (kind in ('fixo', 'percentual')),
  amount numeric(12,2) not null check (amount >= 0),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Produtos e serviços
-- ---------------------------------------------------------------------
create table public.shop_products (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'produto' check (kind in ('produto', 'servico')),
  name text not null,                     -- "apelido": como você procura no caixa
  nf_name text,                           -- descrição exatamente como vem na nota
  code text,                              -- código interno / do fornecedor
  barcode text,                           -- EAN
  category text,
  brand text,
  unit text not null default 'UN',
  nf_unit_factor numeric(12,3) not null default 1 check (nf_unit_factor > 0), -- 1 un. da nota = X un. no estoque
  sale_price numeric(12,2) not null default 0 check (sale_price >= 0),
  promo_price numeric(12,2) check (promo_price >= 0),     -- preço promocional (vale até promo_until)
  promo_until date,
  cost_price numeric(12,4) not null default 0,   -- custo médio ponderado
  last_cost numeric(12,4),
  stock_qty numeric(12,3) not null default 0,
  min_stock numeric(12,3) not null default 0,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index shop_products_barcode_uq on public.shop_products (barcode) where barcode is not null and barcode <> '';
create index shop_products_name_idx on public.shop_products (lower(name));

-- Normaliza descrições para comparar nome da nota x cadastro
-- (sem acento, maiúsculo, espaços únicos).
create or replace function public.shop_norm(p text)
returns text language sql immutable as $$
  select nullif(regexp_replace(upper(trim(extensions.unaccent(coalesce(p, '')))), '\s+', ' ', 'g'), '')
$$;

-- Vínculos aprendidos "descrição da nota -> produto". Cada vez que você
-- liga um item de nota a um produto, o sistema lembra para a próxima.
create table public.shop_product_nf_links (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  nf_name_norm text not null,
  supplier_cnpj text not null default '',
  supplier_code text,
  created_at timestamptz not null default now(),
  unique (nf_name_norm, supplier_cnpj)
);

-- ---------------------------------------------------------------------
-- Caixa
-- ---------------------------------------------------------------------
create table public.shop_cash_sessions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'aberto' check (status in ('aberto', 'fechado')),
  opened_at timestamptz not null default now(),
  opened_by uuid references auth.users(id),
  opening_amount numeric(12,2) not null default 0,
  closed_at timestamptz,
  closed_by uuid references auth.users(id),
  expected jsonb,          -- {metodo: valor esperado}
  counted jsonb,           -- {metodo: valor contado}
  summary jsonb,           -- totais congelados no fechamento
  notes text
);
create unique index shop_one_open_cash on public.shop_cash_sessions ((true)) where status = 'aberto';

create table public.shop_cash_movements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.shop_cash_sessions(id),
  kind text not null check (kind in ('sangria', 'suprimento')),
  amount numeric(12,2) not null check (amount > 0),
  reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Vendas
-- ---------------------------------------------------------------------
create table public.shop_sales (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity,
  session_id uuid not null references public.shop_cash_sessions(id),
  customer_name text,
  subtotal numeric(12,2) not null,
  discount numeric(12,2) not null default 0,
  total numeric(12,2) not null,
  cost_total numeric(12,2) not null default 0,
  fee_total numeric(12,2) not null default 0,
  status text not null default 'concluida' check (status in ('concluida', 'cancelada')),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  canceled_at timestamptz,
  canceled_by uuid references auth.users(id),
  cancel_reason text
);
create index shop_sales_created_idx on public.shop_sales (created_at desc);
create index shop_sales_session_idx on public.shop_sales (session_id);

create table public.shop_sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.shop_sales(id) on delete cascade,
  product_id uuid not null references public.shop_products(id),
  description text not null,
  qty numeric(12,3) not null check (qty > 0),
  unit_price numeric(12,2) not null,
  discount numeric(12,2) not null default 0,   -- rateio do desconto da venda
  total numeric(12,2) not null,                -- já líquido de desconto
  unit_cost numeric(12,4) not null default 0
);
create index shop_sale_items_product_idx on public.shop_sale_items (product_id);

create table public.shop_sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.shop_sales(id) on delete cascade,
  method text not null references public.shop_payment_methods(code),
  amount numeric(12,2) not null check (amount > 0),
  fee_pct numeric(6,3) not null default 0,
  fee_amount numeric(12,2) not null default 0
);

-- ---------------------------------------------------------------------
-- Notas fiscais de entrada
-- ---------------------------------------------------------------------
create table public.shop_invoices (
  id uuid primary key default gen_random_uuid(),
  access_key text,
  number text,
  series text,
  supplier_name text,
  supplier_cnpj text,
  issue_date date,
  total_products numeric(12,2),
  freight numeric(12,2) default 0,
  discount numeric(12,2) default 0,
  other_costs numeric(12,2) default 0,
  ipi numeric(12,2) default 0,
  icms_st numeric(12,2) default 0,
  total numeric(12,2),
  source text not null default 'pdf' check (source in ('pdf', 'xml', 'manual')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create unique index shop_invoices_key_uq on public.shop_invoices (access_key) where access_key is not null and access_key <> '';

create table public.shop_invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.shop_invoices(id) on delete cascade,
  product_id uuid not null references public.shop_products(id),
  nf_name text not null,
  supplier_code text,
  ean text,
  nf_qty numeric(12,3) not null,
  nf_unit_price numeric(12,4) not null,
  stock_qty numeric(12,3) not null,          -- nf_qty * fator
  unit_cost numeric(12,4) not null           -- custo efetivo por un. de estoque (com frete/IPI/ST/desconto)
);

-- ---------------------------------------------------------------------
-- Movimentações de estoque (histórico completo)
-- ---------------------------------------------------------------------
create table public.shop_stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id),
  kind text not null check (kind in ('entrada_nf', 'entrada_manual', 'venda', 'cancelamento_venda', 'ajuste', 'perda')),
  qty numeric(12,3) not null,          -- com sinal (+ entra, - sai)
  balance_after numeric(12,3) not null,
  unit_cost numeric(12,4),
  sale_id uuid references public.shop_sales(id),
  invoice_id uuid references public.shop_invoices(id),
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index shop_stock_mov_product_idx on public.shop_stock_movements (product_id, created_at desc);

-- ---------------------------------------------------------------------
-- Ordens de encordoamento
-- ---------------------------------------------------------------------
create table public.shop_stringing_orders (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity,
  customer_name text not null,
  customer_phone text,
  racket text,
  service_product_id uuid references public.shop_products(id),  -- o serviço cobrado (mão de obra)
  string_product_id uuid references public.shop_products(id),
  string_description text,            -- quando o cliente traz a própria corda
  tension_main numeric(5,1),
  tension_cross numeric(5,1),
  due_at timestamptz,
  price numeric(12,2),
  status text not null default 'recebida' check (status in ('recebida', 'em_andamento', 'pronta', 'entregue', 'cancelada')),
  notes text,
  sale_id uuid references public.shop_sales(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  delivered_at timestamptz
);

-- ---------------------------------------------------------------------
-- Visão das linhas vendidas (base dos relatórios)
-- ---------------------------------------------------------------------
create view public.shop_sale_lines with (security_invoker = true) as
select
  i.id, i.sale_id, s.number as sale_number, s.created_at, s.session_id,
  i.product_id, p.name as product_name, p.category, p.kind,
  i.qty, i.unit_price, i.discount, i.total, i.unit_cost,
  round(i.qty * i.unit_cost, 2) as cost_total,
  case when s.total > 0 then round(s.fee_total * i.total / s.total, 2) else 0 end as fee_share
from public.shop_sale_items i
join public.shop_sales s on s.id = i.sale_id and s.status = 'concluida'
join public.shop_products p on p.id = i.product_id;

create view public.shop_payment_lines with (security_invoker = true) as
select p.id, p.sale_id, s.created_at, s.session_id, p.method, p.amount, p.fee_amount
from public.shop_sale_payments p
join public.shop_sales s on s.id = p.sale_id and s.status = 'concluida';

create view public.shop_product_last_sale with (security_invoker = true) as
select i.product_id, max(s.created_at) as last_sale_at
from public.shop_sale_items i
join public.shop_sales s on s.id = i.sale_id and s.status = 'concluida'
group by i.product_id;

create view public.shop_monthly_revenue with (security_invoker = true) as
select to_char(created_at at time zone 'America/Recife', 'YYYY-MM') as month,
       sum(total) as total, sum(cost_total) as cost, sum(fee_total) as fees, count(*) as sales
from public.shop_sales where status = 'concluida'
group by 1;

-- =====================================================================
-- Funções de negócio
-- =====================================================================

create or replace function public.shop_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger shop_products_touch before update on public.shop_products
  for each row execute function public.shop_touch_updated_at();

-- Abre o caixa
create or replace function public.shop_open_cash(p_opening_amount numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  if exists (select 1 from shop_cash_sessions where status = 'aberto') then
    raise exception 'Já existe um caixa aberto';
  end if;
  insert into shop_cash_sessions (opened_by, opening_amount)
  values (auth.uid(), coalesce(p_opening_amount, 0)) returning id into v_id;
  return v_id;
end $$;

-- Sangria / suprimento
create or replace function public.shop_cash_movement(p_kind text, p_amount numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_session uuid; v_id uuid;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select id into v_session from shop_cash_sessions where status = 'aberto';
  if v_session is null then raise exception 'Nenhum caixa aberto'; end if;
  insert into shop_cash_movements (session_id, kind, amount, reason, created_by)
  values (v_session, p_kind, p_amount, p_reason, auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- Resumo de um caixa (usado na tela e no fechamento)
create or replace function public.shop_cash_summary(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_s shop_cash_sessions;
  v_by_method jsonb;
  v_sales jsonb;
  v_sangria numeric; v_suprimento numeric;
  v_expected jsonb;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select * into v_s from shop_cash_sessions where id = p_session_id;
  if v_s.id is null then raise exception 'Caixa não encontrado'; end if;

  select coalesce(jsonb_object_agg(method, jsonb_build_object('amount', amount, 'fee', fee, 'count', cnt)), '{}'::jsonb)
    into v_by_method
  from (
    select p.method, sum(p.amount) amount, sum(p.fee_amount) fee, count(distinct p.sale_id) cnt
    from shop_sale_payments p join shop_sales s on s.id = p.sale_id
    where s.session_id = p_session_id and s.status = 'concluida'
    group by p.method
  ) t;

  select jsonb_build_object(
    'count', count(*) filter (where status = 'concluida'),
    'canceled', count(*) filter (where status = 'cancelada'),
    'gross', coalesce(sum(subtotal) filter (where status = 'concluida'), 0),
    'discount', coalesce(sum(discount) filter (where status = 'concluida'), 0),
    'total', coalesce(sum(total) filter (where status = 'concluida'), 0),
    'cost', coalesce(sum(cost_total) filter (where status = 'concluida'), 0),
    'fees', coalesce(sum(fee_total) filter (where status = 'concluida'), 0)
  ) into v_sales
  from shop_sales where session_id = p_session_id;

  select coalesce(sum(amount) filter (where kind = 'sangria'), 0),
         coalesce(sum(amount) filter (where kind = 'suprimento'), 0)
    into v_sangria, v_suprimento
  from shop_cash_movements where session_id = p_session_id;

  -- esperado por forma: dinheiro inclui troco inicial, suprimentos e sangrias
  select coalesce(jsonb_object_agg(code, val), '{}'::jsonb) into v_expected
  from (
    select m.code,
      coalesce((v_by_method -> m.code ->> 'amount')::numeric, 0)
        + case when m.code = 'dinheiro' then v_s.opening_amount + v_suprimento - v_sangria else 0 end as val
    from shop_payment_methods m
    where m.active or v_by_method ? m.code
  ) e;

  return jsonb_build_object(
    'session', to_jsonb(v_s),
    'by_method', v_by_method,
    'sales', v_sales,
    'sangria', v_sangria,
    'suprimento', v_suprimento,
    'expected', v_expected
  );
end $$;

-- Fecha o caixa com os valores contados
create or replace function public.shop_close_cash(p_session_id uuid, p_counted jsonb, p_notes text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_summary jsonb;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  perform 1 from shop_cash_sessions where id = p_session_id and status = 'aberto' for update;
  if not found then raise exception 'Caixa não está aberto'; end if;
  v_summary := public.shop_cash_summary(p_session_id);
  update shop_cash_sessions set
    status = 'fechado', closed_at = now(), closed_by = auth.uid(),
    expected = v_summary -> 'expected', counted = coalesce(p_counted, '{}'::jsonb),
    summary = v_summary - 'session', notes = p_notes
  where id = p_session_id;
  return v_summary;
end $$;

-- Finaliza uma venda: grava venda, itens, pagamentos e dá baixa no estoque.
-- p_items:    [{product_id, qty, unit_price}]
-- p_payments: [{method, amount}]
create or replace function public.shop_finalize_sale(
  p_items jsonb, p_payments jsonb, p_discount numeric default 0,
  p_customer_name text default null, p_notes text default null,
  p_stringing_order_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session uuid; v_sale uuid; v_number bigint;
  v_allow_negative boolean;
  v_subtotal numeric := 0; v_discount numeric := round(coalesce(p_discount, 0), 2);
  v_total numeric; v_paid numeric := 0; v_fee_total numeric := 0; v_cost_total numeric := 0;
  v_item jsonb; v_pay jsonb; v_prod shop_products;
  v_qty numeric; v_price numeric; v_line numeric; v_line_disc numeric; v_disc_left numeric;
  v_fee_pct numeric; v_count int; v_i int := 0;
  v_is_admin boolean := public.shop_is_admin(); v_max_disc numeric; v_expected numeric;
  v_order shop_stringing_orders;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select id into v_session from shop_cash_sessions where status = 'aberto';
  if v_session is null then raise exception 'Abra o caixa antes de vender'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Venda sem itens'; end if;
  select allow_negative_stock, max_seller_discount_pct into v_allow_negative, v_max_disc from shop_settings where id = 1;
  if p_stringing_order_id is not null then
    select * into v_order from shop_stringing_orders where id = p_stringing_order_id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_subtotal := v_subtotal + round((v_item->>'qty')::numeric * (v_item->>'unit_price')::numeric, 2);
  end loop;
  if v_discount < 0 or v_discount > v_subtotal then raise exception 'Desconto inválido'; end if;
  if not v_is_admin and v_subtotal > 0 and v_discount > round(v_subtotal * v_max_disc / 100, 2) then
    raise exception 'Desconto acima do limite do vendedor (% %%). Peça ao administrador.', v_max_disc;
  end if;
  v_total := v_subtotal - v_discount;

  for v_pay in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    v_paid := v_paid + round((v_pay->>'amount')::numeric, 2);
  end loop;
  if abs(v_paid - v_total) > 0.009 then
    raise exception 'Pagamentos (%) não batem com o total (%)', v_paid, v_total;
  end if;

  -- valida estoque antes de gravar, para não queimar número de venda à toa
  if not v_allow_negative then
    for v_prod in
      select p.* from shop_products p
      join (select (e->>'product_id')::uuid pid, sum((e->>'qty')::numeric) q
              from jsonb_array_elements(p_items) e group by 1) w on w.pid = p.id
      where p.kind = 'produto' and p.stock_qty < w.q
    loop
      raise exception 'Estoque insuficiente de "%" (tem %)', v_prod.name, v_prod.stock_qty;
    end loop;
  end if;

  insert into shop_sales (session_id, customer_name, subtotal, discount, total, notes, created_by)
  values (v_session, nullif(trim(p_customer_name), ''), v_subtotal, v_discount, v_total, p_notes, auth.uid())
  returning id, number into v_sale, v_number;

  v_count := jsonb_array_length(p_items);
  v_disc_left := v_discount;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    select * into v_prod from shop_products where id = (v_item->>'product_id')::uuid for update;
    if v_prod.id is null then raise exception 'Produto não encontrado'; end if;
    v_qty := (v_item->>'qty')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    if v_qty <= 0 then raise exception 'Quantidade inválida para %', v_prod.name; end if;
    -- vendedor vende pelo preço cadastrado (ou promoção vigente / valor da ordem de encordoamento)
    if not v_is_admin then
      v_expected := case
        when v_order.id is not null and v_prod.id = v_order.service_product_id and v_order.price is not null then v_order.price
        when v_prod.promo_price is not null and v_prod.promo_until >= (now() at time zone 'America/Recife')::date then v_prod.promo_price
        else v_prod.sale_price end;
      if abs(v_price - v_expected) > 0.009 then
        raise exception 'Preço de "%" diferente do cadastrado. Só o administrador altera preço.', v_prod.name;
      end if;
    end if;
    v_line := round(v_qty * v_price, 2);
    -- rateia o desconto proporcionalmente; a última linha leva o resto
    if v_i = v_count then v_line_disc := v_disc_left;
    elsif v_subtotal > 0 then v_line_disc := round(v_discount * v_line / v_subtotal, 2);
    else v_line_disc := 0; end if;
    v_disc_left := v_disc_left - v_line_disc;

    insert into shop_sale_items (sale_id, product_id, description, qty, unit_price, discount, total, unit_cost)
    values (v_sale, v_prod.id, v_prod.name, v_qty, v_price, v_line_disc, v_line - v_line_disc, v_prod.cost_price);
    v_cost_total := v_cost_total + round(v_qty * v_prod.cost_price, 2);

    if v_prod.kind = 'produto' then
      if not v_allow_negative and v_prod.stock_qty < v_qty then
        raise exception 'Estoque insuficiente de "%" (tem %, pediu %)', v_prod.name, v_prod.stock_qty, v_qty;
      end if;
      update shop_products set stock_qty = stock_qty - v_qty where id = v_prod.id;
      insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, sale_id, created_by)
      values (v_prod.id, 'venda', -v_qty, v_prod.stock_qty - v_qty, v_prod.cost_price, v_sale, auth.uid());
    end if;
  end loop;

  for v_pay in select * from jsonb_array_elements(p_payments) loop
    select fee_pct into v_fee_pct from shop_payment_methods where code = v_pay->>'method';
    if v_fee_pct is null then raise exception 'Forma de pagamento inválida: %', v_pay->>'method'; end if;
    insert into shop_sale_payments (sale_id, method, amount, fee_pct, fee_amount)
    values (v_sale, v_pay->>'method', round((v_pay->>'amount')::numeric, 2), v_fee_pct,
            round((v_pay->>'amount')::numeric * v_fee_pct / 100, 2));
    v_fee_total := v_fee_total + round((v_pay->>'amount')::numeric * v_fee_pct / 100, 2);
  end loop;

  update shop_sales set cost_total = v_cost_total, fee_total = v_fee_total where id = v_sale;

  if p_stringing_order_id is not null then
    update shop_stringing_orders
      set sale_id = v_sale, status = 'entregue', delivered_at = coalesce(delivered_at, now())
    where id = p_stringing_order_id;
  end if;

  return jsonb_build_object('id', v_sale, 'number', v_number, 'total', v_total);
end $$;

-- Cancela uma venda e devolve os itens ao estoque.
-- Vendedor só cancela venda do caixa que ainda está aberto; admin cancela qualquer uma.
create or replace function public.shop_cancel_sale(p_sale_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_sale shop_sales; v_item shop_sale_items; v_kind text; v_new numeric; v_session_status text;
begin
  if not public.shop_is_member() then raise exception 'Sem permissão'; end if;
  select * into v_sale from shop_sales where id = p_sale_id for update;
  if v_sale.id is null then raise exception 'Venda não encontrada'; end if;
  if v_sale.status = 'cancelada' then raise exception 'Venda já cancelada'; end if;
  select status into v_session_status from shop_cash_sessions where id = v_sale.session_id;
  if v_session_status <> 'aberto' and not public.shop_is_admin() then
    raise exception 'Só o administrador pode cancelar vendas de um caixa já fechado';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo do cancelamento'; end if;

  for v_item in select * from shop_sale_items where sale_id = p_sale_id loop
    select kind into v_kind from shop_products where id = v_item.product_id for update;
    if v_kind = 'produto' then
      update shop_products set stock_qty = stock_qty + v_item.qty where id = v_item.product_id
        returning stock_qty into v_new;
      insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, sale_id, notes, created_by)
      values (v_item.product_id, 'cancelamento_venda', v_item.qty, v_new, v_item.unit_cost, p_sale_id, p_reason, auth.uid());
    end if;
  end loop;

  update shop_sales set status = 'cancelada', canceled_at = now(), canceled_by = auth.uid(), cancel_reason = p_reason
  where id = p_sale_id;
  update shop_stringing_orders set sale_id = null, status = 'pronta', delivered_at = null where sale_id = p_sale_id;
end $$;

-- Ajuste manual de estoque (inventário, perda, entrada sem nota)
create or replace function public.shop_adjust_stock(
  p_product_id uuid, p_kind text, p_qty numeric, p_unit_cost numeric default null, p_notes text default null
) returns numeric language plpgsql security definer set search_path = public as $$
declare v_prod shop_products; v_delta numeric; v_new numeric; v_cost numeric;
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador ajusta estoque'; end if;
  select * into v_prod from shop_products where id = p_product_id for update;
  if v_prod.id is null then raise exception 'Produto não encontrado'; end if;
  if v_prod.kind <> 'produto' then raise exception 'Serviço não tem estoque'; end if;

  if p_kind = 'ajuste' then            -- p_qty = nova quantidade contada
    v_delta := p_qty - v_prod.stock_qty;
  elsif p_kind = 'perda' then
    v_delta := -abs(p_qty);
  elsif p_kind = 'entrada_manual' then
    v_delta := abs(p_qty);
  else
    raise exception 'Tipo de ajuste inválido';
  end if;
  v_new := v_prod.stock_qty + v_delta;
  v_cost := v_prod.cost_price;

  if p_kind = 'entrada_manual' and p_unit_cost is not null and p_unit_cost > 0 then
    v_cost := case when v_prod.stock_qty > 0
      then (v_prod.stock_qty * v_prod.cost_price + v_delta * p_unit_cost) / v_new
      else p_unit_cost end;
    update shop_products set stock_qty = v_new, cost_price = round(v_cost, 4), last_cost = p_unit_cost where id = p_product_id;
  else
    update shop_products set stock_qty = v_new where id = p_product_id;
  end if;

  insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, notes, created_by)
  values (p_product_id, p_kind, v_delta, v_new, coalesce(p_unit_cost, v_prod.cost_price), p_notes, auth.uid());
  return v_new;
end $$;

-- Importa uma nota fiscal: grava a nota, dá entrada no estoque e
-- recalcula o custo médio ponderado de cada produto.
-- p_header: {access_key, number, series, supplier_name, supplier_cnpj, issue_date,
--            total_products, freight, discount, other_costs, ipi, icms_st, total, source}
-- p_items:  [{product_id, nf_name, supplier_code, ean, nf_qty, nf_unit_price, unit_cost_nf, remember}]
--           unit_cost_nf = custo efetivo por unidade DA NOTA (já com rateio de frete/IPI/ST/desconto)
create or replace function public.shop_import_invoice(p_header jsonb, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_inv uuid; v_item jsonb; v_prod shop_products;
  v_stock_qty numeric; v_unit_cost numeric; v_new_qty numeric; v_new_cost numeric;
  v_cnpj text := regexp_replace(coalesce(p_header->>'supplier_cnpj', ''), '\D', '', 'g');
  v_key text := regexp_replace(coalesce(p_header->>'access_key', ''), '\D', '', 'g');
begin
  if not public.shop_is_admin() then raise exception 'Só o administrador importa notas'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'Nota sem itens'; end if;
  if v_key <> '' and exists (select 1 from shop_invoices where access_key = v_key) then
    raise exception 'Esta nota (chave %) já foi importada', v_key;
  end if;

  insert into shop_invoices (access_key, number, series, supplier_name, supplier_cnpj, issue_date,
    total_products, freight, discount, other_costs, ipi, icms_st, total, source, created_by)
  values (nullif(v_key, ''), p_header->>'number', p_header->>'series', p_header->>'supplier_name', nullif(v_cnpj, ''),
    nullif(p_header->>'issue_date', '')::date,
    nullif(p_header->>'total_products', '')::numeric, coalesce(nullif(p_header->>'freight', '')::numeric, 0),
    coalesce(nullif(p_header->>'discount', '')::numeric, 0), coalesce(nullif(p_header->>'other_costs', '')::numeric, 0),
    coalesce(nullif(p_header->>'ipi', '')::numeric, 0), coalesce(nullif(p_header->>'icms_st', '')::numeric, 0),
    nullif(p_header->>'total', '')::numeric, coalesce(p_header->>'source', 'pdf'), auth.uid())
  returning id into v_inv;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from shop_products where id = (v_item->>'product_id')::uuid for update;
    if v_prod.id is null then raise exception 'Produto não encontrado para "%"', v_item->>'nf_name'; end if;
    if v_prod.kind <> 'produto' then raise exception '"%" é serviço e não pode receber estoque', v_prod.name; end if;

    v_stock_qty := (v_item->>'nf_qty')::numeric * v_prod.nf_unit_factor;
    v_unit_cost := (v_item->>'unit_cost_nf')::numeric / v_prod.nf_unit_factor;
    v_new_qty := v_prod.stock_qty + v_stock_qty;
    v_new_cost := case when v_prod.stock_qty > 0 and v_new_qty > 0
      then (v_prod.stock_qty * v_prod.cost_price + v_stock_qty * v_unit_cost) / v_new_qty
      else v_unit_cost end;

    update shop_products set
      stock_qty = v_new_qty, cost_price = round(v_new_cost, 4), last_cost = round(v_unit_cost, 4),
      nf_name = coalesce(nf_name, v_item->>'nf_name'),
      barcode = coalesce(nullif(barcode, ''), nullif(v_item->>'ean', ''))
    where id = v_prod.id;

    insert into shop_invoice_items (invoice_id, product_id, nf_name, supplier_code, ean, nf_qty, nf_unit_price, stock_qty, unit_cost)
    values (v_inv, v_prod.id, v_item->>'nf_name', v_item->>'supplier_code', v_item->>'ean',
      (v_item->>'nf_qty')::numeric, (v_item->>'nf_unit_price')::numeric, v_stock_qty, round(v_unit_cost, 4));

    insert into shop_stock_movements (product_id, kind, qty, balance_after, unit_cost, invoice_id, notes, created_by)
    values (v_prod.id, 'entrada_nf', v_stock_qty, v_new_qty, round(v_unit_cost, 4), v_inv,
      'NF ' || coalesce(p_header->>'number', '') || ' — ' || coalesce(p_header->>'supplier_name', ''), auth.uid());

    if coalesce((v_item->>'remember')::boolean, true) and public.shop_norm(v_item->>'nf_name') is not null then
      insert into shop_product_nf_links (product_id, nf_name_norm, supplier_cnpj, supplier_code)
      values (v_prod.id, public.shop_norm(v_item->>'nf_name'), v_cnpj, v_item->>'supplier_code')
      on conflict (nf_name_norm, supplier_cnpj) do update set product_id = excluded.product_id, supplier_code = excluded.supplier_code;
    end if;
  end loop;

  return v_inv;
end $$;

-- =====================================================================
-- RLS
-- Leitura: qualquer usuário da loja. Escrita direta: só admin (exceto
-- ordens de encordoamento). Venda/caixa/estoque passam pelas funções acima.
-- =====================================================================
alter table public.shop_user_roles enable row level security;
alter table public.shop_settings enable row level security;
alter table public.shop_payment_methods enable row level security;
alter table public.shop_costs enable row level security;
alter table public.shop_products enable row level security;
alter table public.shop_product_nf_links enable row level security;
alter table public.shop_cash_sessions enable row level security;
alter table public.shop_cash_movements enable row level security;
alter table public.shop_sales enable row level security;
alter table public.shop_sale_items enable row level security;
alter table public.shop_sale_payments enable row level security;
alter table public.shop_invoices enable row level security;
alter table public.shop_invoice_items enable row level security;
alter table public.shop_stock_movements enable row level security;
alter table public.shop_stringing_orders enable row level security;

create policy "membros leem" on public.shop_user_roles for select using (public.shop_is_member());
create policy "admin gerencia" on public.shop_user_roles for all using (public.shop_is_admin()) with check (public.shop_is_admin());

do $$
declare t text;
begin
  foreach t in array array['shop_settings','shop_payment_methods','shop_costs','shop_products','shop_product_nf_links',
    'shop_cash_sessions','shop_cash_movements','shop_sales','shop_sale_items','shop_sale_payments',
    'shop_invoices','shop_invoice_items','shop_stock_movements','shop_stringing_orders'] loop
    execute format('create policy "membros leem" on public.%I for select using (public.shop_is_member())', t);
  end loop;
  foreach t in array array['shop_settings','shop_payment_methods','shop_costs','shop_products','shop_product_nf_links'] loop
    execute format('create policy "admin escreve" on public.%I for all using (public.shop_is_admin()) with check (public.shop_is_admin())', t);
  end loop;
end $$;

create policy "membros escrevem" on public.shop_stringing_orders for all
  using (public.shop_is_member()) with check (public.shop_is_member());

-- Custos são só do admin (nem leitura para vendedor)
drop policy "membros leem" on public.shop_costs;
create policy "admin le" on public.shop_costs for select using (public.shop_is_admin());

grant select on public.shop_sale_lines, public.shop_payment_lines, public.shop_product_last_sale, public.shop_monthly_revenue to authenticated;
