// Fuso fixo do sistema (Recife, UTC-3 sem horário de verão) — mesmo do squashtenniscenter.
export const APP_TZ = "America/Recife";

export const normalizeText = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

// Busca sem acento e por palavras soltas: "bola wil" acha "Bola Wilson US Open".
export const matchesSearch = (haystack: string, search: string) => {
  const terms = normalizeText(search).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const h = normalizeText(haystack);
  return terms.every((t) => h.includes(t));
};

export const fmtBRL = (v: number | null | undefined) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v ?? 0));

export const fmtNum = (v: number | null | undefined, digits = 0) =>
  new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(
    Number(v ?? 0),
  );

export const fmtPct = (v: number | null | undefined, digits = 1) =>
  v == null || !Number.isFinite(v)
    ? "—"
    : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v * 100)}%`;

export const fmtDate = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d.length === 10 ? `${d}T12:00:00` : d) : d;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: APP_TZ }).format(date);
};

export const fmtDateTime = (d: string | Date | null | undefined) => {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: APP_TZ,
  }).format(date);
};

/** "YYYY-MM-DD" do instante no fuso de Recife. */
export const isoDay = (date: Date | string) => {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
};

/** Início do dia (00:00 de Recife) como ISO UTC, para filtrar no banco. */
export const startOfDayISO = (day: string) => new Date(`${day}T00:00:00-03:00`).toISOString();
export const endOfDayISO = (day: string) => new Date(`${day}T23:59:59.999-03:00`).toISOString();

/** Primeiro e último dia ("YYYY-MM-DD") do mês "YYYY-MM". */
export const monthRange = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, "0")}`, days: last };
};

export const parseDecimal = (s: string | number | null | undefined) => {
  if (typeof s === "number") return s;
  if (!s) return 0;
  const t = String(s).trim().replace(/\s/g, "");
  // "1.234,56" -> 1234.56 ; "1234.56" -> 1234.56
  const n = t.includes(",") ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t);
  return Number.isFinite(n) ? n : 0;
};

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Arredonda para baixo terminando em ,90 (preço psicológico). 47,30 -> 46,90; 9,95 -> 9,90 */
export const charmPrice = (n: number) => {
  if (n < 5) return round2(Math.floor(n * 10) / 10);
  const base = Math.floor(n);
  const candidate = base + 0.9;
  return round2(candidate <= n + 0.001 ? candidate : base - 0.1);
};

/** Preço que vale hoje: o promocional, se houver e não tiver vencido. */
export const effectivePrice = (p: { sale_price: number; promo_price: number | null; promo_until: string | null }) =>
  p.promo_price != null && p.promo_until && p.promo_until >= isoDay(new Date()) ? Number(p.promo_price) : Number(p.sale_price);
