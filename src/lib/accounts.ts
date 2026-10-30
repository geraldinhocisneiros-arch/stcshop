import { fmtBRL, fmtDate, round2 } from "./format";
import type { CustomerEntry } from "./types";

export const DEBIT_KINDS = new Set<CustomerEntry["kind"]>(["debito", "ajuste_debito"]);

export const ENTRY_LABEL: Record<CustomerEntry["kind"], string> = {
  debito: "Compra",
  pagamento: "Pagamento",
  estorno: "Venda cancelada",
  ajuste_debito: "Ajuste (débito)",
  ajuste_credito: "Ajuste (crédito)",
};

/** Saldo: positivo = o cliente deve à loja. */
export function balanceOf(entries: CustomerEntry[]) {
  return round2(entries.reduce((s, e) => s + (DEBIT_KINDS.has(e.kind) ? 1 : -1) * Number(e.amount), 0));
}

export interface OpenDebt {
  entry: CustomerEntry;
  remaining: number;
  daysOpen: number;
}

/**
 * Quais compras ainda estão em aberto. Pagamentos, estornos e ajustes a
 * crédito abatem sempre a compra MAIS ANTIGA primeiro (como uma conta
 * corrente). Um estorno de venda cancelada abate a própria venda.
 */
export function openDebts(entries: CustomerEntry[], now = new Date()): OpenDebt[] {
  const sorted = [...entries].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const debts = sorted
    .filter((e) => DEBIT_KINDS.has(e.kind))
    .map((e) => ({ entry: e, remaining: Number(e.amount) }));

  // estorno vai direto na venda cancelada
  for (const e of sorted.filter((x) => x.kind === "estorno")) {
    let left = Number(e.amount);
    const d = debts.find((x) => x.entry.sale_id && x.entry.sale_id === e.sale_id);
    if (d) {
      const take = Math.min(d.remaining, left);
      d.remaining = round2(d.remaining - take);
      left = round2(left - take);
    }
    applyFifo(debts, left); // sobra (venda já paga): vira crédito para as mais antigas
  }
  const credit = sorted.filter((e) => e.kind === "pagamento" || e.kind === "ajuste_credito").reduce((s, e) => s + Number(e.amount), 0);
  applyFifo(debts, credit);

  return debts
    .filter((d) => d.remaining > 0.004)
    .map((d) => ({
      ...d,
      remaining: round2(d.remaining),
      daysOpen: Math.floor((now.getTime() - new Date(d.entry.created_at).getTime()) / 86_400_000),
    }));
}

function applyFifo(debts: Array<{ remaining: number }>, amount: number) {
  let left = amount;
  for (const d of debts) {
    if (left <= 0) break;
    const take = Math.min(d.remaining, left);
    d.remaining = round2(d.remaining - take);
    left = round2(left - take);
  }
}

/** Mensagem de cobrança para o WhatsApp. */
export function chargeMessage(opts: {
  customerName: string;
  debts: Array<{ date: string; description: string; remaining: number }>;
  total: number;
  pixKey?: string | null;
}) {
  const first = opts.customerName.trim().split(/\s+/)[0] ?? "";
  const lines = opts.debts.map((d) => `• ${fmtDate(d.date)} — ${d.description}: ${fmtBRL(d.remaining)}`);
  return [
    `Olá, ${first}! Tudo bem? Aqui é da Squash Tennis Shop.`,
    "",
    "Passando para lembrar que consta em aberto na sua conta:",
    ...lines,
    "",
    `*Total em aberto: ${fmtBRL(opts.total)}*`,
    "",
    opts.pixKey ? `Você pode pagar por PIX (chave: ${opts.pixKey}) ou direto na loja.` : "Você pode pagar direto na loja.",
    "Se já pagou, por favor desconsidere. Obrigado!",
  ].join("\n");
}

export function whatsappLink(phone: string | null | undefined, text: string) {
  const d = (phone ?? "").replace(/\D/g, "");
  if (!d) return null;
  const full = d.length <= 11 ? `55${d}` : d;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

/** Descrição de um lançamento de débito para extrato e cobrança. */
export function debtDescription(e: CustomerEntry, sales: Record<string, { number: number; items: string }>) {
  if (e.sale_id && sales[e.sale_id]) return sales[e.sale_id].items || `Venda nº ${sales[e.sale_id].number}`;
  return e.notes || (e.kind === "ajuste_debito" ? "Saldo anterior" : "Compra");
}

/** Monta a cobrança do cliente: compras em aberto, total e link do WhatsApp. */
export function buildCharge(
  customer: { name: string; phone: string | null },
  entries: CustomerEntry[],
  sales: Record<string, { number: number; items: string }>,
  pixKey?: string | null,
) {
  const debts = openDebts(entries);
  const total = round2(debts.reduce((s, d) => s + d.remaining, 0));
  const message = chargeMessage({
    customerName: customer.name,
    debts: debts.map((d) => ({ date: d.entry.created_at, description: debtDescription(d.entry, sales), remaining: d.remaining })),
    total,
    pixKey,
  });
  return { debts, total, message, link: whatsappLink(customer.phone, message) };
}
