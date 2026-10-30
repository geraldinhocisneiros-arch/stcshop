import type { Cost, PaymentMethod } from "./types";

/**
 * Estrutura de custos da loja, tudo em fração do preço de venda (0.06 = 6%).
 *
 *  - variable: o que sai de cada venda (imposto, comissão, taxa média de cartão)
 *  - fixed:    custo fixo mensal dividido pelo faturamento mensal
 *
 * Com isso, para um produto de custo C vendido a P:
 *   margem de contribuição = (P - C - P·variable) / P
 *   lucro líquido          = (P - C - P·(variable + fixed)) / P
 */
export interface CostStructure {
  fixedMonthly: number;
  revenueBase: number; // faturamento mensal usado no rateio
  revenueBaseSource: "historico" | "estimado" | "nenhum";
  taxesAndCommissions: number; // soma dos custos "percentual"
  cardFee: number; // taxa média ponderada pelo mix de pagamentos
  variable: number;
  fixed: number;
}

export function buildCostStructure(opts: {
  costs: Cost[];
  methods: PaymentMethod[];
  /** valor recebido por forma de pagamento no período de análise */
  paymentMix: Record<string, number>;
  /** faturamento médio mensal do histórico (0 se não houver) */
  historicMonthlyRevenue: number;
  expectedMonthlyRevenue: number;
}): CostStructure {
  const active = opts.costs.filter((c) => c.active);
  const fixedMonthly = active.filter((c) => c.kind === "fixo").reduce((s, c) => s + Number(c.amount), 0);
  const taxesAndCommissions =
    active.filter((c) => c.kind === "percentual").reduce((s, c) => s + Number(c.amount), 0) / 100;

  const mixTotal = Object.values(opts.paymentMix).reduce((s, v) => s + v, 0);
  let cardFee: number;
  if (mixTotal > 0) {
    cardFee =
      opts.methods.reduce((s, m) => s + (opts.paymentMix[m.code] ?? 0) * Number(m.fee_pct), 0) /
      mixTotal /
      100;
  } else {
    // sem histórico: média simples das formas ativas
    const act = opts.methods.filter((m) => m.active);
    cardFee = act.length ? act.reduce((s, m) => s + Number(m.fee_pct), 0) / act.length / 100 : 0;
  }

  let revenueBase = 0;
  let revenueBaseSource: CostStructure["revenueBaseSource"] = "nenhum";
  if (opts.historicMonthlyRevenue > 0) {
    revenueBase = opts.historicMonthlyRevenue;
    revenueBaseSource = "historico";
  } else if (opts.expectedMonthlyRevenue > 0) {
    revenueBase = opts.expectedMonthlyRevenue;
    revenueBaseSource = "estimado";
  }
  const fixed = revenueBase > 0 ? fixedMonthly / revenueBase : 0;

  return {
    fixedMonthly,
    revenueBase,
    revenueBaseSource,
    taxesAndCommissions,
    cardFee,
    variable: taxesAndCommissions + cardFee,
    fixed,
  };
}

export interface PriceAnalysis {
  price: number;
  cost: number;
  markup: number | null; // preço / custo
  grossMargin: number | null; // (P - C) / P
  contributionMargin: number | null;
  netMargin: number | null;
  netProfitPerUnit: number;
  breakEvenPrice: number | null; // lucro zero, pagando tudo (custo + variáveis + fixo)
  floorPrice: number | null; // só cobre custo + variáveis (não paga o fixo) — piso de liquidação
  suggestedPrice: number | null; // atinge a margem alvo
  status: "sem_custo" | "prejuizo" | "abaixo_meta" | "ok";
}

const priceFor = (cost: number, share: number) => (share < 1 ? cost / (1 - share) : null);

export function analyzePrice(
  price: number,
  cost: number,
  cs: Pick<CostStructure, "variable" | "fixed">,
  targetMargin: number,
): PriceAnalysis {
  const p = Number(price) || 0;
  const c = Number(cost) || 0;
  const variableValue = p * cs.variable;
  const fixedValue = p * cs.fixed;
  const netProfitPerUnit = p - c - variableValue - fixedValue;
  const res: PriceAnalysis = {
    price: p,
    cost: c,
    markup: c > 0 ? p / c : null,
    grossMargin: p > 0 ? (p - c) / p : null,
    contributionMargin: p > 0 ? (p - c - variableValue) / p : null,
    netMargin: p > 0 ? netProfitPerUnit / p : null,
    netProfitPerUnit,
    breakEvenPrice: c > 0 ? priceFor(c, cs.variable + cs.fixed) : null,
    floorPrice: c > 0 ? priceFor(c, cs.variable) : null,
    suggestedPrice: c > 0 ? priceFor(c, cs.variable + cs.fixed + targetMargin) : null,
    status: "ok",
  };
  if (c <= 0) res.status = "sem_custo";
  else if (netProfitPerUnit < 0) res.status = "prejuizo";
  else if ((res.netMargin ?? 0) < targetMargin - 0.0001) res.status = "abaixo_meta";
  return res;
}

export const PRICE_STATUS_LABEL: Record<PriceAnalysis["status"], string> = {
  sem_custo: "Sem custo",
  prejuizo: "Prejuízo",
  abaixo_meta: "Abaixo da meta",
  ok: "OK",
};
