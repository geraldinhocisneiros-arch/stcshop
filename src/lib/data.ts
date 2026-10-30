import { supabase } from "@/integrations/supabase/client";
import { fetchAll } from "./fetchAll";
import { endOfDayISO, isoDay, startOfDayISO } from "./format";
import { buildCostStructure, type CostStructure } from "./pricing";
import type { Category, Cost, Supplier, PaymentMethod, Product, SaleLine, ShopSettings } from "./types";

export async function loadProducts(opts: { onlyActive?: boolean } = {}): Promise<Product[]> {
  return fetchAll<Product>("shop_products", "*", {
    build: (q) => (opts.onlyActive ? q.eq("active", true) : q).order("name"),
  });
}

export async function loadCategories(): Promise<Category[]> {
  const { data, error } = await supabase.from("shop_categories").select("id, name").order("name");
  if (error) throw error;
  return (data ?? []) as Category[];
}

export async function loadBrands(): Promise<Category[]> {
  const { data, error } = await supabase.from("shop_brands").select("id, name, code").order("name");
  if (error) throw error;
  return (data ?? []) as Category[];
}

export async function loadSuppliers(): Promise<Supplier[]> {
  const { data, error } = await supabase.from("shop_suppliers").select("*").order("name");
  if (error) throw error;
  return (data ?? []) as Supplier[];
}

export async function loadSettings(): Promise<ShopSettings> {
  const { data, error } = await supabase.from("shop_settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data as ShopSettings;
}

export async function loadMethods(): Promise<PaymentMethod[]> {
  const { data, error } = await supabase.from("shop_payment_methods").select("*").order("sort_order");
  if (error) throw error;
  return (data ?? []) as PaymentMethod[];
}

export async function loadCosts(): Promise<Cost[]> {
  const { data, error } = await supabase.from("shop_costs").select("*").order("kind").order("name");
  if (error) throw error;
  return (data ?? []) as Cost[];
}

/** Linhas vendidas entre dois dias (YYYY-MM-DD, inclusive, fuso de Recife). */
export async function loadSaleLines(fromDay: string, toDay: string): Promise<SaleLine[]> {
  return fetchAll<SaleLine>("shop_sale_lines", "*", {
    build: (q) => q.gte("created_at", startOfDayISO(fromDay)).lte("created_at", endOfDayISO(toDay)).order("created_at"),
  });
}

export async function loadPaymentLines(fromDay: string, toDay: string) {
  return fetchAll<{ method: string; amount: number; fee_amount: number; created_at: string }>(
    "shop_payment_lines",
    "method, amount, fee_amount, created_at",
    { build: (q) => q.gte("created_at", startOfDayISO(fromDay)).lte("created_at", endOfDayISO(toDay)) },
  );
}

export async function loadLastSaleByProduct(): Promise<Record<string, string>> {
  const rows = await fetchAll<{ product_id: string; last_sale_at: string }>(
    "shop_product_last_sale",
    "product_id, last_sale_at",
  );
  return Object.fromEntries(rows.map((r) => [r.product_id, r.last_sale_at]));
}

export function daysAgo(n: number) {
  return isoDay(new Date(Date.now() - n * 86_400_000));
}

/**
 * Estrutura de custos atual: custos cadastrados + taxa média de cartão dos
 * últimos `analysisDays` dias + faturamento médio dos últimos 3 meses fechados
 * (ou o estimado em Configurações enquanto não houver histórico).
 */
export async function loadCostStructure(settings: ShopSettings): Promise<{
  cs: CostStructure;
  costs: Cost[];
  methods: PaymentMethod[];
  monthly: Array<{ month: string; total: number; cost: number; fees: number; sales: number }>;
}> {
  const [costs, methods, payments, monthlyRes] = await Promise.all([
    loadCosts(),
    loadMethods(),
    loadPaymentLines(daysAgo(settings.analysis_days), isoDay(new Date())),
    supabase.from("shop_monthly_revenue").select("*").order("month", { ascending: false }).limit(13),
  ]);
  const paymentMix: Record<string, number> = {};
  for (const p of payments) paymentMix[p.method] = (paymentMix[p.method] ?? 0) + Number(p.amount);

  const monthly = (monthlyRes.data ?? []).map((m: any) => ({
    month: m.month,
    total: Number(m.total),
    cost: Number(m.cost),
    fees: Number(m.fees),
    sales: Number(m.sales),
  }));
  const currentMonth = isoDay(new Date()).slice(0, 7);
  const closed = monthly.filter((m) => m.month < currentMonth).slice(0, 3);
  const historicMonthlyRevenue = closed.length ? closed.reduce((s, m) => s + m.total, 0) / closed.length : 0;

  const cs = buildCostStructure({
    costs,
    methods,
    paymentMix,
    historicMonthlyRevenue,
    expectedMonthlyRevenue: Number(settings.expected_monthly_revenue),
  });
  return { cs, costs, methods, monthly };
}

export const errMsg = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
