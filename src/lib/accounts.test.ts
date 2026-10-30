import { describe, expect, test } from "bun:test";
import { balanceOf, chargeMessage, openDebts, whatsappLink } from "./accounts";
import type { CustomerEntry } from "./types";

let n = 0;
const e = (kind: CustomerEntry["kind"], amount: number, day: number, sale_id: string | null = null): CustomerEntry => ({
  id: String(++n), customer_id: "c", kind, amount, sale_id, session_id: null, method: null, notes: null,
  created_at: `2026-10-${String(day).padStart(2, "0")}T12:00:00Z`,
});

describe("conta do cliente", () => {
  test("pagamento abate a compra mais antiga primeiro", () => {
    const entries = [e("debito", 100, 1, "s1"), e("debito", 50, 5, "s2"), e("pagamento", 120, 10)];
    expect(balanceOf(entries)).toBe(30);
    const open = openDebts(entries, new Date("2026-10-20T12:00:00Z"));
    expect(open).toHaveLength(1);
    expect(open[0].entry.sale_id).toBe("s2");
    expect(open[0].remaining).toBe(30);
    expect(open[0].daysOpen).toBe(15);
  });
  test("estorno abate a própria venda cancelada, não a mais antiga", () => {
    const entries = [e("debito", 100, 1, "s1"), e("debito", 50, 5, "s2"), e("estorno", 50, 6, "s2")];
    const open = openDebts(entries);
    expect(open.map((d) => d.entry.sale_id)).toEqual(["s1"]);
    expect(open[0].remaining).toBe(100);
  });
  test("tudo pago: nada em aberto", () => {
    const entries = [e("debito", 40, 1), e("ajuste_debito", 10, 2), e("pagamento", 50, 3)];
    expect(balanceOf(entries)).toBe(0);
    expect(openDebts(entries)).toHaveLength(0);
  });
  test("mensagem de cobrança e link do WhatsApp", () => {
    const msg = chargeMessage({
      customerName: "Maria Souza",
      debts: [{ date: "2026-10-05", description: "2× Bola Wilson", remaining: 79.8 }],
      total: 79.8,
      pixKey: "loja@squash.com",
    });
    expect(msg).toContain("Olá, Maria!");
    expect(msg).toContain("05/10/2026 — 2× Bola Wilson");
    expect(msg).toContain("PIX (chave: loja@squash.com)");
    expect(whatsappLink("(81) 99999-0000", "oi")).toBe("https://wa.me/5581999990000?text=oi");
    expect(whatsappLink("", "oi")).toBeNull();
  });
});
