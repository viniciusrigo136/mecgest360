# Modelo de dados, permissões e estados

## Entidades (schema `public`)

| Área | Tabelas |
| --- | --- |
| Fundação | `workshops`, `workshop_counters`, `profiles`, `memberships`, `member_permission_overrides`, `permissions`, `role_default_permissions`, `invites`, `audit_log` |
| Clientes/veículos | `clients`, `contact_consents`, `vehicles`, `vehicle_ownerships`, `odometer_readings` |
| Agenda | `resources`, `schedule_blocks`, `appointments`, `service_catalog` |
| OS | `service_orders`, `order_assignments`, `order_status_history`, `order_transitions`, `order_items`, `order_item_costs`, `checklist_templates`, `order_checklists`, `order_attachments`, `order_events`, `time_entries`, `recommendations` (view `order_totals`) |
| Orçamentos/portal | `quotes`, `quote_versions`, `quote_items`, `quote_decisions`, `portal_links` |
| Preventiva/mensagens | `maintenance_plans`, `maintenance_cycles`, `contact_tasks`, `contact_log`, `message_templates`, `message_queue`, `message_queue_cycles`, `message_attempts`, `webhook_events`, `job_runs` |
| Estoque/compras | `products`, `product_costs`, `stock_balances`, `stock_movements`, `stock_reservations`, `inventory_counts`, `inventory_count_items`, `suppliers`, `purchase_orders`, `purchase_order_items`, `purchase_receipts`, `purchase_receipt_items` |
| Financeiro | `accounts`, `account_installments`, `account_payments`, `cash_sessions`, `cash_movements`, `commission_rules`, `commission_entries` |

Funções auxiliares ficam no schema `private` (não exposto pela API). Todo registro de oficina tem `workshop_id`; vínculos usam FK composta `(workshop_id, x_id)`.

## Permissões

Chaves em `public.permissions` (ex.: `orders.view`, `prices.view`, `costs.view`, `payments.refund`, `team.manage`). Resolução: proprietário tem todas → ajuste individual (concede/nega) → padrão do perfil. Negação por padrão.

| Perfil | Padrão resumido |
| --- | --- |
| Proprietário | Tudo |
| Gerente | Operação completa, preços e custos; sem financeiro, equipe, integrações, margens, exportação (concedíveis) |
| Recepção | Clientes, veículos, agenda, OS (todas), orçamentos, preços, contatos e mensagens; sem custos/caixa |
| Mecânico | `orders.view` (escopo: atribuídas), `orders.execute`, preventiva (leitura). Sem preços, custos, clientes, financeiro |
| Financeiro | Contas, pagamentos, estornos, caixa, relatórios financeiros, comissões; identificação mínima das OS |
| Estoquista | Estoque, ajustes, compras, recebimentos, custos; identificação das OS |
| Consulta | Leitura de clientes, veículos, agenda e OS |

Escopo de registros (`memberships.order_scope`) é independente: OS "todas" exige `orders.view_all` **e** escopo `all`; senão só OS em que a pessoa é responsável, atribuída ou dona de um item.

## Estados

**OS** (`order_transitions`): `open → diagnosis → awaiting_approval → approved → in_progress → quality_check → ready → delivered`; `cancelled` é terminal (com motivo). Retornos permitidos: `awaiting_approval → diagnosis`, `in_progress → approved` (pausa), `quality_check/ready → in_progress`. Entrega, cancelamento e reabertura têm RPCs próprias. `parts_pending` é um bloqueio paralelo, não um estado.

**Item da OS**: `pending_approval → approved → in_progress → done | not_done`; `declined`, `cancelled`.

**Orçamento/versão**: `draft → sent → approved | partially_approved | declined | expired`; `superseded` quando nova versão é criada. Versão com `locked_at` é imutável (gatilho).

**Agendamento**: `requested`, `confirmed`, `arrived`, `converted`, `completed`, `cancelled`, `no_show`.

**Ciclo preventivo**: `open → closed | cancelled` (encerrado é imutável). Situação técnica calculada (`cycle_technical_status`): `ok`, `due_soon`, `overdue_date`, `overdue_km` (só com leitura real confirmada após a base), `estimated` (projeção), `awaiting_km`, `completed`, `suspended`, `cancelled`. Situação comercial (`contact_status`): `not_contacted`, `pending`, `contacted`, `responded`, `scheduled`, `postponed`, `refused`, `no_consent`.

**Mensagem**: `pending → processing → accepted → delivered → read`; `failed`, `cancelled`, `uncertain` (revisão manual). Webhook nunca regride (`status_rank`).
