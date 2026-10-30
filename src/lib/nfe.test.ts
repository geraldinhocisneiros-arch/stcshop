import { describe, expect, test } from "bun:test";
import { effectiveUnitCosts, matchItem, normNfName, parseNfeXml, type InvoiceDraft } from "./nfe";
import type { Product } from "./types";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe35261012345678000199550010000012341000012345" versao="4.00">
<ide><nNF>1234</nNF><serie>1</serie><dhEmi>2026-10-20T10:15:00-03:00</dhEmi></ide>
<emit><CNPJ>12345678000199</CNPJ><xNome>DISTRIBUIDORA ESPORTES &amp; CIA LTDA</xNome></emit>
<det nItem="1"><prod><cProd>WR001</cProd><cEAN>0887768512345</cEAN><xProd>BOLA TENIS WILSON US OPEN TB C/3</xProd><NCM>95066100</NCM><uCom>UN</uCom><qCom>12.0000</qCom><vUnCom>20.0000000000</vUnCom><vProd>240.00</vProd></prod>
<imposto><ICMS><ICMS10><vICMSST>12.00</vICMSST></ICMS10></ICMS><IPI><IPITrib><vIPI>0.00</vIPI></IPITrib></IPI></imposto></det>
<det nItem="2"><prod><cProd>BB77</cProd><cEAN>SEM GTIN</cEAN><xProd>CORDA BABOLAT RPM BLAST 200M</xProd><NCM>95069900</NCM><uCom>RL</uCom><qCom>1.0000</qCom><vUnCom>760.0000000000</vUnCom><vProd>760.00</vProd><vDesc>10.00</vDesc></prod>
<imposto><ICMS><ICMS00/></ICMS></imposto></det>
<total><ICMSTot><vProd>1000.00</vProd><vFrete>50.00</vFrete><vDesc>10.00</vDesc><vOutro>0.00</vOutro><vIPI>0.00</vIPI><vST>12.00</vST><vNF>1052.00</vNF></ICMSTot></total>
</infNFe></NFe><protNFe><infProt><chNFe>35261012345678000199550010000012341000012345</chNFe></infProt></protNFe></nfeProc>`;

describe("parseNfeXml", () => {
  const d = parseNfeXml(XML);
  test("cabeçalho", () => {
    expect(d.access_key).toBe("35261012345678000199550010000012341000012345");
    expect(d.number).toBe("1234");
    expect(d.issue_date).toBe("2026-10-20");
    expect(d.supplier_name).toBe("DISTRIBUIDORA ESPORTES & CIA LTDA");
    expect(d.freight).toBe(50);
    expect(d.total).toBe(1052);
  });
  test("itens", () => {
    expect(d.items).toHaveLength(2);
    expect(d.items[0]).toMatchObject({ supplier_code: "WR001", ean: "0887768512345", qty: 12, unit_price: 20, icms_st: 12 });
    expect(d.items[1].ean).toBeNull(); // "SEM GTIN"
    expect(d.items[1].discount).toBe(10);
  });
  test("rejeita arquivo que não é NF-e", () => {
    expect(() => parseNfeXml("<html></html>")).toThrow();
  });
});

describe("effectiveUnitCosts", () => {
  test("rateia frete do rodapé e soma ST/desconto do item", () => {
    const d = parseNfeXml(XML);
    const [bola, corda] = effectiveUnitCosts(d);
    // bola: (240 + 50*0.24 + 12 ST) / 12 = 22
    expect(bola).toBeCloseTo(22, 4);
    // corda: 760 + 50*0.76 - 10 = 788
    expect(corda).toBeCloseTo(788, 4);
  });
  test("custo total bate com o total da nota", () => {
    const d = parseNfeXml(XML);
    const costs = effectiveUnitCosts(d);
    const sum = costs.reduce((s, c, i) => s + c * d.items[i].qty, 0);
    expect(sum).toBeCloseTo(d.total!, 2);
  });
  test("desconto só no rodapé é rateado", () => {
    const d: InvoiceDraft = {
      access_key: null, number: null, series: null, issue_date: null, supplier_name: null, supplier_cnpj: null,
      total_products: 200, freight: 0, discount: 20, other_costs: 0, ipi: 0, icms_st: 0, total: 180,
      items: [
        { nf_name: "A", supplier_code: null, ean: null, ncm: null, unit: null, qty: 1, unit_price: 100, total: 100, discount: null, freight: null, other: null, ipi: null, icms_st: null },
        { nf_name: "B", supplier_code: null, ean: null, ncm: null, unit: null, qty: 2, unit_price: 50, total: 100, discount: null, freight: null, other: null, ipi: null, icms_st: null },
      ],
    };
    expect(effectiveUnitCosts(d)).toEqual([90, 45]);
  });
});

const prod = (over: Partial<Product>): Product => ({
  id: crypto.randomUUID(), kind: "produto", name: "", nf_name: null, code: null, barcode: null, category: null,
  brand: null, unit: "UN", nf_unit_factor: 1, sale_price: 0, cost_price: 0, last_cost: null, stock_qty: 0,
  min_stock: 0, active: true, notes: null, created_at: "", updated_at: "", ...over,
});

describe("matchItem", () => {
  const bola = prod({ name: "Bola Wilson US Open", nf_name: "Bola Tênis Wilson  US Open TB C/3" });
  const corda = prod({ name: "Corda RPM", barcode: "7891234567890" });
  const grip = prod({ name: "Overgrip Wilson Pro" });
  const items = [bola, corda, grip];
  const base = { supplier_code: null, ean: null, ncm: null, unit: null, qty: 1, unit_price: 1, total: 1, discount: null, freight: null, other: null, ipi: null, icms_st: null };

  test("nome da nota ignora acento, caixa e espaços", () => {
    expect(normNfName(" Bola Tênis  wilson ")).toBe("BOLA TENIS WILSON");
    const r = matchItem({ ...base, nf_name: "BOLA TENIS WILSON US OPEN TB C/3" }, null, items, []);
    expect(r.product?.id).toBe(bola.id);
    expect(r.kind).toBe("nome_nf");
  });
  test("vínculo aprendido tem prioridade", () => {
    const r = matchItem({ ...base, nf_name: "OVERGRIP WLS PRO 3UN" }, "12.345.678/0001-99", items, [
      { product_id: grip.id, nf_name_norm: "OVERGRIP WLS PRO 3UN", supplier_cnpj: "12345678000199", supplier_code: null },
    ]);
    expect(r.product?.id).toBe(grip.id);
    expect(r.kind).toBe("vinculo");
  });
  test("EAN", () => {
    const r = matchItem({ ...base, nf_name: "CORDA XYZ", ean: "7891234567890" }, null, items, []);
    expect(r.product?.id).toBe(corda.id);
  });
  test("sem casamento devolve sugestões", () => {
    const r = matchItem({ ...base, nf_name: "OVERGRIP WILSON PRO OVERGRIP BRANCO" }, null, items, []);
    expect(r.product).toBeNull();
    expect(r.suggestions[0]?.id).toBe(grip.id);
  });
});
