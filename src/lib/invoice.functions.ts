import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { getServerSecret } from "@/lib/server-env";
import type { InvoiceDraft } from "@/lib/nfe";

const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export interface InvoiceFile {
  data: string; // base64 sem prefixo
  mediaType: "application/pdf" | ImageType;
}

const PROMPT = `Este material é um DANFE (nota fiscal eletrônica brasileira) de compra de mercadorias de uma loja de artigos de tênis e squash.
Pode vir como PDF ou como fotos tiradas no celular. Várias fotos são páginas ou partes da MESMA nota: junte tudo numa nota só e não repita itens que aparecem em duas fotos.
Extraia os dados da nota para dar entrada no estoque.

Regras:
- "nf_name": copie a descrição do produto EXATAMENTE como impressa (mesmas palavras, abreviações e números). É usada para casar com o cadastro, então não corrija, não traduza e não complete.
- Se a descrição continuar na linha de baixo dentro do mesmo item, junte numa só.
- "qty", "unit_price" e "total" são as colunas QUANT/QTD, V.UNIT/VL. UNIT e V.TOTAL/VL. TOTAL do item. Números em formato decimal com ponto (1.234,56 vira 1234.56).
- "discount", "ipi" e "icms_st" do item: preencha só se a coluna existir para aquele item; caso contrário null.
- Totais do rodapé ("CÁLCULO DO IMPOSTO"): valor total dos produtos, frete, desconto, outras despesas, IPI, ICMS ST (valor do ICMS substituição) e valor total da nota. Use 0 quando o campo existir e estiver zerado.
- "access_key": os 44 dígitos da chave de acesso, sem espaços.
- "issue_date" no formato AAAA-MM-DD.
- Liste TODOS os itens, em todas as páginas, na ordem da nota. Não invente itens.
- "reading_notes": se algum número ou descrição estiver borrado, cortado ou ilegível, dê seu melhor palpite no campo e explique aqui, em português curto, qual item/campo ficou duvidoso (ex.: "Item 3: quantidade pouco legível"). Se estiver tudo legível, deixe a lista vazia.`;

/** Diz se a leitura por IA está ligada (se há ANTHROPIC_API_KEY no Cloudflare). */
export const invoiceAiAvailable = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({ available: !!(await getServerSecret("ANTHROPIC_API_KEY")) }));

/**
 * Lê o PDF ou as fotos de uma nota fiscal com o Claude e devolve os dados estruturados.
 * Nada é gravado aqui: a tela mostra o resultado para revisão antes de dar
 * entrada no estoque.
 */
export const extractInvoicePdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { files: InvoiceFile[] }) => {
    const files = input?.files ?? [];
    if (files.length === 0) throw new Error("Nenhum arquivo enviado");
    if (files.length > MAX_FILES) throw new Error(`Envie no máximo ${MAX_FILES} fotos por nota`);
    for (const f of files) {
      if (!f?.data) throw new Error("Arquivo vazio");
      if (f.mediaType !== "application/pdf" && !IMAGE_TYPES.includes(f.mediaType as ImageType))
        throw new Error("Formato não suportado: envie PDF, JPG, PNG ou WEBP");
    }
    if (files.reduce((t, f) => t + f.data.length * 0.75, 0) > MAX_TOTAL_BYTES) throw new Error("Arquivos maiores que 20 MB no total");
    return { files };
  })
  .handler(async ({ data, context }): Promise<InvoiceDraft> => {
    const { data: isAdmin } = await context.supabase.rpc("shop_is_admin");
    if (!isAdmin) throw new Error("Só o administrador importa notas");

    const apiKey = await getServerSecret("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY não configurada no Cloudflare. Enquanto isso, importe pelo XML da nota.",
      );
    }

    const [{ default: Anthropic }, { betaZodOutputFormat }, { z }] = await Promise.all([
      import("@anthropic-ai/sdk"),
      import("@anthropic-ai/sdk/helpers/beta/zod"),
      import("zod/v4"),
    ]);

    const money = z.number().nullable();
    const Item = z.object({
      nf_name: z.string(),
      supplier_code: z.string().nullable(),
      ean: z.string().nullable(),
      ncm: z.string().nullable(),
      unit: z.string().nullable(),
      qty: z.number(),
      unit_price: z.number(),
      total: z.number(),
      discount: money,
      ipi: money,
      icms_st: money,
    });
    const Invoice = z.object({
      access_key: z.string().nullable(),
      number: z.string().nullable(),
      series: z.string().nullable(),
      issue_date: z.string().nullable(),
      supplier_name: z.string().nullable(),
      supplier_cnpj: z.string().nullable(),
      total_products: money,
      freight: money,
      discount: money,
      other_costs: money,
      ipi: money,
      icms_st: money,
      total: money,
      items: z.array(Item),
      reading_notes: z.array(z.string()),
    });

    const client = new Anthropic({ apiKey });
    let response;
    try {
      response = await client.beta.messages.parse({
        model: "claude-opus-5-5",
        max_tokens: 16000,
        output_config: { effort: "medium", format: betaZodOutputFormat(Invoice) },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [
          {
            role: "user",
            content: [
              ...data.files.map((f) =>
                f.mediaType === "application/pdf"
                  ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } } as const)
                  : ({ type: "image", source: { type: "base64", media_type: f.mediaType as ImageType, data: f.data } } as const),
              ),
              { type: "text", text: PROMPT },
            ],
          },
        ],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new Error("Chave da Anthropic inválida");
      if (err instanceof Anthropic.RateLimitError)
        throw new Error("Limite de uso da IA atingido — tente de novo em instantes");
      if (err instanceof Anthropic.APIError)
        throw new Error(`Falha ao ler a nota (${err.status ?? "rede"}): ${err.message}`);
      throw err;
    }

    if (response.stop_reason === "refusal") throw new Error("A IA não conseguiu processar este arquivo");
    if (response.stop_reason === "max_tokens")
      throw new Error("Nota grande demais para ler de uma vez — use o XML da nota");
    const out = response.parsed_output;
    if (!out) throw new Error("Não consegui interpretar a nota. Tente o XML.");

    return {
      access_key: out.access_key?.replace(/\D/g, "") || null,
      number: out.number,
      series: out.series,
      issue_date: out.issue_date,
      supplier_name: out.supplier_name,
      supplier_cnpj: out.supplier_cnpj?.replace(/\D/g, "") || null,
      total_products: out.total_products,
      freight: out.freight ?? 0,
      discount: out.discount ?? 0,
      other_costs: out.other_costs ?? 0,
      ipi: out.ipi ?? 0,
      icms_st: out.icms_st ?? 0,
      total: out.total,
      warnings: out.reading_notes.filter((n) => n.trim()),
      items: out.items.map((i) => ({
        ...i,
        ean: i.ean && /^\d{8,14}$/.test(i.ean) ? i.ean : null,
        freight: null,
        other: null,
      })),
    };
  });
