# MecGest 360

Sistema web de gestão para oficina mecânica: clientes, veículos, agenda, ordens de serviço, orçamentos com aprovação segura, manutenção preventiva com retorno de clientes, estoque, compras, financeiro, relatórios e portal do cliente. Interface em português do Brasil, valores em reais e datas no fuso da oficina.

**Stack:** React 19 + TypeScript + Vite + Tailwind 4 + TanStack Query, e Supabase (PostgreSQL com RLS, Auth, Storage, Edge Functions e pg_cron).

## Documentação

| Documento | Conteúdo |
| --- | --- |
| [docs/ESPECIFICACAO.md](docs/ESPECIFICACAO.md) | Especificação original (preservada) |
| [docs/IMPLEMENTACAO.md](docs/IMPLEMENTACAO.md) | Decisões, checklist de requisitos e checkpoint de continuidade |
| [docs/MODELO.md](docs/MODELO.md) | Modelo de dados, permissões, estados de OS/orçamento/manutenção |
| [docs/INTEGRACOES.md](docs/INTEGRACOES.md) | WhatsApp, jobs, webhooks e o que depende de terceiros |
| [docs/OPERACAO.md](docs/OPERACAO.md) | Deploy, ambientes, backup/restauração e monitoramento |
| [docs/MANUAL.md](docs/MANUAL.md) | Manual breve por perfil |

## Rodar localmente

Pré-requisitos: Node 22+ e um projeto Supabase (nuvem).

```bash
npm install
cp .env.example .env.local      # preencha URL e chave anon/publishable do projeto
npm run dev                     # http://localhost:5173
```

### Aplicar o banco no Supabase

```bash
npx supabase login
npx supabase link --project-ref SEU_PROJECT_REF
npx supabase db push            # aplica supabase/migrations
npx supabase functions deploy   # publica as Edge Functions
```

No painel do Supabase (Authentication → Settings): **desative cadastro público** (sign-ups), defina a *Site URL* do app e as *Redirect URLs* (`https://seu-app/**`), e mínimo de 10 caracteres de senha. Veja [docs/OPERACAO.md](docs/OPERACAO.md).

### Criar a oficina e o proprietário inicial

Não existe senha padrão. O proprietário recebe um e-mail para definir a própria senha. Rode **no seu terminal** (a service role nunca vai para o navegador nem para o repositório):

```bash
SUPABASE_URL=https://SEU.supabase.co SUPABASE_SERVICE_ROLE_KEY=... APP_URL=http://localhost:5173 npx tsx scripts/provision.ts --nome "Minha Oficina" --email dono@exemplo.com --nome-dono "Seu Nome"
```

### Ambiente de demonstração (dados fictícios)

Use um projeto Supabase **separado** do de produção:

```bash
ALLOW_DEMO_SEED=sim SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... npx tsx scripts/seed-demo.ts
```

Cria duas oficinas fictícias (a segunda para testar isolamento), usuários de cada perfil com senhas aleatórias (salvas em `.tmp/demo-credentials.txt`, fora do git) e dados de exemplo criados pelas mesmas funções usadas pelo app.

## Testes

```bash
npm run lint        # oxlint
npm run typecheck   # TypeScript
npm test            # testes unitários (formatação, dinheiro, fuso, CSV seguro, WhatsApp)
npm run test:db     # integração no PostgreSQL embutido: RLS, RPCs e critérios de aceite
npm run build
```

`test:db` sobe um PostgreSQL real a partir do pacote `@embedded-postgres` (sem Docker), aplica todas as migrações sobre uma simulação mínima dos esquemas `auth`/`storage` do Supabase e executa os cenários da seção 18 da especificação como usuários reais (papel `authenticated`, JWT simulado).
