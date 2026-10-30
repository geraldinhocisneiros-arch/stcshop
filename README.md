# Squash Tennis Shop — sistema da loja

PDV, estoque, entrada de nota fiscal, encordoamento, fechamento de caixa, relatórios,
inteligência (curva ABC, reposição, promoções) e análise de custos/preço.

Mesma base do `squashtenniscenter`: **TanStack Start + Cloudflare Workers + Supabase**,
com shadcn/ui e Tailwind.

## Telas

| Tela | Quem | O que faz |
|---|---|---|
| Caixa (PDV) | todos | Abre o caixa, vende (busca por apelido, nome da nota, código ou leitor de código de barras), pagamento misto, troco, sangria/suprimento e fechamento. **A baixa no estoque é automática.** |
| Vendas | todos | Histórico e cancelamento (devolve ao estoque; vendedor só cancela no caixa aberto). |
| Encordoamento | todos | Fila de ordens (raquete, corda, tensão, prazo), aviso por WhatsApp e cobrança no caixa. |
| Produtos | todos (edição: admin) | Cadastro com **apelido** + **nome da nota fiscal**, preço, promoção, e análise de margem ao vivo. |
| Estoque | todos (ajuste: admin) | Saldo, valor parado, movimentações, inventário/perda/entrada manual. |
| Notas fiscais | admin | Importa **XML** (exato) ou **PDF/DANFE** (lido pelo Claude). Casa os itens com o cadastro, rateia frete/IPI/ST/desconto, dá entrada e recalcula o custo médio. |
| Fechamentos | todos | Relatório de cada caixa para prestar contas ao dono (imprimir/PDF). |
| Relatórios | admin | Mês: faturamento, ticket, lucro bruto, mais/menos vendidos, por categoria e forma de pagamento. Exporta Excel. |
| Inteligência | admin | Curva ABC (faturamento ou lucro), o que comprar, promoções sugeridas com preço e piso, preços abaixo da meta. |
| Custos e preços | admin | Custos fixos e percentuais, ponto de equilíbrio, simulador de preço, resultado estimado por mês. |
| Configurações | admin | Meta de lucro, parâmetros da inteligência, taxas da maquininha, desconto máximo do vendedor, usuários. |

## Como o custo e o preço são calculados

- **Custo do produto** = custo médio ponderado. Cada nota soma ao estoque e recalcula:
  `(estoque × custo atual + entrada × custo da nota) ÷ estoque novo`.
- **Custo da nota** por item = valor do item + frete + outras despesas + IPI + ICMS-ST − desconto
  (o que vem só no rodapé é rateado pelo valor de cada item).
- **Fator da nota**: 1 unidade na nota pode virar várias no estoque (ex.: rolo de 200 m = 16 sets).
- **Custos variáveis** (% do preço) = impostos/comissões cadastrados + taxa média de cartão (ponderada
  pelo seu mix real de pagamentos).
- **Custo fixo** (% do preço) = custos fixos mensais ÷ faturamento médio dos últimos 3 meses fechados
  (ou o faturamento estimado em Configurações, até existir histórico).
- **Preço sugerido** = custo ÷ (1 − variáveis − fixo − meta de lucro).
- **Equilíbrio** = custo ÷ (1 − variáveis − fixo) → lucro zero.
- **Liquidação** = custo ÷ (1 − variáveis) → não paga o fixo; só para produto parado há muito tempo.

## Instalação

### 1. Supabase

Pode ser um projeto **novo** ou o **mesmo** do squashtenniscenter (todas as tabelas têm prefixo
`shop_`, então não colidem e os logins da academia podem ser reaproveitados).

No SQL Editor do Supabase, rode `supabase/migrations/20261030120000_shop_init.sql`.

### 2. Cloudflare (Worker)

Secrets do Worker `stcshop` (painel do Cloudflare → Workers → stcshop → Settings → Variables, ou
`wrangler secret put`):

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY` — para ler PDF de nota. Sem ela, a importação por XML continua funcionando.

### 3. GitHub Actions

Secrets do repositório: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Cada push na `main` roda os testes, faz o build e publica.

### 4. Primeiro acesso

Na tela de login aparece "Primeiro acesso? Criar a conta do administrador" enquanto a loja não tem
nenhum usuário. Quem entrar primeiro vira administrador; os demais são criados em Configurações.
(Se usar o mesmo Supabase da academia, basta entrar com o login existente.)

Depois: cadastre os **custos**, ajuste as **taxas da maquininha**, crie o serviço
**"Encordoamento"** (tipo Serviço) e importe as notas — os itens da nota viram produtos.

## Desenvolvimento

```bash
bun install
cp .env.example .env.local   # preencha
bun run dev
bun test src/lib             # cálculos (ABC, reposição, promoção, preço, leitura de XML)
```

Testes das regras do banco (venda, estoque, caixa, permissões) num Postgres local:

```bash
createdb shop_test
psql -d shop_test -v ON_ERROR_STOP=1 -f supabase/tests/00_stub_auth.sql -f supabase/migrations/20261030120000_shop_init.sql
psql -d shop_test -f supabase/tests/10_fluxo_admin.sql
psql -d shop_test -f supabase/tests/20_permissoes_vendedor.sql
```
