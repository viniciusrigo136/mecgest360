# Integrações, jobs e webhooks

## WhatsApp

**Modo manual (ativo).** Botões abrem `wa.me` com o telefone normalizado e o texto pronto. O sistema registra apenas "conversa aberta" (`contact_log.kind = conversation_opened`). O usuário pode registrar "confirmo que enviei"; entregue/lido nunca são marcados nesse modo.

**Modo automático (pendente de credenciais).** Adaptador da Cloud API oficial em `supabase/functions/_shared/whatsapp.ts`. Para ativar:

1. Conta Meta Business verificada, app no Meta for Developers, número do WhatsApp Business aprovado. Pode haver cobrança por conversa conforme a tabela vigente da Meta — confira antes.
2. Templates aprovados (mensagens iniciadas pela empresa fora da janela de 24 h exigem template). Cadastre o nome aprovado em `message_templates.provider_template_name` (o corpo renderizado vai como 1 parâmetro).
3. Secrets das funções (nunca no frontend):
   ```bash
   npx supabase secrets set WHATSAPP_TOKEN=... WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_APP_SECRET=... WHATSAPP_VERIFY_TOKEN=... WORKER_SECRET=... APP_ORIGIN=https://seu-app
   ```
4. Webhook na Meta: `https://SEU.supabase.co/functions/v1/whatsapp-webhook` com o `WHATSAPP_VERIFY_TOKEN`; assine `messages`.
5. Agende o worker: rode `supabase/setup/cron_worker.sql` no SQL Editor.
6. Em Configurações → Integrações, ative o modo automático (só liberado quando a função informa credenciais presentes).

Verifique a versão atual da Graph API (`WHATSAPP_API_VERSION`, padrão `v21.0`) e as políticas da Meta no momento da ativação. Não usamos automação do WhatsApp Web nem n8n.

## Jobs (pg_cron)

| Job | Quando | O que faz |
| --- | --- | --- |
| `expire-quotes` | 03:15 diário | Marca orçamentos enviados e vencidos como expirados |
| `enqueue-maintenance` | de hora em hora | Modo automático: cria mensagens (idempotentes por ciclo/etapa, agrupadas por cliente). Modo manual: cria tarefas de contato |
| `message-worker` | a cada 5 min (via `cron_worker.sql`) | Reserva com trava, checagem final (consentimento, agendamento, OS aberta, janela), envia e registra |

Execuções ficam em `job_runs` e aparecem em Configurações → Integrações. Job sem `finished_at` indica execução interrompida.

## Webhook — garantias

- Assinatura `X-Hub-Signature-256` validada com o App Secret (comparação em tempo constante).
- `webhook_events (provider, event_id)` único: duplicados são ignorados.
- Status só avança (`pending < processing < accepted < delivered < read`); "failed" depois de "delivered" é ignorado.
- Timeout após possível envio vira `uncertain` e não é reenviado automaticamente.
- Resposta "PARAR/SAIR/STOP" retira o consentimento de lembretes e promoções.

## Fora do escopo / não integrado

Emissão fiscal, conciliação bancária automática, cobrança online (Pix com confirmação), consulta de placa paga, OBD. Recibos são **não fiscais**; Pix é registro manual.
