# Squash Tennis Shop — instruções para o Claude

## Fluxo de PR (regra do dono)

- **Todo PR vai direto para a `main`.** Nunca abra PR para outro branch `claude/*` ou intermediário.
- Antes de abrir o PR, atualize o branch com a `main` atual (`git fetch origin main` e rebase/merge) e resolva conflitos localmente.
- Antes do PR, rode: `npx tsc --noEmit`, `npx vite build` e `bun test src/lib`.
- Só faça merge quando o dono pedir.
- Só diga que algo está "pronto" ou "no ar" depois que o merge na `main` aconteceu **e** o workflow "Deploy to Cloudflare" (`.github/workflows/deploy.yml`, roda a cada push na `main`) terminou com sucesso.
