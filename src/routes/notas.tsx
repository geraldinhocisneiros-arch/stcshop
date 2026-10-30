import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { ProductDialog, type ProductPrefill } from "@/components/ProductDialog";
import { ProductPicker } from "@/components/ProductPicker";
import { SupplierPicker } from "@/components/SupplierPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { extractInvoicePdf, invoiceAiAvailable } from "@/lib/invoice.functions";
import { fileToBase64, photoToJpeg } from "@/lib/image";
import { errMsg, loadCostStructure, loadProducts, loadSettings, loadSuppliers } from "@/lib/data";
import { fmtBRL, fmtDate, fmtNum, fmtPct, isoDay, parseDecimal, round2 } from "@/lib/format";
import {
  effectiveUnitCosts,
  MATCH_LABEL,
  onlyDigits,
  matchItem,
  parseNfeXml,
  type InvoiceDraft,
  type MatchKind,
  type NfLink,
} from "@/lib/nfe";
import { analyzePrice, type CostStructure } from "@/lib/pricing";
import { supplierLabel, type Product, type ShopSettings, type Supplier } from "@/lib/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { AlertTriangle, Camera, FileUp, Keyboard, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";

export const Route = createFileRoute("/notas")({
  head: () => ({ meta: [{ title: "Notas fiscais — Squash Tennis Shop" }] }),
  component: NotasPage,
});

interface Row {
  key: string;
  /** item que veio de uma nota já lançada (edição) */
  saved?: boolean;
  productId: string | null;
  matchKind: MatchKind | null;
  suggestions: Product[];
}

interface InvoiceListItem {
  id: string;
  supplier_id: string | null;
  number: string | null;
  supplier_name: string | null;
  issue_date: string | null;
  total: number | null;
  source: string;
  created_at: string;
}

function NotasPage() {
  const readInvoice = useServerFn(extractInvoicePdf);
  const checkAi = useServerFn(invoiceAiAvailable);
  const [aiAvailable, setAiAvailable] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Array<{ base64: string; preview: string }>>([]);
  const [preparing, setPreparing] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [links, setLinks] = useState<NfLink[]>([]);
  const [settings, setSettings] = useState<ShopSettings | null>(null);
  const [cs, setCs] = useState<CostStructure | null>(null);
  const [history, setHistory] = useState<InvoiceListItem[]>([]);
  const [draft, setDraft] = useState<(InvoiceDraft & { source: Source; supplier_id?: string | null }) | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // na edição: quanto a nota original pôs no estoque, por produto (para a prévia partir do saldo sem ela)
  const [original, setOriginal] = useState<Record<string, { qty: number; value: number }>>({});
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingFor, setCreatingFor] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, l, s, h, sup] = await Promise.all([
        loadProducts(),
        supabase.from("shop_product_nf_links").select("product_id, nf_name_norm, supplier_cnpj, supplier_code"),
        loadSettings(),
        supabase.from("shop_invoices").select("id, supplier_id, number, supplier_name, issue_date, total, source, created_at").order("created_at", { ascending: false }).limit(100),
        loadSuppliers(),
      ]);
      setSuppliers(sup);
      setProducts(p);
      setLinks((l.data ?? []) as NfLink[]);
      setSettings(s);
      setHistory((h.data ?? []) as InvoiceListItem[]);
      setCs((await loadCostStructure(s)).cs);
      return { products: p, links: (l.data ?? []) as NfLink[] };
    } catch (e) {
      toast.error(errMsg(e));
      return null;
    }
  }, []);
  useEffect(() => {
    load();
    checkAi()
      .then((r) => setAiAvailable(r.available))
      .catch(() => setAiAvailable(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const startReview = (d: InvoiceDraft, source: Source, prods = products, lks = links) => {
    if (!d.items.length) return toast.error("Nenhum item encontrado na nota");
    const cnpj = onlyDigits(d.supplier_cnpj);
    const sup = cnpj ? suppliers.find((x) => x.cnpj === cnpj) : undefined;
    setEditingId(null);
    setDraft({ ...d, source, supplier_id: sup?.id ?? null });
    setRows(
      d.items.map((it) => {
        const m = matchItem(it, d.supplier_cnpj, prods, lks);
        return { key: crypto.randomUUID(), productId: m.product?.id ?? null, matchKind: m.kind, suggestions: m.suggestions };
      }),
    );
  };

  // Nota digitada à mão: começa vazia, você escolhe os produtos e informa quantidade e valor.
  const startManual = () => {
    setDraft({
      access_key: null,
      number: null,
      series: null,
      issue_date: isoDay(new Date()),
      supplier_name: null,
      supplier_cnpj: null,
      total_products: null,
      freight: 0,
      discount: 0,
      other_costs: 0,
      ipi: 0,
      icms_st: 0,
      pis: 0,
      approx_taxes: 0,
      total: null,
      items: [emptyItem()],
      source: "manual",
      supplier_id: null,
    });
    setEditingId(null);
    setRows([emptyRow()]);
  };

  const addItem = () => {
    if (!draft) return;
    setDraft({ ...draft, items: [...draft.items, emptyItem()] });
    setRows((rs) => [...rs, emptyRow()]);
  };

  const removeItem = (i: number) => {
    if (!draft || draft.items.length <= 1) return;
    setDraft({ ...draft, items: draft.items.filter((_, j) => j !== i) });
    setRows((rs) => rs.filter((_, j) => j !== i));
  };

  const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);

  const onFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (fileRef.current) fileRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
    if (!files.length) return;

    // fotos: vão se acumulando (uma nota pode ter várias páginas) até você mandar ler
    if (files.every(isImage)) {
      if (!aiAvailable) return toast.error("A leitura de foto está desligada. Use o XML da nota ou digite a nota.");
      setPreparing(true);
      try {
        const converted = await Promise.all(files.map((f) => photoToJpeg(f)));
        setPhotos((ps) => [...ps, ...converted].slice(0, 10));
      } catch (e) {
        toast.error(errMsg(e));
      } finally {
        setPreparing(false);
      }
      return;
    }
    if (files.length > 1) return toast.error("Envie um PDF ou XML por vez (fotos podem ser várias)");

    const file = files[0];
    const isXml = file.name.toLowerCase().endsWith(".xml") || file.type.includes("xml");
    if (!isXml && !aiAvailable) return toast.error("A leitura de PDF está desligada. Use o XML da nota ou digite a nota.");
    setReading(true);
    try {
      if (file.name.toLowerCase().endsWith(".xml") || file.type.includes("xml")) {
        startReview(parseNfeXml(await file.text()), "xml");
      } else if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        const d = await readInvoice({ data: { files: [{ data: await fileToBase64(file), mediaType: "application/pdf" }] } });
        startReview(d, "pdf");
      } else {
        toast.error("Envie o XML, o PDF ou fotos da nota");
      }
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setReading(false);
    }
  };

  const readPhotos = async () => {
    setReading(true);
    try {
      const d = await readInvoice({ data: { files: photos.map((p) => ({ data: p.base64, mediaType: "image/jpeg" as const })) } });
      startReview(d, "foto");
      setPhotos([]);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setReading(false);
    }
  };

  const costs = useMemo(() => (draft ? effectiveUnitCosts(draft) : []), [draft]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const check = useMemo(() => {
    if (!draft) return null;
    const itemsSum = round2(draft.items.reduce((s, i) => s + i.total, 0));
    const lineErrors = draft.items.filter((i) => Math.abs(round2(i.qty * i.unit_price) - i.total) > 0.05).length;
    const totalCost = round2(costs.reduce((s, c, i) => s + c * draft.items[i].qty, 0));
    return {
      itemsSum,
      productsOk: draft.total_products == null || Math.abs(itemsSum - draft.total_products) <= 0.05,
      lineErrors,
      totalCost,
      totalOk: draft.total == null || Math.abs(totalCost - draft.total) <= 0.5,
    };
  }, [draft, costs]);

  const setItem = (i: number, patch: Partial<InvoiceDraft["items"][number]>) => {
    if (!draft) return;
    const items = draft.items.map((it, j) => {
      if (j !== i) return it;
      const n = { ...it, ...patch };
      if ("qty" in patch || "unit_price" in patch) n.total = round2(n.qty * n.unit_price);
      return n;
    });
    setDraft({ ...draft, items });
  };
  const setHeader = (k: keyof InvoiceDraft) => (e: React.ChangeEvent<HTMLInputElement>) => {
    if (draft) setDraft({ ...draft, [k]: e.target.value });
  };
  // campos numéricos só são lidos ao sair do campo, para não atrapalhar a digitação ("12," etc.)
  const numHeader = (k: keyof InvoiceDraft) => ({
    defaultValue: dec(draft?.[k] as number | null),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => draft && setDraft({ ...draft, [k]: parseDecimal(e.target.value) }),
  });

  const unmatched = rows.filter((r) => !r.productId).length;

  const doSave = async () => {
    if (!draft) return;
    if (unmatched) return toast.error(`Ainda há ${unmatched} item(ns) sem produto`);
    if (draft.items.some((it) => !(it.qty > 0))) return toast.error("Todo item precisa ter quantidade maior que zero");
    const header = {
      access_key: draft.access_key,
      number: draft.number,
      series: draft.series,
      supplier_id: draft.supplier_id ?? null,
      supplier_name: draft.supplier_name,
      supplier_cnpj: draft.supplier_cnpj,
      issue_date: draft.issue_date,
      total_products: draft.total_products,
      freight: draft.freight,
      discount: draft.discount,
      other_costs: draft.other_costs,
      ipi: draft.ipi,
      icms_st: draft.icms_st,
      pis: draft.pis,
      approx_taxes: draft.approx_taxes,
      total: draft.total,
      source: draft.source === "foto" ? "pdf" : draft.source, // fotos ficam registradas como leitura por IA
    };
    const items = draft.items.map((it, i) => ({
      product_id: rows[i].productId,
      // nota digitada sem descrição: registra com o nome do produto e não cria vínculo
      nf_name: it.nf_name.trim() || byId.get(rows[i].productId!)?.nf_name || byId.get(rows[i].productId!)?.name || "",
      supplier_code: it.supplier_code,
      ean: it.ean,
      unit: it.unit,
      ncm: it.ncm,
      nf_qty: it.qty,
      nf_unit_price: it.unit_price,
      discount: it.discount,
      freight: it.freight,
      other: it.other,
      ipi: it.ipi,
      icms_st: it.icms_st,
      unit_cost_nf: costs[i],
      remember: !!it.nf_name.trim(),
    }));
    setSaving(true);
    const { error } = editingId
      ? await supabase.rpc("shop_update_invoice", { p_invoice_id: editingId, p_header: header, p_items: items })
      : await supabase.rpc("shop_import_invoice", { p_header: header, p_items: items });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success(editingId ? "Nota corrigida — estoque e custos recalculados" : "Nota importada — estoque e custos atualizados");
    closeDraft();
    load();
  };

  const closeDraft = () => {
    setDraft(null);
    setRows([]);
    setEditingId(null);
    setOriginal({});
  };

  // Abre uma nota já lançada para corrigir
  const openInvoice = async (id: string) => {
    const [inv, its] = await Promise.all([
      supabase.from("shop_invoices").select("*").eq("id", id).single(),
      supabase.from("shop_invoice_items").select("*").eq("invoice_id", id),
    ]);
    if (inv.error) return toast.error(inv.error.message);
    const h = inv.data as any;
    const list = (its.data ?? []) as any[];
    setDraft({
      access_key: h.access_key,
      number: h.number,
      series: h.series,
      issue_date: h.issue_date,
      supplier_name: h.supplier_name,
      supplier_cnpj: h.supplier_cnpj,
      supplier_id: h.supplier_id,
      total_products: h.total_products,
      freight: Number(h.freight ?? 0),
      discount: Number(h.discount ?? 0),
      other_costs: Number(h.other_costs ?? 0),
      ipi: Number(h.ipi ?? 0),
      icms_st: Number(h.icms_st ?? 0),
      pis: Number(h.pis ?? 0),
      approx_taxes: Number(h.approx_taxes ?? 0),
      total: h.total,
      source: h.source === "xml" ? "xml" : h.source === "manual" ? "manual" : "pdf",
      items: list.map((it) => ({
        nf_name: it.nf_name ?? "",
        supplier_code: it.supplier_code,
        ean: it.ean,
        ncm: it.ncm,
        unit: it.unit,
        qty: Number(it.nf_qty),
        unit_price: Number(it.nf_unit_price),
        total: round2(Number(it.nf_qty) * Number(it.nf_unit_price)),
        discount: it.item_discount,
        freight: it.item_freight,
        other: it.item_other,
        ipi: it.item_ipi,
        icms_st: it.item_icms_st,
      })),
    });
    setRows(list.map((it) => ({ key: crypto.randomUUID(), saved: true, productId: it.product_id, matchKind: null, suggestions: [] })));
    const orig: Record<string, { qty: number; value: number }> = {};
    for (const it of list) {
      const o = (orig[it.product_id] ??= { qty: 0, value: 0 });
      o.qty += Number(it.stock_qty);
      o.value += Number(it.stock_qty) * Number(it.unit_cost);
    }
    setOriginal(orig);
    setEditingId(id);
    window.scrollTo({ top: 0 });
  };

  const deleteInvoice = async () => {
    if (!editingId) return;
    if (!window.confirm("Excluir esta nota? A entrada no estoque será desfeita e o custo médio recalculado.")) return;
    setSaving(true);
    const { error } = await supabase.rpc("shop_delete_invoice", { p_invoice_id: editingId });
    setSaving(false);
    if (error) return toast.error(error.message);
    toast.success("Nota excluída — entrada desfeita no estoque");
    closeDraft();
    load();
  };

  const target = (settings?.target_margin_pct ?? 0) / 100;
  const creatingItem = creatingFor !== null && draft ? draft.items[creatingFor] : null;
  const prefill: ProductPrefill | undefined = creatingItem
    ? {
        name: creatingItem.nf_name,
        nf_name: creatingItem.nf_name,
        code: creatingItem.supplier_code,
        barcode: creatingItem.ean,
        unit: creatingItem.unit ?? "UN",
        cost_price: costs[creatingFor!],
      }
    : undefined;

  return (
    <AppLayout title="Notas fiscais de entrada" adminOnly>
      {!draft ? (
        <div className="space-y-6">
          <Card>
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <FileUp className="h-10 w-10 text-primary" />
              <div className="font-medium">Importar nota de compra</div>
              <p className="max-w-lg text-sm text-muted-foreground">
                {aiAvailable ? (
                  <>
                    Envie o <b>XML</b> da NF-e (leitura exata), o <b>PDF</b> do DANFE ou <b>fotos</b> da nota tiradas no celular
                    (lidos por IA), ou digite a nota. Você revisa tudo antes de dar entrada no estoque.
                  </>
                ) : (
                  <>
                    Envie o <b>XML</b> da NF-e (leitura exata e gratuita) ou <b>digite a nota</b>. Não tem o XML? Peça ao seu
                    contador: ele costuma ter o XML de todas as notas emitidas para o CNPJ da loja.
                  </>
                )}
              </p>
              <input
                ref={fileRef}
                type="file"
                multiple
                accept={aiAvailable ? ".pdf,.xml,application/pdf,text/xml,application/xml,image/*" : ".xml,text/xml,application/xml"}
                className="hidden"
                onChange={(e) => onFiles(e.target.files)}
              />
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onFiles(e.target.files)} />
              {reading ? (
                <div className="flex items-center gap-2 py-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" /> Lendo a nota… pode levar até 1 minuto
                </div>
              ) : (
                <div className="flex flex-wrap justify-center gap-2">
                  {aiAvailable && (
                    <Button size="lg" disabled={preparing} onClick={() => cameraRef.current?.click()}>
                      <Camera className="mr-2 h-4 w-4" /> {photos.length ? "Tirar mais uma foto" : "Tirar foto da nota"}
                    </Button>
                  )}
                  <Button size="lg" variant={aiAvailable ? "outline" : "default"} disabled={preparing} onClick={() => fileRef.current?.click()}>
                    <FileUp className="mr-2 h-4 w-4" /> {aiAvailable ? "Escolher arquivo" : "Importar XML"}
                  </Button>
                  <Button size="lg" variant="outline" disabled={preparing} onClick={startManual}>
                    <Keyboard className="mr-2 h-4 w-4" /> Digitar nota
                  </Button>
                </div>
              )}
              {preparing && <div className="text-xs text-muted-foreground">Preparando foto…</div>}
              {photos.length > 0 && (
                <div className="w-full max-w-2xl space-y-3 pt-2">
                  <div className="flex flex-wrap justify-center gap-2">
                    {photos.map((p, i) => (
                      <div key={i} className="relative">
                        <img src={p.preview} alt={`Foto ${i + 1}`} className="h-28 w-20 rounded-md border object-cover" />
                        <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-xs text-white">{i + 1}</span>
                        <button
                          className="absolute -right-2 -top-2 rounded-full bg-destructive p-1 text-white"
                          onClick={() => setPhotos((ps) => ps.filter((_, j) => j !== i))}
                          aria-label="Remover foto"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <Button size="lg" className="w-full" disabled={reading || preparing} onClick={readPhotos}>
                    Ler nota ({photos.length} {photos.length === 1 ? "foto" : "fotos"})
                  </Button>
                </div>
              )}
              {aiAvailable && (
              <ul className="max-w-lg list-disc space-y-0.5 pl-5 text-left text-xs text-muted-foreground">
                <li>Nota apoiada numa mesa, foto de cima, com boa luz e sem sombra do celular.</li>
                <li>A nota inteira no quadro. Se a lista de itens for longa, tire em partes com um pedaço repetido entre elas.</li>
                <li>Nota de mais de uma página: uma foto por página, antes de tocar em "Ler nota".</li>
              </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Notas importadas</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Emissão</TableHead>
                    <TableHead>Número</TableHead>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((h) => (
                    <TableRow key={h.id} className="cursor-pointer" onClick={() => openInvoice(h.id)}>
                      <TableCell>{fmtDate(h.issue_date ?? h.created_at)}</TableCell>
                      <TableCell>{h.number ?? "—"}</TableCell>
                      <TableCell>
                        {(() => {
                          const sup = suppliers.find((x) => x.id === h.supplier_id);
                          return sup ? supplierLabel(sup) : (h.supplier_name ?? "—");
                        })()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{h.source.toUpperCase()}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{fmtBRL(h.total)}</TableCell>
                      <TableCell className="text-right">
                        <Pencil className="ml-auto h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))}
                  {history.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                        Nenhuma nota importada ainda.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                {editingId ? "Corrigir nota já lançada" : "Revisar nota"} <Badge variant="outline">{SOURCE_LABEL[draft.source]}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-4">
              <div className="space-y-1 md:col-span-2">
                <Label className="text-xs">Fornecedor</Label>
                <SupplierPicker
                  suppliers={suppliers}
                  value={draft.supplier_id ?? null}
                  fallbackName={draft.supplier_id ? null : draft.supplier_name}
                  onCreated={(sup) => setSuppliers((ss) => [...ss, sup])}
                  onChange={(sup) =>
                    setDraft({
                      ...draft,
                      supplier_id: sup?.id ?? null,
                      supplier_name: sup?.name ?? draft.supplier_name,
                      supplier_cnpj: sup?.cnpj ?? draft.supplier_cnpj,
                    })
                  }
                />
                {!draft.supplier_id && draft.supplier_cnpj && (
                  <p className="text-xs text-muted-foreground">Não cadastrado — será cadastrado ao salvar a nota.</p>
                )}
              </div>
              <Field label="CNPJ" value={draft.supplier_cnpj ?? ""} onChange={setHeader("supplier_cnpj")} />
              <Field label="Número" value={draft.number ?? ""} onChange={setHeader("number")} />
              <Field label="Série" value={draft.series ?? ""} onChange={setHeader("series")} />
              <Field label="Emissão" type="date" value={draft.issue_date ?? ""} onChange={setHeader("issue_date")} />
              <Field label="Chave de acesso" value={draft.access_key ?? ""} onChange={setHeader("access_key")} className="md:col-span-2" />
              <Field label="Frete" {...numHeader("freight")} />
              <Field label="Desconto" {...numHeader("discount")} />
              <Field label="Outras despesas" {...numHeader("other_costs")} />
              <Field label="IPI" {...numHeader("ipi")} />
              <Field label="ICMS ST" {...numHeader("icms_st")} />
              <Field label="Total produtos (nota)" {...numHeader("total_products")} />
              <Field label="Total da nota" {...numHeader("total")} />
              <Field label="PIS" {...numHeader("pis")} />
              <Field label="Valor aprox. dos tributos" {...numHeader("approx_taxes")} />
              <p className="self-end text-xs text-muted-foreground md:col-span-2">
                PIS e tributos aproximados são só informativos: já estão no preço do fornecedor e não entram no custo do produto.
              </p>
            </CardContent>
          </Card>

          {check && (!check.productsOk || check.lineErrors > 0 || !check.totalOk || !!draft.warnings?.length) && (
            <div className="flex gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 text-warning-foreground" />
              <div>
                <b>Confira antes de importar:</b>
                {draft.warnings?.map((w, i) => (
                  <div key={i}>Leitura duvidosa — {w}</div>
                ))}
                {!check.productsOk && (
                  <div>
                    Soma dos itens ({fmtBRL(check.itemsSum)}) é diferente do total de produtos da nota ({fmtBRL(draft.total_products)}) — pode
                    ter faltado ou sobrado item.
                  </div>
                )}
                {check.lineErrors > 0 && <div>{check.lineErrors} item(ns) com quantidade × unitário diferente do total da linha.</div>}
                {!check.totalOk && (
                  <div>
                    Custo total calculado ({fmtBRL(check.totalCost)}) difere do total da nota ({fmtBRL(draft.total)}). Verifique frete,
                    IPI, ST e desconto.
                  </div>
                )}
              </div>
            </div>
          )}

          <Card>
            <CardContent className="overflow-x-auto p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-64">Item da nota</TableHead>
                    <TableHead className="w-28 text-right">Qtd na nota</TableHead>
                    <TableHead className="w-28 text-right">Valor unit. na nota</TableHead>
                    <TableHead className="text-right" title="Valor unitário + frete, IPI, ICMS-ST e outras despesas − desconto, rateados">
                      Custo real
                    </TableHead>
                    <TableHead className="min-w-64">Produto no sistema</TableHead>
                    <TableHead className="min-w-48">Efeito</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draft.items.map((it, i) => {
                    const r = rows[i];
                    const p = r?.productId ? byId.get(r.productId) : undefined;
                    const factor = p?.nf_unit_factor ?? 1;
                    const addQty = it.qty * factor;
                    const unitCost = costs[i] / factor;
                    // saldo e custo "antes desta nota" (na edição, tira o que a versão original lançou)
                    const o = editingId && p ? original[p.id] : undefined;
                    const baseQty = p ? Number(p.stock_qty) - (o?.qty ?? 0) : 0;
                    const baseCost =
                      p && o ? (baseQty > 0 ? Math.max(0, (p.stock_qty * p.cost_price - o.value) / baseQty) : p.cost_price) : (p?.cost_price ?? 0);
                    const newCost = p && baseQty > 0 ? (baseQty * baseCost + addQty * unitCost) / (baseQty + addQty) : unitCost;
                    const pa = p && cs ? analyzePrice(p.sale_price, newCost, cs, target) : null;
                    return (
                      <TableRow key={r?.key ?? i} className={cn(!p && "bg-destructive/5")}>
                        <TableCell>
                          <Input
                            className="h-8 text-xs"
                            value={it.nf_name}
                            placeholder={draft.source === "manual" ? "Descrição na nota (opcional)" : undefined}
                            onChange={(e) => setItem(i, { nf_name: e.target.value })}
                          />
                          <div className="mt-1 text-xs text-muted-foreground">
                            {it.supplier_code && `cód. ${it.supplier_code}`} {it.ean && `· EAN ${it.ean}`} {it.unit && `· ${it.unit}`}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Input className="h-8 text-right" defaultValue={dec(it.qty)} onBlur={(e) => setItem(i, { qty: parseDecimal(e.target.value) })} />
                          {p && factor !== 1 && (
                            <div className="mt-1 text-right text-xs text-muted-foreground">
                              × {fmtNum(factor, 3)} = {fmtNum(addQty, 2)} {p.unit}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Input
                            className="h-8 text-right"
                            defaultValue={dec(it.unit_price)}
                            onBlur={(e) => setItem(i, { unit_price: parseDecimal(e.target.value) })}
                          />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtBRL(costs[i])}
                          {p && factor !== 1 && (
                            <div className="text-xs text-muted-foreground">
                              {fmtBRL(unitCost)} por {p.unit}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <ProductPicker
                              products={products.filter((x) => x.kind === "produto")}
                              value={r?.productId ?? null}
                              suggestions={r?.suggestions}
                              onChange={(id) =>
                                setRows(rows.map((x, j) => (j === i ? { ...x, productId: id, matchKind: null, saved: false } : x)))
                              }
                            />
                            <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" title="Criar produto" onClick={() => setCreatingFor(i)}>
                              <Plus className="h-4 w-4" />
                            </Button>
                          </div>
                          <div className="mt-1 text-xs">
                            {r?.matchKind ? (
                              <span className="text-success">✓ {MATCH_LABEL[r.matchKind]}</span>
                            ) : p && r?.saved ? (
                              <span className="text-muted-foreground">Lançado nesta nota</span>
                            ) : p ? (
                              <span className="text-muted-foreground">Escolhido manualmente — será memorizado</span>
                            ) : (
                              <span className="text-destructive">Sem produto: escolha ou crie</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {p && (
                            <>
                              <div>
                                {o ? "Sem a nota: " : ""}
                                {fmtNum(baseQty, 2)} + {fmtNum(addQty, 2)} {p.unit} → <b>{fmtNum(baseQty + addQty, 2)}</b>
                              </div>
                              <div>
                                Custo {fmtBRL(baseCost)} → <b>{fmtBRL(newCost)}</b>
                              </div>
                              {pa && pa.status !== "sem_custo" && (
                                <div
                                  className={cn(
                                    pa.status === "prejuizo" && "font-semibold text-destructive",
                                    pa.status === "abaixo_meta" && "text-warning-foreground",
                                  )}
                                >
                                  Lucro a {fmtBRL(p.sale_price)}: {fmtPct(pa.netMargin)}
                                  {pa.status !== "ok" && ` · sugerido ${fmtBRL(pa.suggestedPrice)}`}
                                </div>
                              )}
                            </>
                          )}
                        </TableCell>
                        <TableCell>
                          {draft.items.length > 1 && (
                            <Button size="icon" variant="ghost" className="h-8 w-8" title="Remover item" onClick={() => removeItem(i)}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="border-t p-2">
                <Button size="sm" variant="ghost" onClick={addItem}>
                  <Plus className="mr-1 h-4 w-4" /> Adicionar item
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="mr-auto text-sm text-muted-foreground">
              {draft.items.length} itens · custo total {fmtBRL(check?.totalCost)}
              {unmatched > 0 && <span className="text-destructive"> · {unmatched} sem produto</span>}
            </span>
            {editingId && (
              <Button variant="ghost" className="text-destructive" onClick={deleteInvoice} disabled={saving}>
                <Trash2 className="mr-1 h-4 w-4" /> Excluir nota
              </Button>
            )}
            <Button variant="outline" onClick={closeDraft}>
              {editingId ? "Cancelar" : "Descartar"}
            </Button>
            <Button onClick={doSave} disabled={saving || unmatched > 0}>
              {saving ? "Salvando…" : editingId ? "Salvar correção" : "Dar entrada no estoque"}
            </Button>
          </div>
        </div>
      )}

      <ProductDialog
        open={creatingFor !== null}
        onOpenChange={(v) => !v && setCreatingFor(null)}
        prefill={prefill}
        cs={cs}
        targetMargin={target}
        allowInitialStock={false}
        onSaved={async (p) => {
          const idx = creatingFor;
          await load();
          if (idx !== null) setRows((rs) => rs.map((x, j) => (j === idx ? { ...x, productId: p.id, matchKind: null } : x)));
          setProducts((ps) => (ps.some((x) => x.id === p.id) ? ps : [...ps, p]));
        }}
      />
    </AppLayout>
  );
}

type Source = "pdf" | "xml" | "foto" | "manual";

const SOURCE_LABEL: Record<Source, string> = {
  xml: "XML",
  pdf: "Lida do PDF por IA",
  foto: "Lida da foto por IA",
  manual: "Digitada",
};

const emptyItem = (): InvoiceDraft["items"][number] => ({
  nf_name: "",
  supplier_code: null,
  ean: null,
  ncm: null,
  unit: null,
  qty: 1,
  unit_price: 0,
  total: 0,
  discount: null,
  freight: null,
  other: null,
  ipi: null,
  icms_st: null,
});

const emptyRow = (): Row => ({ key: crypto.randomUUID(), productId: null, matchKind: null, suggestions: [] });

const dec = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v).replace(".", ","));

function Field({
  label,
  className,
  ...props
}: { label: string; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label className="text-xs">{label}</Label>
      <Input className="h-8" {...props} />
    </div>
  );
}
