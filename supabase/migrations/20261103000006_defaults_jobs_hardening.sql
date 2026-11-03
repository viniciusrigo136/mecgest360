-- =====================================================================
-- Padrões por oficina, jobs agendados e endurecimento de privilégios
-- =====================================================================

create or replace function private.seed_workshop_defaults(p_ws uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.checklist_templates(workshop_id, kind, name, items) values
  (p_ws, 'entry', 'Entrada padrão', '[
    {"key":"lataria","label":"Lataria (riscos, amassados)"},
    {"key":"vidros","label":"Vidros e retrovisores"},
    {"key":"pneus","label":"Pneus e estepe"},
    {"key":"luzes","label":"Luzes e painel"},
    {"key":"interior","label":"Interior e bancos"},
    {"key":"acessorios","label":"Acessórios (som, tapetes, macaco, chave de roda)"},
    {"key":"objetos","label":"Objetos deixados no veículo"}]'::jsonb),
  (p_ws, 'quality', 'Controle de qualidade padrão', '[
    {"key":"itens","label":"Itens executados conferidos"},
    {"key":"vazamentos","label":"Sem vazamentos após serviço"},
    {"key":"teste","label":"Teste de rodagem / funcionamento"},
    {"key":"painel","label":"Sem luzes de alerta no painel"},
    {"key":"limpeza","label":"Veículo limpo (volante, bancos, tapetes)"},
    {"key":"pecas_trocadas","label":"Peças substituídas separadas para o cliente (se solicitado)"}]'::jsonb);

  insert into public.message_templates(workshop_id, key, purpose, name, body) values
  (p_ws, 'lembrete_agendamento', 'appointment_reminders', 'Lembrete de agendamento',
   'Olá, {nome}! Aqui é da {oficina}. Lembrando do seu horário em {data} para o {veiculo}. Se precisar remarcar, responda esta mensagem ou ligue {telefone}.'),
  (p_ws, 'orcamento_disponivel', 'service_updates', 'Orçamento disponível',
   'Olá, {nome}! O orçamento do seu {veiculo} está disponível: {link} . Qualquer dúvida, fale com a {oficina} pelo {telefone}.'),
  (p_ws, 'veiculo_pronto', 'service_updates', 'Veículo pronto',
   'Olá, {nome}! Seu {veiculo} está pronto para retirada na {oficina}. Acompanhe: {link}'),
  (p_ws, 'status_os', 'service_updates', 'Atualização da OS',
   'Olá, {nome}! Atualização do seu {veiculo} na {oficina}: acompanhe em {link}'),
  (p_ws, 'solicitar_km', 'maintenance_reminders', 'Pedido de quilometragem',
   'Olá, {nome}! Aqui é da {oficina}. Para acompanhar a manutenção do seu {veiculo}, pode nos informar a quilometragem atual?'),
  (p_ws, 'retorno_preventivo', 'maintenance_reminders', 'Retorno preventivo',
   'Olá, {nome}! Aqui é da {oficina}. Pela data do último atendimento, está chegando o período previsto para conferir a manutenção do seu {veiculo} ({servico}). Qual a quilometragem atual? Assim verificamos se já é hora de agendar. Para não receber estes avisos, responda PARAR.'),
  (p_ws, 'pos_atendimento', 'post_service', 'Pós-atendimento',
   'Olá, {nome}! Obrigado por confiar na {oficina}. Como está o seu {veiculo} após o serviço? Se notar qualquer coisa, fale com a gente: {telefone}.')
  on conflict (workshop_id, key) do nothing;

  insert into public.resources(workshop_id, name, kind) values (p_ws, 'Box 1', 'box'), (p_ws, 'Box 2', 'box'), (p_ws, 'Elevador 1', 'elevador');
end $$;

create or replace function public.provision_workshop(p_name text, p_owner_user uuid, p_is_demo boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid;
begin
  if not exists (select 1 from auth.users where id = p_owner_user) then raise exception 'Usuário proprietário inexistente'; end if;
  insert into public.workshops(name, is_demo) values (p_name, p_is_demo) returning id into v_ws;
  insert into public.memberships(workshop_id, user_id, role) values (v_ws, p_owner_user, 'owner');
  insert into public.workshop_counters(workshop_id, kind, prefix) values
    (v_ws,'order','OS-'),(v_ws,'quote','ORC-'),(v_ws,'purchase','PC-'),(v_ws,'receipt','REC-'),(v_ws,'vehicle_tmp','TMP-')
  on conflict do nothing;
  perform private.seed_workshop_defaults(v_ws);
  return v_ws;
end $$;
revoke execute on function public.provision_workshop(text, uuid, boolean) from public, anon, authenticated;

-- Mecânico convidado começa restrito às OS atribuídas
create or replace function private.invite_scope_default()
returns trigger language plpgsql as $$
begin
  if new.role = 'mechanic' and new.order_scope = 'all' and not (new.overrides ? 'orders.view_all') then
    new.order_scope := 'assigned';
  end if;
  return new;
end $$;
create trigger trg_invite_scope before insert on public.invites for each row execute function private.invite_scope_default();

-- ---------------------------------------------------------------------
-- Endurecimento: anon só executa as RPCs públicas do portal/convite
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from anon, public;
grant execute on function public.portal_view(text), public.portal_decide(text, text, uuid[], text, boolean),
  public.portal_report_km(text, int), public.portal_request(text, text, text), public.portal_stop_reminders(text),
  public.invite_info(text), public.preview_template(text, jsonb) to anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function public.provision_workshop(text, uuid, boolean), public.expire_quotes(),
  public.enqueue_maintenance_reminders(), public.claim_messages(text, int), public.message_presend_check(uuid),
  public.message_send_result(uuid, text, text, text, int), public.apply_provider_status(text, text, text, text, jsonb),
  public.apply_inbound_message(text, text, text, text, jsonb), public.portal_photo_path(text, uuid)
  from authenticated;
grant execute on all functions in schema public to service_role;

revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon, public;
alter default privileges in schema public revoke all on tables from anon;

-- Tabelas somente-RPC: impede escrita direta mesmo para autenticados
revoke insert, update, delete on public.memberships, public.member_permission_overrides, public.invites, public.audit_log,
  public.workshop_counters, public.service_orders, public.order_items, public.order_item_costs, public.order_assignments,
  public.order_status_history, public.order_checklists, public.time_entries, public.appointments, public.quotes,
  public.quote_versions, public.quote_items, public.quote_decisions, public.portal_links, public.maintenance_cycles,
  public.message_queue, public.message_queue_cycles, public.message_attempts, public.webhook_events, public.job_runs,
  public.stock_balances, public.stock_movements, public.stock_reservations, public.product_costs, public.purchase_orders,
  public.purchase_order_items, public.purchase_receipts, public.purchase_receipt_items, public.accounts,
  public.account_installments, public.account_payments, public.cash_sessions, public.cash_movements,
  public.commission_entries, public.contact_log, public.permissions, public.role_default_permissions, public.order_transitions
  from authenticated;
revoke delete on all tables in schema public from authenticated;

-- ---------------------------------------------------------------------
-- Jobs (pg_cron). O worker HTTP de mensagens é configurado em
-- supabase/setup/cron_worker.sql (exige URL e segredo do projeto).
-- ---------------------------------------------------------------------
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('expire-quotes', '15 3 * * *', 'select public.expire_quotes()');
    perform cron.schedule('enqueue-maintenance', '0 * * * *', 'select public.enqueue_maintenance_reminders()');
  else
    raise notice 'pg_cron indisponível neste ambiente: jobs não agendados';
  end if;
end
$do$;
