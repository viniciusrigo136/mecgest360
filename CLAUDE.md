# MECANICA PIANA (mecgest360) — guia para o Claude

Sistema de gestão de oficina mecânica. Usuário fala português; responda em português simples, sem jargão.

## Onde está cada coisa
- Site: https://mecgest360.vercel.app (Vercel publica sozinho a cada push na `main`).
- Banco: Supabase na nuvem, projeto `cisdgndwxtnptbvdgbmy` (dados reais da oficina).
- Código: React 19 + TypeScript + Vite + Tailwind 4 + TanStack Query + React Router. Telas em `src/pages`, peças em `src/components`, utilidades em `src/lib`.
- Banco/regras: `supabase/migrations` (RLS em tudo via `private.has_perm`; funções `security definer` com `search_path` fixo; valores em centavos `bigint`). Funções Edge em `supabase/functions`.
- Documentação: `docs/` (IMPLEMENTACAO, MODELO, OPERACAO, MANUAL, INTEGRACOES, ESPECIFICACAO).

## Rodar
- Copie `.env.example` para `.env.local` (só URL e chave publishable; nunca a service_role).
- `npm install`, `npm run dev`, `npm run typecheck`, `npm test` (unitários), `npm run test:db` (banco embutido), `npm run e2e` (Playwright contra Supabase LOCAL via `npx supabase start`; exige Docker).

## Regras
- Nunca rode testes, scripts de limpeza ou seed contra o banco de produção; E2E só no Supabase local.
- Nunca coloque segredos (service_role, senha do banco, tokens) no código, no repositório ou no chat.
- Mudança no banco = nova migration em `supabase/migrations` (não edite as já aplicadas). Aplicar em produção pede confirmação do dono.
- Não apague dados de produção; se precisar, entregue o SQL para o dono rodar.
- Design: estilo TecGest 360 (azul #2563EB, fundo #F8FAFC, cartões brancos, Manrope/Inter), mobile primeiro, poucos campos, tudo na barra lateral.
- Depois de mudar telas, rode `npm run typecheck` e os testes; faça commit e push na `main` só quando o dono pedir.
