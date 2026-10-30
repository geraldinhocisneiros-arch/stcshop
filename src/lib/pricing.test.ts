import { describe, expect, test } from "bun:test";
import { analyzePrice, buildCostStructure } from "./pricing";
import { charmPrice } from "./format";
import type { Cost, PaymentMethod } from "./types";

const cost = (kind: Cost["kind"], amount: number): Cost => ({ id: crypto.randomUUID(), name: "x", category: "x", kind, amount, active: true, notes: null });
const methods: PaymentMethod[] = [
  { code: "pix", label: "PIX", fee_pct: 0, sort_order: 1, active: true },
  { code: "credito", label: "Crédito", fee_pct: 4, sort_order: 2, active: true },
];

describe("buildCostStructure", () => {
  test("rateia fixo pelo faturamento e pondera taxa pelo mix", () => {
    const cs = buildCostStructure({
      costs: [cost("fixo", 3000), cost("fixo", 1000), cost("percentual", 6)],
      methods,
      paymentMix: { pix: 5000, credito: 5000 },
      historicMonthlyRevenue: 20000,
      expectedMonthlyRevenue: 0,
    });
    expect(cs.fixed).toBeCloseTo(0.2);
    expect(cs.cardFee).toBeCloseTo(0.02);
    expect(cs.variable).toBeCloseTo(0.08);
    expect(cs.revenueBaseSource).toBe("historico");
  });
  test("sem histórico usa faturamento estimado", () => {
    const cs = buildCostStructure({ costs: [cost("fixo", 2000)], methods, paymentMix: {}, historicMonthlyRevenue: 0, expectedMonthlyRevenue: 10000 });
    expect(cs.fixed).toBeCloseTo(0.2);
    expect(cs.revenueBaseSource).toBe("estimado");
  });
});

describe("analyzePrice", () => {
  const cs = { variable: 0.1, fixed: 0.2 };
  test("margens", () => {
    const a = analyzePrice(100, 50, cs, 0.15);
    expect(a.grossMargin).toBeCloseTo(0.5);
    expect(a.contributionMargin).toBeCloseTo(0.4);
    expect(a.netMargin).toBeCloseTo(0.2);
    expect(a.status).toBe("ok");
  });
  test("preços de referência", () => {
    const a = analyzePrice(60, 50, cs, 0.15);
    expect(a.breakEvenPrice).toBeCloseTo(50 / 0.7);
    expect(a.floorPrice).toBeCloseTo(50 / 0.9);
    expect(a.suggestedPrice).toBeCloseTo(50 / 0.55);
    expect(a.status).toBe("prejuizo");
  });
});

describe("charmPrice", () => {
  test("termina em ,90 sem passar do valor", () => {
    expect(charmPrice(47.3)).toBe(46.9);
    expect(charmPrice(47.95)).toBe(47.9);
    expect(charmPrice(100)).toBe(99.9);
  });
});
