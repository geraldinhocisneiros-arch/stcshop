import { normalizeText, round2 } from "./format";
import type { Product } from "./types";

/**
 * Formato comum de uma nota de entrada, venha ela do XML (exato) ou da
 * leitura do PDF pela IA (aproximado, sempre revisado na tela).
 */
export interface InvoiceItemDraft {
  nf_name: string;
  supplier_code: string | null;
  ean: string | null;
  ncm: string | null;
  unit: string | null;
  qty: number;
  unit_price: number;
  total: number; // valor bruto do item (qtd × unitário)
  discount: number | null; // valores do próprio item, quando a nota informa
  freight: number | null;
  other: number | null;
  ipi: number | null;
  icms_st: number | null;
}

export interface InvoiceDraft {
  access_key: string | null;
  number: string | null;
  series: string | null;
  issue_date: string | null; // YYYY-MM-DD
  supplier_name: string | null;
  supplier_cnpj: string | null;
  total_products: number | null;
  freight: number;
  discount: number;
  other_costs: number;
  ipi: number;
  icms_st: number;
  total: number | null;
  items: InvoiceItemDraft[];
  /** avisos da leitura por IA (campos ilegíveis na foto/PDF) */
  warnings?: string[];
}

/** Mesma normalização do banco (shop_norm): sem acento, maiúsculo, espaço único. */
export const normNfName = (s: string | null | undefined) =>
  normalizeText(s).toUpperCase().replace(/\s+/g, " ");

export const onlyDigits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

// ---------------------------------------------------------------------------
// Rateio de custos acessórios
// ---------------------------------------------------------------------------

/**
 * Custo efetivo por unidade DA NOTA de cada item:
 *   (valor do item + frete + outras despesas + IPI + ICMS-ST − desconto) / quantidade
 *
 * Quando a nota só informa o total (frete no rodapé, por ex.), a diferença
 * entre o total da nota e a soma dos itens é rateada proporcionalmente ao
 * valor de cada item. É isso que faz o custo do produto ser o custo REAL,
 * não só o preço unitário impresso.
 */
export function effectiveUnitCosts(draft: InvoiceDraft): number[] {
  const items = draft.items;
  const base = items.reduce((s, i) => s + i.total, 0);
  const sumItem = (k: "freight" | "other" | "ipi" | "icms_st" | "discount") =>
    items.reduce((s, i) => s + (i[k] ?? 0), 0);
  const remainder = (header: number, k: Parameters<typeof sumItem>[0]) =>
    Math.max(0, round2((header || 0) - sumItem(k)));

  const rem = {
    freight: remainder(draft.freight, "freight"),
    other: remainder(draft.other_costs, "other"),
    ipi: remainder(draft.ipi, "ipi"),
    icms_st: remainder(draft.icms_st, "icms_st"),
    discount: remainder(draft.discount, "discount"),
  };

  return items.map((i) => {
    const w = base > 0 ? i.total / base : 1 / items.length;
    const extra =
      (i.freight ?? 0) + rem.freight * w +
      (i.other ?? 0) + rem.other * w +
      (i.ipi ?? 0) + rem.ipi * w +
      (i.icms_st ?? 0) + rem.icms_st * w -
      ((i.discount ?? 0) + rem.discount * w);
    const qty = i.qty > 0 ? i.qty : 1;
    return Math.round(((i.total + extra) / qty) * 10000) / 10000;
  });
}

// ---------------------------------------------------------------------------
// XML da NF-e (o arquivo que o fornecedor manda junto com o DANFE)
// ---------------------------------------------------------------------------

const tagRe = (tag: string) => new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "g");

function first(xml: string | undefined, tag: string): string | null {
  if (!xml) return null;
  const m = tagRe(tag).exec(xml);
  return m ? m[1].trim() : null;
}
function all(xml: string, tag: string): string[] {
  return Array.from(xml.matchAll(tagRe(tag)), (m) => m[1]);
}
const num = (s: string | null) => (s ? Number(s) : 0);
const numOrNull = (s: string | null) => (s ? Number(s) : null);

const decodeEntities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

export function parseNfeXml(xml: string): InvoiceDraft {
  const inf = first(xml, "infNFe");
  if (!inf) throw new Error("Arquivo não parece ser um XML de NF-e (sem <infNFe>).");
  const idMatch = /<(?:\w+:)?infNFe[^>]*\sId="NFe(\d{44})"/.exec(xml);
  const protKey = first(xml, "chNFe");
  const ide = first(inf, "ide") ?? "";
  const emit = first(inf, "emit") ?? "";
  const tot = first(first(inf, "total") ?? "", "ICMSTot") ?? "";
  const dh = first(ide, "dhEmi") ?? first(ide, "dEmi");

  const items: InvoiceItemDraft[] = all(inf, "det").map((det) => {
    const prod = first(det, "prod") ?? "";
    const imposto = first(det, "imposto") ?? "";
    const ean = first(prod, "cEAN");
    return {
      nf_name: decodeEntities(first(prod, "xProd") ?? ""),
      supplier_code: first(prod, "cProd"),
      ean: ean && /^\d{8,14}$/.test(ean) ? ean : null,
      ncm: first(prod, "NCM"),
      unit: first(prod, "uCom"),
      qty: num(first(prod, "qCom")),
      unit_price: num(first(prod, "vUnCom")),
      total: num(first(prod, "vProd")),
      discount: numOrNull(first(prod, "vDesc")),
      freight: numOrNull(first(prod, "vFrete")),
      other: numOrNull(first(prod, "vOutro")),
      ipi: numOrNull(first(first(imposto, "IPI") ?? "", "vIPI")),
      icms_st: numOrNull(first(first(imposto, "ICMS") ?? "", "vICMSST")),
    };
  });

  return {
    access_key: idMatch?.[1] ?? (protKey && /^\d{44}$/.test(protKey) ? protKey : null),
    number: first(ide, "nNF"),
    series: first(ide, "serie"),
    issue_date: dh ? dh.slice(0, 10) : null,
    supplier_name: decodeEntities(first(emit, "xNome") ?? "") || null,
    supplier_cnpj: first(emit, "CNPJ") ?? first(emit, "CPF"),
    total_products: numOrNull(first(tot, "vProd")),
    freight: num(first(tot, "vFrete")),
    discount: num(first(tot, "vDesc")),
    other_costs: num(first(tot, "vOutro")),
    ipi: num(first(tot, "vIPI")),
    icms_st: num(first(tot, "vST")),
    total: numOrNull(first(tot, "vNF")),
    items,
  };
}

// ---------------------------------------------------------------------------
// Casamento item da nota -> produto cadastrado
// ---------------------------------------------------------------------------

export interface NfLink {
  product_id: string;
  nf_name_norm: string;
  supplier_cnpj: string;
  supplier_code: string | null;
}

export type MatchKind = "vinculo" | "nome_nf" | "ean" | "codigo" | "apelido";

export const MATCH_LABEL: Record<MatchKind, string> = {
  vinculo: "Vínculo salvo",
  nome_nf: "Nome da nota",
  ean: "Código de barras",
  codigo: "Código do fornecedor",
  apelido: "Nome igual ao apelido",
};

export interface MatchResult {
  product: Product | null;
  kind: MatchKind | null;
  suggestions: Product[];
}

const tokens = (s: string) => new Set(normNfName(s).split(/[^A-Z0-9]+/).filter((t) => t.length > 1));

function similarity(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach((t) => tb.has(t) && inter++);
  return inter / (ta.size + tb.size - inter);
}

/**
 * Ordem de confiança: vínculo já aprendido deste fornecedor → vínculo de
 * qualquer fornecedor → nome da nota igual ao cadastrado → EAN → código do
 * fornecedor → apelido igual. Se nada bater, devolve sugestões parecidas para
 * você escolher (e o sistema aprende o vínculo na importação).
 */
export function matchItem(
  item: InvoiceItemDraft,
  supplierCnpj: string | null,
  products: Product[],
  links: NfLink[],
): MatchResult {
  const goods = products.filter((p) => p.kind === "produto");
  const byId = new Map(goods.map((p) => [p.id, p]));
  const norm = normNfName(item.nf_name);
  const cnpj = onlyDigits(supplierCnpj);

  const pick = (p: Product | undefined, kind: MatchKind): MatchResult | null =>
    p ? { product: p, kind, suggestions: [] } : null;

  return (
    pick(byId.get(links.find((l) => l.nf_name_norm === norm && l.supplier_cnpj === cnpj)?.product_id ?? ""), "vinculo") ??
    pick(byId.get(links.find((l) => l.nf_name_norm === norm)?.product_id ?? ""), "vinculo") ??
    pick(goods.find((p) => p.nf_name && normNfName(p.nf_name) === norm), "nome_nf") ??
    pick(item.ean ? goods.find((p) => p.barcode && onlyDigits(p.barcode) === onlyDigits(item.ean)) : undefined, "ean") ??
    pick(
      item.supplier_code
        ? (byId.get(
            links.find((l) => l.supplier_cnpj === cnpj && l.supplier_code === item.supplier_code)?.product_id ?? "",
          ) ?? goods.find((p) => p.code && p.code === item.supplier_code))
        : undefined,
      "codigo",
    ) ??
    pick(goods.find((p) => normNfName(p.name) === norm), "apelido") ?? {
      product: null,
      kind: null,
      suggestions: goods
        .map((p) => ({ p, s: Math.max(similarity(item.nf_name, p.nf_name ?? ""), similarity(item.nf_name, p.name)) }))
        .filter((x) => x.s >= 0.25)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5)
        .map((x) => x.p),
    }
  );
}
