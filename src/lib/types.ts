export type Role = "admin" | "vendedor";

export interface Product {
  id: string;
  kind: "produto" | "servico";
  name: string;
  nf_name: string | null;
  code: string | null;
  barcode: string | null;
  category: string | null;
  brand: string | null;
  unit: string;
  nf_unit_factor: number;
  sale_price: number;
  promo_price: number | null;
  promo_until: string | null;
  cost_price: number;
  last_cost: number | null;
  stock_qty: number;
  min_stock: number;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentMethod {
  code: string;
  label: string;
  fee_pct: number;
  sort_order: number;
  active: boolean;
}

export interface ShopSettings {
  target_margin_pct: number;
  allow_negative_stock: boolean;
  analysis_days: number;
  lead_time_days: number;
  safety_days: number;
  coverage_target_days: number;
  stale_days: number;
  max_promo_discount_pct: number;
  max_seller_discount_pct: number;
  expected_monthly_revenue: number;
}

export interface Cost {
  id: string;
  name: string;
  category: string;
  kind: "fixo" | "percentual";
  amount: number;
  active: boolean;
  notes: string | null;
}

export interface SaleLine {
  id: string;
  sale_id: string;
  sale_number: number;
  created_at: string;
  session_id: string;
  product_id: string;
  product_name: string;
  category: string | null;
  kind: "produto" | "servico";
  qty: number;
  unit_price: number;
  discount: number;
  total: number;
  unit_cost: number;
  cost_total: number;
  fee_share: number;
}

export interface Sale {
  id: string;
  number: number;
  session_id: string;
  customer_name: string | null;
  subtotal: number;
  discount: number;
  total: number;
  cost_total: number;
  fee_total: number;
  status: "concluida" | "cancelada";
  notes: string | null;
  created_by: string | null;
  created_at: string;
  canceled_at: string | null;
  cancel_reason: string | null;
}

export interface CashSession {
  id: string;
  status: "aberto" | "fechado";
  opened_at: string;
  opened_by: string | null;
  opening_amount: number;
  closed_at: string | null;
  closed_by: string | null;
  expected: Record<string, number> | null;
  counted: Record<string, number> | null;
  summary: CashSummary | null;
  notes: string | null;
}

export interface CashSummary {
  session?: CashSession;
  by_method: Record<string, { amount: number; fee: number; count: number }>;
  sales: {
    count: number;
    canceled: number;
    gross: number;
    discount: number;
    total: number;
    cost: number;
    fees: number;
  };
  sangria: number;
  suprimento: number;
  expected: Record<string, number>;
}

export interface StringingOrder {
  id: string;
  number: number;
  customer_name: string;
  customer_phone: string | null;
  racket: string | null;
  service_product_id: string | null;
  string_product_id: string | null;
  string_description: string | null;
  tension_main: number | null;
  tension_cross: number | null;
  due_at: string | null;
  price: number | null;
  status: "recebida" | "em_andamento" | "pronta" | "entregue" | "cancelada";
  notes: string | null;
  sale_id: string | null;
  created_at: string;
  ready_at: string | null;
  delivered_at: string | null;
}

export interface Category {
  id: string;
  name: string;
}

export interface Supplier {
  id: string;
  name: string;
  trade_name: string | null;
  cnpj: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  notes: string | null;
  active: boolean;
  created_at: string;
}

export const supplierLabel = (s: Pick<Supplier, "name" | "trade_name">) => s.trade_name || s.name;

export const fmtCnpj = (v: string | null | undefined) => {
  const d = (v ?? "").replace(/\D/g, "");
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : v || "";
};
