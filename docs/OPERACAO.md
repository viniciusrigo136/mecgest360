# Operação: ambientes, deploy, backup e monitoramento

## Ambientes

Use **projetos Supabase separados**: `dev/demo` (pode receber `seed-demo.ts`) e `produção` (nunca recebe seed). Variáveis do frontend (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) por ambiente na hospedagem. A service role só em: secrets das Edge Functions e no terminal de quem roda `provision.ts`.

## Deploy

1. Banco: `npx supabase link --project-ref <ref>` e `npx supabase db push`. Migrações são versionadas em `supabase/migrations`; **nunca** rode `db reset` contra produção.
2. Funções: `npx supabase functions deploy` e `npx supabase secrets set APP_ORIGIN=https://seu-app` (+ WhatsApp quando houver).
3. Auth (painel): desativar sign-ups públicos, Site URL e Redirect URLs do app, senha mínima 10, confirmar e-mail. Opcional: SMTP próprio para e-mails de convite (o SMTP padrão do Supabase tem limite baixo).
4. Frontend: `npm run build` e publicar `dist/` (Vercel, Netlify, Cloudflare Pages…). Configure *rewrite* de todas as rotas para `index.html` e cabeçalhos `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex` e `Cache-Control: no-store` para `/portal`.

## Backup e restauração

- O Supabase faz backups diários conforme o plano (Pro: 7 dias; PITR é adicional). **Isto não foi validado neste projeto** — confirme no painel (Database → Backups).
- Arquivos do Storage **não** estão nos backups de banco: exporte os buckets `order-files`, `finance-files` e `workshop-assets` periodicamente (ex.: `rclone` com o protocolo S3 do Supabase).
- Teste de restauração (fazer no projeto de dev, trimestralmente): restaurar backup em um projeto novo → `supabase link` → abrir o app apontando para ele → conferir contagem de OS, saldos de estoque e financeiro. Registre data e resultado aqui.

| Data | Ambiente | Resultado |
| --- | --- | --- |
| — | — | Pendente (depende do plano/provedor) |

## Monitoramento

- Configurações → Integrações mostra `job_runs` (última execução de cada job). Alerta manual: `enqueue-maintenance` sem execução na última hora ou `message-worker` sem `finished_at`.
- Fila: Contatos → Fila de mensagens; itens `failed`/`uncertain` exigem revisão.
- Logs das funções: painel do Supabase → Edge Functions → Logs. Auditoria de negócio: Configurações → Auditoria (separada dos logs).

## Privacidade

O sistema coleta só o necessário (documento é opcional), registra consentimento por finalidade, mascara placa em mensagens e portal, e não registra tokens/senhas na auditoria. Pedidos de exportação/correção/exclusão de dados do cliente devem ser revisados pela oficina (fusão e arquivamento existem; exclusão física não é automática para preservar histórico financeiro). Isto não constitui garantia de conformidade legal (LGPD): a política de retenção deve ser definida e revisada pela oficina.
