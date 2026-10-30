import { describe, expect, test } from "bun:test";
import { computeStats, promoSuggestions, reorderSuggestions } from "./intelligence";
import type { Product, SaleLine, ShopSettings } from "./types";

const settings: ShopSettings = {
  target_margin_pct: 20, allow_negative_stock: false, analysis_days: 90, lead_time_days: 15, safety_days: 10,
  coverage_target_days: 45, stale_days: 60, max_promo_discount_pct: 30, max_seller_discount_pct: 10, expected_monthly_revenue: 0,
};
const prod = (id: string, over: Partial<Product> = {}): Product => ({
  id, kind: "produto", name: id, nf_name: null, code: null, barcode: null, category: null, brand: null, unit: "UN",
  nf_unit_factor: 1, sale_price: 100, cost_price: 50, last_cost: null, stock_qty: 10, min_stock: 0, active: true,
  notes: null, created_at: "2026-01-01T00:00:00Z", updated_at: "", ...over,
});
const line = (product_id: string, qty: number, total: number, created_at = "2026-10-01T12:00:00Z"): SaleLine => ({
  id: crypto.randomUUID(), sale_id: crypto.randomUUID(), sale_number: 1, created_at, session_id: "s", product_id,
  product_name: product_id, category: null, kind: "produto", qty, unit_price: total / qty, discount: 0, total,
  unit_cost: 0, cost_total: total / 2, fee_share: 0,
});

describe("curva ABC", () => {
  test("classifica pelo acumulado", () => {
    const products = ["a", "b", "c", "d"].map((id) => prod(id));
    const lines = [line("a", 70, 7000), line("b", 20, 2000), line("c", 10, 1000)];
    const st = computeStats(products, lines, 90);
    const by = Object.fromEntries(st.map((s) => [s.product.id, s.abc]));
    expect(by).toEqual({ a: "A", b: "B", c: "C", d: "C" });
  });
});

describe("reposição", () => {
  test("sugere comprar quando cobertura < prazo + segurança", () => {
    // vende 1/dia, tem 10 -> ponto de pedido 25 -> compra até 60 (15+45)
    const products = [prod("a", { stock_qty: 10 })];
    const st = computeStats(products, [line("a", 90, 9000)], 90);
    const r = reorderSuggestions(st, settings);
    expect(r).toHaveLength(1);
    expect(r[0].suggestedQty).toBe(50);
    expect(r[0].urgency).toBe("urgente");
  });
  test("respeita estoque mínimo mesmo sem venda", () => {
    const st = computeStats([prod("a", { stock_qty: 1, min_stock: 4 })], [], 90);
    expect(reorderSuggestions(st, settings)[0].suggestedQty).toBe(3);
  });
});

describe("promoções", () => {
  const cs = { fixedMonthly: 0, revenueBase: 0, revenueBaseSource: "nenhum" as const, taxesAndCommissions: 0.06, cardFee: 0.02, variable: 0.08, fixed: 0.12 };
  const now = new Date("2026-10-30T12:00:00Z");
  test("parado há 60+ dias ganha 10%", () => {
    const st = computeStats([prod("a")], [], 90, "revenue", { a: "2026-08-25T12:00:00Z" });
    const [p] = promoSuggestions(st, cs, settings, now);
    expect(p.promoPrice).toBe(89.9);
    expect(p.floorKind).toBe("equilibrio");
  });
  test("nunca desce abaixo do piso", () => {
    // custo 80, equilíbrio = 80 / 0.8 = 100 = preço -> sem promoção possível
    const st = computeStats([prod("a", { cost_price: 80 })], [], 90, "revenue", { a: "2026-08-01T12:00:00Z" });
    expect(promoSuggestions(st, cs, settings, now)).toHaveLength(0);
  });
  test("parado há 2x o limite libera piso de liquidação", () => {
    const st = computeStats([prod("a", { cost_price: 75 })], [], 90, "revenue", { a: "2026-06-01T12:00:00Z" });
    const [p] = promoSuggestions(st, cs, settings, now);
    expect(p.floorKind).toBe("liquidacao");
    expect(p.promoPrice).toBeGreaterThanOrEqual(75 / 0.92);
    expect(p.promoPrice).toBeLessThan(100);
  });
});
