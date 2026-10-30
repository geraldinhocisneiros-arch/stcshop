import { analyzePrice, type CostStructure } from "./pricing";
import { charmPrice, round2 } from "./format";
import type { Product, SaleLine, ShopSettings } from "./types";

export type AbcClass = "A" | "B" | "C";

export interface ProductStats {
  product: Product;
  qty: number;
  revenue: number;
  cost: number;
  fees: number;
  grossProfit: number; // receita - custo - taxas de cartão
  salesCount: number;
  lastSaleAt: string | null;
  dailyAvg: number; // unidades por dia no período
  coverageDays: number | null; // quantos dias o estoque atual dura
  share: number; // % da receita
  cumulativeShare: number;
  abc: AbcClass;
}

/** Agrega as linhas vendidas por produto e classifica em curva ABC pela métrica escolhida. */
export function computeStats(
  products: Product[],
  lines: SaleLine[],
  periodDays: number,
  metric: "revenue" | "grossProfit" = "revenue",
  /** última venda de cada produto em todo o histórico (não só no período) */
  lastSaleByProduct: Record<string, string> = {},
): ProductStats[] {
  const agg = new Map<string, { qty: number; revenue: number; cost: number; fees: number; sales: Set<string>; last: string | null }>();
  for (const l of lines) {
    const a = agg.get(l.product_id) ?? { qty: 0, revenue: 0, cost: 0, fees: 0, sales: new Set(), last: null };
    a.qty += Number(l.qty);
    a.revenue += Number(l.total);
    a.cost += Number(l.cost_total);
    a.fees += Number(l.fee_share);
    a.sales.add(l.sale_id);
    if (!a.last || l.created_at > a.last) a.last = l.created_at;
    agg.set(l.product_id, a);
  }

  const rows = products.map((p) => {
    const a = agg.get(p.id);
    const qty = a?.qty ?? 0;
    const dailyAvg = periodDays > 0 ? qty / periodDays : 0;
    const last = [a?.last, lastSaleByProduct[p.id]].filter(Boolean).sort().pop() ?? null;
    return {
      product: p,
      qty,
      revenue: round2(a?.revenue ?? 0),
      cost: round2(a?.cost ?? 0),
      fees: round2(a?.fees ?? 0),
      grossProfit: round2((a?.revenue ?? 0) - (a?.cost ?? 0) - (a?.fees ?? 0)),
      salesCount: a?.sales.size ?? 0,
      lastSaleAt: last,
      dailyAvg,
      coverageDays: p.kind === "produto" ? (dailyAvg > 0 ? Number(p.stock_qty) / dailyAvg : null) : null,
      share: 0,
      cumulativeShare: 0,
      abc: "C" as AbcClass,
    };
  });

  const value = (r: (typeof rows)[number]) => Math.max(0, r[metric]);
  const total = rows.reduce((s, r) => s + value(r), 0);
  rows.sort((a, b) => value(b) - value(a));
  let cum = 0;
  for (const r of rows) {
    const v = value(r);
    r.share = total > 0 ? v / total : 0;
    const before = cum;
    cum += r.share;
    r.cumulativeShare = cum;
    // regra clássica: até 80% do acumulado = A, até 95% = B, resto = C.
    // O primeiro item com valor é sempre A (mesmo que sozinho passe de 80%).
    r.abc = v <= 0 ? "C" : cum <= 0.8 + 1e-9 || before === 0 ? "A" : cum <= 0.95 + 1e-9 ? "B" : "C";
  }
  return rows;
}

export interface ReorderSuggestion {
  stats: ProductStats;
  reorderPoint: number;
  suggestedQty: number;
  urgency: "ruptura" | "urgente" | "repor";
  reason: string;
}

/**
 * O que precisa comprar. Ponto de pedido = consumo diário × (prazo do fornecedor
 * + segurança). A quantidade sugerida leva o estoque até cobrir o prazo + a
 * cobertura alvo. O estoque mínimo cadastrado sempre é respeitado.
 */
export function reorderSuggestions(stats: ProductStats[], s: ShopSettings): ReorderSuggestion[] {
  const out: ReorderSuggestion[] = [];
  for (const st of stats) {
    const p = st.product;
    if (p.kind !== "produto" || !p.active) continue;
    const stock = Number(p.stock_qty);
    const min = Number(p.min_stock);
    const reorderPoint = st.dailyAvg * (s.lead_time_days + s.safety_days);
    const trigger = Math.max(reorderPoint, min);
    if (trigger <= 0 || stock > trigger) continue;

    const target = Math.max(st.dailyAvg * (s.lead_time_days + s.coverage_target_days), min);
    const suggestedQty = Math.max(1, Math.ceil(target - stock));
    let urgency: ReorderSuggestion["urgency"] = "repor";
    if (stock <= 0) urgency = "ruptura";
    else if (st.coverageDays !== null && st.coverageDays < s.lead_time_days) urgency = "urgente";

    const reason =
      stock <= 0
        ? st.qty > 0
          ? `Zerado — vendeu ${round2(st.qty)} no período, está perdendo venda`
          : "Zerado e abaixo do mínimo"
        : st.coverageDays !== null
          ? `Dura ~${Math.round(st.coverageDays)} dias; fornecedor leva ${s.lead_time_days}`
          : `Abaixo do mínimo (${min})`;
    out.push({ stats: st, reorderPoint, suggestedQty, urgency, reason });
  }
  const rank = { ruptura: 0, urgente: 1, repor: 2 };
  const abcRank = { A: 0, B: 1, C: 2 };
  return out.sort(
    (a, b) =>
      rank[a.urgency] - rank[b.urgency] ||
      abcRank[a.stats.abc] - abcRank[b.stats.abc] ||
      b.stats.revenue - a.stats.revenue,
  );
}

export interface PromoSuggestion {
  stats: ProductStats;
  daysWithoutSale: number | null;
  capitalTied: number; // estoque × custo
  discountPct: number;
  promoPrice: number;
  floor: number;
  floorKind: "equilibrio" | "liquidacao";
  newNetMargin: number | null;
  reason: string;
}

/**
 * Promoções. Candidatos: produtos com estoque que estão parados (sem venda há
 * mais de `stale_days`) ou com cobertura muito acima da meta (excesso).
 *
 * Desconto cresce com o tempo parado: 10% ao atingir o limite, +5% a cada 30
 * dias, até o teto configurado. O preço nunca desce abaixo do piso:
 *   - parado há menos de 2× o limite: piso = preço de equilíbrio (lucro zero,
 *     ainda paga a parte do custo fixo);
 *   - parado há 2× o limite ou mais: piso = preço de liquidação (só cobre o
 *     custo do produto + impostos/taxas). Melhor virar dinheiro do que mofar.
 */
export function promoSuggestions(
  stats: ProductStats[],
  cs: CostStructure,
  s: ShopSettings,
  now = new Date(),
): PromoSuggestion[] {
  const out: PromoSuggestion[] = [];
  for (const st of stats) {
    const p = st.product;
    if (p.kind !== "produto" || !p.active || Number(p.stock_qty) <= 0 || Number(p.sale_price) <= 0) continue;

    const ref = st.lastSaleAt ?? p.created_at;
    const daysWithoutSale = ref ? Math.floor((now.getTime() - new Date(ref).getTime()) / 86_400_000) : null;
    const stale = daysWithoutSale !== null && daysWithoutSale >= s.stale_days;
    const excess =
      st.coverageDays !== null && st.coverageDays > s.coverage_target_days * 3 && st.abc === "C";
    if (!stale && !excess) continue;

    let discount: number;
    if (stale) {
      const extraMonths = Math.floor(((daysWithoutSale ?? 0) - s.stale_days) / 30);
      discount = 0.1 + 0.05 * extraMonths;
    } else {
      discount = 0.1;
    }
    discount = Math.min(discount, s.max_promo_discount_pct / 100);

    const pa = analyzePrice(p.sale_price, p.cost_price, cs, 0);
    const deep = stale && (daysWithoutSale ?? 0) >= s.stale_days * 2;
    const floorKind = deep ? "liquidacao" : "equilibrio";
    const floor = (deep ? pa.floorPrice : pa.breakEvenPrice) ?? 0;

    let promoPrice = charmPrice(p.sale_price * (1 - discount));
    if (promoPrice < floor) promoPrice = round2(Math.ceil(floor * 10) / 10);
    if (promoPrice >= p.sale_price) continue; // já está no piso: não há margem para promoção
    const realDiscount = 1 - promoPrice / p.sale_price;
    const after = analyzePrice(promoPrice, p.cost_price, cs, 0);

    const reason = stale
      ? daysWithoutSale === null
        ? "Nunca vendeu"
        : st.lastSaleAt
          ? `Sem venda há ${daysWithoutSale} dias`
          : `Cadastrado há ${daysWithoutSale} dias e nunca vendeu`
      : `Estoque para ${Math.round(st.coverageDays ?? 0)} dias (meta ${s.coverage_target_days})`;

    out.push({
      stats: st,
      daysWithoutSale,
      capitalTied: round2(Number(p.stock_qty) * Number(p.cost_price)),
      discountPct: realDiscount,
      promoPrice,
      floor: round2(floor),
      floorKind,
      newNetMargin: after.netMargin,
      reason,
    });
  }
  return out.sort((a, b) => b.capitalTied - a.capitalTied);
}
