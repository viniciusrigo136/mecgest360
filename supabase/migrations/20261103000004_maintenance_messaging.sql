-- =====================================================================
-- Fase 3: Manutenção preventiva, contatos, consentimentos e mensagens
-- Princípios: nenhum intervalo universal; km projetado nunca vira
-- "vencido"; agendamento/pagamento não concluem manutenção; envio só
-- após checagem final no servidor; status entregue/lido só do provedor.
-- =====================================================================

create type public.contact_status as enum
  ('not_contacted','pending','contacted','responded','scheduled','postponed','refused','no_consent');

create table public.maintenance_plans (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  vehicle_id uuid not null,
  component text not null,               -- chave (ex.: 'oleo_motor', 'alinhamento')
  component_label text not null,
  action text not null default 'troca' check (action in ('troca','inspecao','avaliacao','limpeza','outro')),
  interval_months int check (interval_months between 0 and 240),
  interval_days int check (interval_days between 0 and 3650),
  interval_km int check (interval_km between 1 and 1000000),
  rule text not null default 'first' check (rule in ('first','date_only','km_only')),
  lead_days int not null default 15 check (lead_days between 0 and 365),
  lead_km int not null default 500 check (lead_km between 0 and 100000),
  source text not null,                  -- fonte da recomendação: manual do fabricante, avaliação do mecânico...
  notes text,
  responsible_membership_id uuid,
  contact_policy text not null default 'auto' check (contact_policy in ('auto','manual','none')),
  use_estimates boolean not null default true,
  status text not null default 'active' check (status in ('active','suspended','cancelled')),
  status_reason text,
  created_from_order uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  unique (workshop_id, id),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id),
  foreign key (workshop_id, responsible_membership_id) references public.memberships(workshop_id, id),
  foreign key (workshop_id, created_from_order) references public.service_orders(workshop_id, id),
  check (rule <> 'km_only' or interval_km is not null),
  check (rule <> 'date_only' or coalesce(interval_months,0) + coalesce(interval_days,0) > 0),
  check (rule <> 'first' or interval_km is not null or coalesce(interval_months,0) + coalesce(interval_days,0) > 0)
);
create index on public.maintenance_plans(vehicle_id, component) where status = 'active';
create trigger trg_mp_touch before update on public.maintenance_plans
  for each row execute function private.touch_updated_at();
create trigger trg_audit_mp after insert or update on public.maintenance_plans
  for each row execute function private.audit_row();

create table public.maintenance_cycles (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null,
  plan_id uuid not null,
  vehicle_id uuid not null,
  seq int not null,
  base_date date not null,               -- data REAL da execução
  base_km int,                           -- km REAL da execução
  base_order_id uuid,
  base_source text not null default 'order' check (base_source in ('order','external','informed','initial')),
  base_confirmed boolean not null default true,
  target_date date,
  target_km int,
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  closed_at timestamptz,
  closed_by_order_id uuid,
  close_kind text check (close_kind in ('executed_here','external','evidence','cancelled')),
  close_evidence text,
  contact_status public.contact_status not null default 'not_contacted',
  contact_postponed_until date,
  auto_contacts_sent int not null default 0,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  unique (plan_id, seq),
  unique (workshop_id, id),
  foreign key (workshop_id, plan_id) references public.maintenance_plans(workshop_id, id),
  foreign key (workshop_id, vehicle_id) references public.vehicles(workshop_id, id),
  foreign key (workshop_id, base_order_id) references public.service_orders(workshop_id, id)
);
create unique index one_open_cycle on public.maintenance_cycles(plan_id) where status = 'open';
create unique index cycle_once_per_order on public.maintenance_cycles(plan_id, base_order_id) where base_order_id is not null;
create index on public.maintenance_cycles(workshop_id, status, target_date);

-- Histórico de ciclos é imutável no que importa
create or replace function private.cycle_guard()
returns trigger language plpgsql as $$
begin
  if old.status <> 'open' and (new.status <> old.status or new.base_date <> old.base_date
      or new.base_km is distinct from old.base_km) then
    raise exception 'Ciclo encerrado é imutável';
  end if;
  if new.base_date <> old.base_date or new.base_km is distinct from old.base_km
     or new.target_date is distinct from old.target_date or new.target_km is distinct from old.target_km then
    raise exception 'Dados do ciclo não podem ser editados; encerre e crie novo ciclo';
  end if;
  return new;
end $$;
create trigger trg_cycle_guard before update on public.maintenance_cycles
  for each row execute function private.cycle_guard();
create trigger trg_audit_cycles after insert or update on public.maintenance_cycles
  for each row execute function private.audit_row();

-- Data alvo: meses somados com regra de fim de mês do PostgreSQL
-- (31/01 + 1 mês = 28/02 ou 29/02 em ano bissexto), depois os dias.
create or replace function public.maintenance_target_date(p_base date, p_months int, p_days int)
returns date language sql immutable as $$
  select case when coalesce(p_months,0) = 0 and coalesce(p_days,0) = 0 then null
    else (p_base + make_interval(months => coalesce(p_months,0)) + make_interval(days => coalesce(p_days,0)))::date end
$$;

create or replace function private.open_cycle(p_plan uuid, p_base_date date, p_base_km int, p_order uuid,
                                              p_source text, p_confirmed boolean default true)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.maintenance_plans; v uuid; n int;
begin
  select * into p from public.maintenance_plans where id = p_plan;
  select coalesce(max(seq),0) + 1 into n from public.maintenance_cycles where plan_id = p_plan;
  insert into public.maintenance_cycles(workshop_id, plan_id, vehicle_id, seq, base_date, base_km, base_order_id, base_source,
     base_confirmed, target_date, target_km)
  values (p.workshop_id, p.id, p.vehicle_id, n, p_base_date, p_base_km, p_order, p_source, p_confirmed,
     case when p.rule <> 'km_only' then public.maintenance_target_date(p_base_date, p.interval_months, p.interval_days) end,
     case when p.rule <> 'date_only' and p_base_km is not null then p_base_km + p.interval_km end)
  returning id into v;
  return v;
end $$;

-- Situação técnica, separada da situação comercial (contact_status)
create or replace function public.cycle_technical_status(p_cycle uuid)
returns table(status text, last_km int, last_km_on date, last_km_source public.km_source, projected_km int,
              km_rate numeric, rate_confidence text, ask_km boolean, days_to_target int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.maintenance_cycles; p public.maintenance_plans; w public.workshops; today date;
        lk record; rt record; proj int; st text; est_ok boolean;
begin
  select * into c from public.maintenance_cycles where id = p_cycle;
  select * into p from public.maintenance_plans where id = c.plan_id;
  select * into w from public.workshops where id = c.workshop_id;
  today := (now() at time zone w.timezone)::date;
  select * into lk from public.vehicle_last_km(c.vehicle_id);
  select * into rt from public.vehicle_km_rate(c.vehicle_id);
  est_ok := p.use_estimates and coalesce((w.reminder_policy->>'km_estimates_enabled')::boolean, true) and rt.km_per_day is not null;
  if est_ok and lk.km is not null then proj := lk.km + round(rt.km_per_day * (today - lk.read_on))::int; end if;

  if c.status = 'closed' then st := 'completed';
  elsif c.status = 'cancelled' or p.status = 'cancelled' then st := 'cancelled';
  elsif p.status = 'suspended' then st := 'suspended';
  elsif p.rule <> 'km_only' and c.target_date is not null and today >= c.target_date then st := 'overdue_date';
  elsif p.rule <> 'date_only' and c.target_km is not null and lk.km is not null and lk.read_on >= c.base_date
        and lk.km >= c.target_km then st := 'overdue_km';                    -- somente leitura REAL confirmada
  elsif p.rule <> 'km_only' and c.target_date is not null and today >= c.target_date - p.lead_days then st := 'due_soon';
  elsif p.rule <> 'date_only' and c.target_km is not null and lk.km is not null and lk.read_on >= c.base_date
        and lk.km >= c.target_km - p.lead_km then st := 'due_soon';
  elsif p.rule <> 'date_only' and c.target_km is not null and proj is not null and proj >= c.target_km - p.lead_km then
        st := 'estimated';                                                    -- retorno estimado, nunca "vencido"
  elsif p.rule = 'km_only' and (lk.km is null or lk.read_on < c.base_date or c.target_km is null) then st := 'awaiting_km';
  else st := 'ok'; end if;

  return query select st, lk.km, lk.read_on, lk.source, proj, rt.km_per_day, rt.confidence,
    (p.rule <> 'date_only' and (lk.km is null or lk.read_on < today - 60 or st = 'estimated')),
    case when c.target_date is not null then c.target_date - today end;
end $$;

-- Criação de plano (template nunca aplicado silenciosamente: o usuário confirma)
create or replace function public.create_maintenance_plan(
  p_vehicle uuid, p_component text, p_component_label text, p_action text, p_interval_months int, p_interval_days int,
  p_interval_km int, p_rule text, p_lead_days int, p_lead_km int, p_source text, p_notes text,
  p_base_date date, p_base_km int, p_order uuid default null, p_contact_policy text default 'auto',
  p_responsible uuid default null, p_base_source text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ws uuid; v_plan uuid;
begin
  select workshop_id into v_ws from public.vehicles where id = p_vehicle;
  perform private.require_perm(v_ws, 'maintenance.edit');
  if coalesce(trim(p_source),'') = '' then raise exception 'Informe a fonte da recomendação do intervalo'; end if;
  if exists (select 1 from public.maintenance_plans where vehicle_id = p_vehicle and component = p_component and status = 'active') then
    raise exception 'Já existe plano ativo para este componente neste veículo';
  end if;
  insert into public.maintenance_plans(workshop_id, vehicle_id, component, component_label, action, interval_months, interval_days,
     interval_km, rule, lead_days, lead_km, source, notes, created_from_order, contact_policy, responsible_membership_id)
  values (v_ws, p_vehicle, p_component, p_component_label, coalesce(p_action,'troca'), nullif(p_interval_months,0),
     nullif(p_interval_days,0), p_interval_km, coalesce(p_rule,'first'), coalesce(p_lead_days,15), coalesce(p_lead_km,500),
     p_source, p_notes, p_order, coalesce(p_contact_policy,'auto'), p_responsible)
  returning id into v_plan;
  perform private.open_cycle(v_plan, coalesce(p_base_date, current_date), p_base_km, p_order,
     coalesce(p_base_source, case when p_order is not null then 'order' else 'initial' end));
  if p_order is not null then
    update public.service_orders set maintenance_decision = 'registered' where id = p_order and maintenance_decision is null;
  end if;
  return v_plan;
end $$;

create or replace function public.set_plan_status(p_plan uuid, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.maintenance_plans;
begin
  select * into p from public.maintenance_plans where id = p_plan for update;
  perform private.require_perm(p.workshop_id, 'maintenance.edit');
  if p_status not in ('active','suspended','cancelled') then raise exception 'Status inválido'; end if;
  if p_status <> 'active' and coalesce(trim(p_reason),'') = '' then raise exception 'Informe o motivo'; end if;
  update public.maintenance_plans set status = p_status, status_reason = p_reason where id = p_plan;
  if p_status = 'cancelled' then
    update public.maintenance_cycles set status = 'cancelled', closed_at = now(), close_kind = 'cancelled',
       close_evidence = p_reason where plan_id = p_plan and status = 'open';
  end if;
  if p_status <> 'active' then
    perform private.cancel_cycle_messages(c.id, 'Plano ' || p_status) from public.maintenance_cycles c where c.plan_id = p_plan;
  end if;
end $$;

-- Cancela fila e tarefas pendentes de um ciclo
create or replace function private.cancel_cycle_messages(p_cycle uuid, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.message_queue m set status = 'cancelled', last_error = p_reason
   where m.status = 'pending' and exists (select 1 from public.message_queue_cycles x where x.message_id = m.id and x.cycle_id = p_cycle)
     and not exists (select 1 from public.message_queue_cycles y join public.maintenance_cycles c on c.id = y.cycle_id
                      where y.message_id = m.id and y.cycle_id <> p_cycle and c.status = 'open');
  update public.contact_tasks set status = 'cancelled', result = p_reason, done_at = now()
   where cycle_id = p_cycle and status = 'open';
end $$;

-- Encerra ciclo e abre o próximo com data/km REAIS. Idempotente por OS.
create or replace function private.close_cycle_and_renew(p_cycle uuid, p_date date, p_km int, p_order uuid, p_kind text,
                                                        p_evidence text, p_confirmed boolean default true)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.maintenance_cycles; p public.maintenance_plans; v uuid;
begin
  select * into c from public.maintenance_cycles where id = p_cycle for update;
  if c.status <> 'open' then return null; end if;
  if p_order is not null and c.base_order_id = p_order then return null; end if;   -- ciclo nasceu desta OS
  select * into p from public.maintenance_plans where id = c.plan_id;
  update public.maintenance_cycles set status = 'closed', closed_at = now(), closed_by_order_id = p_order,
         close_kind = p_kind, close_evidence = p_evidence where id = p_cycle;
  perform private.cancel_cycle_messages(p_cycle, 'Ciclo concluído');
  if p.status = 'active' then
    v := private.open_cycle(p.id, p_date, p_km, p_order, case p_kind when 'executed_here' then 'order' when 'external' then 'external' else 'informed' end,
                            p_confirmed);
  end if;
  return v;
end $$;

-- Chamada na entrega: somente itens EXECUTADOS com componente vinculado
-- explicitamente encerram ciclos (alinhamento não reinicia óleo).
create or replace function private.close_cycles_for_order(p_order uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; r record; v_date date; v_km int;
begin
  select * into o from public.service_orders where id = p_order;
  v_date := (coalesce(o.delivered_at, now()) at time zone (select timezone from public.workshops where id = o.workshop_id))::date;
  v_km := coalesce((select km from public.odometer_readings where order_id = p_order and invalidated_at is null and confirmed
                    order by created_at desc limit 1), o.km_entry);
  for r in
    select distinct c.id from public.order_items i
      join public.maintenance_plans p on p.vehicle_id = o.vehicle_id and p.component = i.maintenance_component and p.status = 'active'
      join public.maintenance_cycles c on c.plan_id = p.id and c.status = 'open'
     where i.order_id = p_order and i.status = 'done' and i.maintenance_component is not null
  loop
    perform private.close_cycle_and_renew(r.id, v_date, v_km, p_order, 'executed_here', 'Executado na OS ' || o.number);
  end loop;
  update public.recommendations set status = 'done', updated_at = now()
   where vehicle_id = o.vehicle_id and status in ('open','scheduled')
     and description in (select description from public.order_items where order_id = p_order and status = 'done');
end $$;

-- Cliente fez em outra oficina: registra origem, sem fabricar OS/receita
create or replace function public.cycle_done_elsewhere(p_cycle uuid, p_date date, p_km int, p_note text, p_confirmed boolean)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.maintenance_cycles;
begin
  select * into c from public.maintenance_cycles where id = p_cycle;
  perform private.require_perm(c.workshop_id, 'maintenance.edit');
  if p_date is null then raise exception 'Informe a data aproximada da execução'; end if;
  if p_km is not null then
    insert into public.odometer_readings(workshop_id, vehicle_id, km, read_on, source, confirmed, regression_justification)
    values (c.workshop_id, c.vehicle_id, p_km, p_date, 'external', p_confirmed, case when not p_confirmed then 'informado pelo cliente' end);
  end if;
  return private.close_cycle_and_renew(p_cycle, p_date, p_km, null, 'external',
     'Feito em outra oficina' || coalesce(': ' || p_note, '') || case when p_confirmed then ' (confirmado)' else ' (a confirmar)' end,
     p_confirmed);
end $$;

create or replace function public.cycle_complete_with_evidence(p_cycle uuid, p_date date, p_km int, p_evidence text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.maintenance_cycles;
begin
  select * into c from public.maintenance_cycles where id = p_cycle;
  perform private.require_perm(c.workshop_id, 'maintenance.edit');
  if coalesce(trim(p_evidence),'') = '' then raise exception 'Evidência obrigatória (ex.: número da OS, foto, nota)'; end if;
  return private.close_cycle_and_renew(p_cycle, p_date, p_km, null, 'evidence', p_evidence);
end $$;

-- ---------------------------------------------------------------------
-- Tarefas e registro de contatos
-- ---------------------------------------------------------------------
create table public.contact_tasks (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  client_id uuid not null,
  vehicle_id uuid,
  cycle_id uuid,
  recommendation_id uuid references public.recommendations(id),
  appointment_id uuid,
  portal_link_id uuid references public.portal_links(id),
  order_id uuid,
  reason text not null,
  notes text,
  due_on date not null default current_date,
  assigned_membership_id uuid,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  result text,
  done_at timestamptz,
  done_by uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id),
  foreign key (workshop_id, cycle_id) references public.maintenance_cycles(workshop_id, id),
  foreign key (workshop_id, assigned_membership_id) references public.memberships(workshop_id, id)
);
create index on public.contact_tasks(workshop_id, status, due_on);
create unique index one_open_task_per_cycle on public.contact_tasks(cycle_id) where status = 'open' and cycle_id is not null;

create table public.contact_log (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  client_id uuid not null,
  cycle_id uuid,
  task_id uuid references public.contact_tasks(id),
  order_id uuid,
  channel text not null check (channel in ('whatsapp','telefone','email','presencial','portal')),
  kind text not null check (kind in ('conversation_opened','manual_sent_confirmed','call','response','note','automatic')),
  message text,
  outcome text,                       -- respondeu, agendou, adiou, recusou, sem resposta, pediu pausa
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id)
);
create index on public.contact_log(client_id, created_at desc);

-- Registra contato/resposta e atualiza situação comercial do ciclo
create or replace function public.log_contact(p_workshop uuid, p_client uuid, p_channel text, p_kind text, p_message text,
   p_outcome text, p_cycle uuid default null, p_task uuid default null, p_postpone_until date default null,
   p_order uuid default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v uuid; v_status public.contact_status;
begin
  perform private.require_perm(p_workshop, 'contacts.edit');
  if not exists (select 1 from public.clients where id = p_client and workshop_id = p_workshop) then
    raise exception 'Cliente inválido'; end if;
  insert into public.contact_log(workshop_id, client_id, cycle_id, task_id, channel, kind, message, outcome, order_id)
  values (p_workshop, p_client, p_cycle, p_task, p_channel, p_kind, left(p_message, 4000), p_outcome, p_order)
  returning id into v;
  if p_cycle is not null then
    v_status := case p_outcome
      when 'agendou' then 'scheduled' when 'adiou' then 'postponed' when 'recusou' then 'refused'
      when 'respondeu' then 'responded' when 'pediu_pausa' then 'refused'
      else case when p_kind in ('conversation_opened','manual_sent_confirmed','call') then 'contacted' end end;
    update public.maintenance_cycles set
      contact_status = coalesce(v_status, contact_status),
      contact_postponed_until = case when p_outcome = 'adiou' then p_postpone_until else contact_postponed_until end,
      last_contact_at = now()
     where id = p_cycle and workshop_id = p_workshop and status = 'open';
    if p_outcome in ('pediu_pausa','recusou') then
      perform private.cancel_cycle_messages(p_cycle, 'Cliente ' || p_outcome);
    end if;
  end if;
  if p_outcome = 'pediu_pausa' then
    insert into public.contact_consents(workshop_id, client_id, purpose, granted, source, notes)
    values (p_workshop, p_client, 'maintenance_reminders', false, p_channel, 'Cliente pediu para parar lembretes');
  end if;
  if p_task is not null and p_outcome is not null then
    update public.contact_tasks set status = 'done', result = p_outcome, done_at = now(), done_by = auth.uid()
     where id = p_task and workshop_id = p_workshop;
  end if;
  return v;
end $$;

-- Retirada de consentimento bloqueia a fila pendente daquela finalidade
create or replace function private.consent_changed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not new.granted then
    update public.message_queue set status = 'cancelled', last_error = 'Consentimento retirado'
     where client_id = new.client_id and purpose = new.purpose and status = 'pending';
    if new.purpose = 'maintenance_reminders' then
      update public.maintenance_cycles c set contact_status = 'no_consent'
        from public.vehicle_ownerships o
       where o.vehicle_id = c.vehicle_id and o.client_id = new.client_id and o.ended_at is null and c.status = 'open';
    end if;
  end if;
  return new;
end $$;
create trigger trg_consent_changed after insert on public.contact_consents
  for each row execute function private.consent_changed();

-- ---------------------------------------------------------------------
-- Templates e fila de mensagens
-- ---------------------------------------------------------------------
create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  key text not null,
  purpose public.contact_purpose not null,
  name text not null,
  body text not null check (length(body) between 10 and 1000),
  provider_template_name text,          -- nome aprovado na API oficial (quando houver)
  provider_template_lang text default 'pt_BR',
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (workshop_id, key)
);

create type public.message_status as enum
  ('pending','processing','accepted','delivered','read','failed','cancelled','uncertain');

create table public.message_queue (
  id uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references public.workshops(id),
  client_id uuid not null,
  purpose public.contact_purpose not null,
  channel text not null default 'whatsapp',
  template_key text not null,
  variables jsonb not null default '{}'::jsonb,
  rendered_body text not null,
  to_phone text not null,
  idempotency_key text not null unique,
  status public.message_status not null default 'pending',
  scheduled_for timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 4,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  locked_by text,
  provider_message_id text unique,
  last_error text,
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (workshop_id, client_id) references public.clients(workshop_id, id)
);
create index on public.message_queue(status, next_attempt_at) where status in ('pending','processing');
create index on public.message_queue(client_id, created_at desc);

create table public.message_queue_cycles (
  message_id uuid not null references public.message_queue(id),
  cycle_id uuid not null references public.maintenance_cycles(id),
  step int not null,
  primary key (message_id, cycle_id),
  unique (cycle_id, step)                 -- idempotência por ciclo/etapa
);

create table public.message_attempts (
  id bigint generated always as identity primary key,
  message_id uuid not null references public.message_queue(id),
  worker text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text,
  http_status int,
  error text
);

create table public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  result text,
  unique (provider, event_id)
);

create table public.job_runs (
  id bigint generated always as identity primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  detail jsonb
);
create index on public.job_runs(job, started_at desc);

create or replace function private.render_template(p_body text, p_vars jsonb)
returns text language plpgsql immutable as $$
declare k text; v text; r text := p_body;
begin
  for k, v in select key, value from jsonb_each_text(p_vars) loop
    r := replace(r, '{' || k || '}', coalesce(v, ''));
  end loop;
  if r ~ '\{[a-z_]+\}' then raise exception 'Variável não preenchida no template: %', substring(r from '\{[a-z_]+\}'); end if;
  return r;
end $$;

create or replace function public.preview_template(p_body text, p_vars jsonb)
returns text language sql immutable as $$ select private.render_template(p_body, p_vars) $$;

-- Janela de envio no fuso da oficina
create or replace function private.in_send_window(p_ws uuid, p_at timestamptz)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare w public.workshops; lt timestamp;
begin
  select * into w from public.workshops where id = p_ws;
  lt := p_at at time zone w.timezone;
  if coalesce((w.reminder_policy->>'business_days_only')::boolean, true) and extract(isodow from lt) > 5 then return false; end if;
  return lt::time >= coalesce(w.reminder_policy->>'window_start','09:00')::time
     and lt::time < coalesce(w.reminder_policy->>'window_end','18:00')::time;
end $$;

-- Elegibilidade comercial de um ciclo para contato (checada no enfileiramento E antes do envio)
create or replace function private.cycle_contact_block_reason(p_cycle uuid)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c public.maintenance_cycles; p public.maintenance_plans; w public.workshops; v_client uuid; st text;
begin
  select * into c from public.maintenance_cycles where id = p_cycle;
  if c.status <> 'open' then return 'ciclo encerrado'; end if;
  select * into p from public.maintenance_plans where id = c.plan_id;
  if p.status <> 'active' then return 'plano não ativo'; end if;
  if p.contact_policy = 'none' then return 'plano sem contato'; end if;
  select * into w from public.workshops where id = c.workshop_id;
  select client_id into v_client from public.vehicle_ownerships where vehicle_id = c.vehicle_id and ended_at is null;
  if v_client is null then return 'veículo sem proprietário atual'; end if;
  if not public.client_consent(v_client, 'maintenance_reminders') then return 'sem consentimento'; end if;
  if c.contact_status in ('scheduled','refused','no_consent') then return 'situação comercial: ' || c.contact_status; end if;
  if c.contact_status = 'postponed' and c.contact_postponed_until > current_date then return 'adiado'; end if;
  if exists (select 1 from public.appointments a where a.vehicle_id = c.vehicle_id and a.status in ('requested','confirmed','arrived')
              and a.starts_at > now()) then return 'cliente já agendado'; end if;
  if exists (select 1 from public.service_orders o where o.vehicle_id = c.vehicle_id
              and o.status not in ('delivered','cancelled')) then return 'veículo com OS em andamento'; end if;
  select status into st from public.cycle_technical_status(p_cycle);
  if st not in ('due_soon','overdue_date','overdue_km','estimated') then return 'fora do prazo de contato (' || st || ')'; end if;
  if c.auto_contacts_sent >= coalesce((w.reminder_policy->>'max_auto_contacts_per_cycle')::int, 2) then return 'limite de contatos automáticos'; end if;
  if c.last_contact_at is not null and c.last_contact_at > now() - make_interval(days => coalesce((w.reminder_policy->>'min_days_between_contacts')::int, 7)) then
    return 'contato recente'; end if;
  return null;
end $$;

-- Job: gera fila (modo automático) ou tarefas de contato (modo manual).
-- Agrupa ciclos do mesmo cliente numa única mensagem.
create or replace function public.enqueue_maintenance_reminders()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_msg uuid; v_body text; n_msg int := 0; n_task int := 0; v_run bigint; v_tpl public.message_templates;
        w public.workshops; v_vars jsonb;
begin
  insert into public.job_runs(job) values ('enqueue_maintenance_reminders') returning id into v_run;
  for r in
    select c.workshop_id, o.client_id, array_agg(c.id) cycles, array_agg(p.component_label) labels,
           min(coalesce(v.brand || ' ','') || v.model) vehicle, min(v.plate_norm) plate,
           bool_and(p.contact_policy = 'auto') all_auto
      from public.maintenance_cycles c
      join public.maintenance_plans p on p.id = c.plan_id
      join public.vehicles v on v.id = c.vehicle_id
      join public.vehicle_ownerships o on o.vehicle_id = c.vehicle_id and o.ended_at is null
     where c.status = 'open' and private.cycle_contact_block_reason(c.id) is null
     group by c.workshop_id, o.client_id
  loop
    select * into w from public.workshops where id = r.workshop_id;
    if w.messaging_mode = 'automatic' and r.all_auto and w.archived_at is null then
      select * into v_tpl from public.message_templates where workshop_id = r.workshop_id and key = 'retorno_preventivo' and active;
      if v_tpl.id is null then continue; end if;
      v_vars := jsonb_build_object('nome', (select split_part(name,' ',1) from public.clients where id = r.client_id),
        'oficina', w.name, 'veiculo', r.vehicle, 'placa', coalesce(left(r.plate,3) || '-**' || right(r.plate,2), ''),
        'servico', array_to_string(r.labels, ', '), 'telefone', coalesce(w.whatsapp, w.phone, ''), 'data', '', 'km', '', 'link', '');
      begin
        v_body := private.render_template(v_tpl.body, v_vars);
      exception when others then continue;
      end;
      begin
        insert into public.message_queue(workshop_id, client_id, purpose, template_key, variables, rendered_body, to_phone,
          idempotency_key, scheduled_for)
        select r.workshop_id, r.client_id, 'maintenance_reminders', 'retorno_preventivo', v_vars, v_body, cl.whatsapp_norm,
          r.workshop_id || ':' || r.client_id || ':' || array_to_string(array(select unnest(r.cycles) order by 1), ',') || ':whatsapp:' ||
          (select coalesce(max(auto_contacts_sent),0) + 1 from public.maintenance_cycles where id = any(r.cycles)), now()
          from public.clients cl where cl.id = r.client_id and cl.whatsapp_norm is not null
        on conflict (idempotency_key) do nothing
        returning id into v_msg;
        if v_msg is not null then
          insert into public.message_queue_cycles(message_id, cycle_id, step)
          select v_msg, c.id, c.auto_contacts_sent + 1 from public.maintenance_cycles c where c.id = any(r.cycles);
          n_msg := n_msg + 1;
        end if;
      exception when unique_violation then null;  -- etapa já enfileirada
      end;
      v_msg := null;
    else
      insert into public.contact_tasks(workshop_id, client_id, vehicle_id, cycle_id, reason, due_on)
      select r.workshop_id, r.client_id, c.vehicle_id, c.id, 'Retorno preventivo: ' || p.component_label, current_date
        from public.maintenance_cycles c join public.maintenance_plans p on p.id = c.plan_id
       where c.id = any(r.cycles)
      on conflict do nothing;
      get diagnostics n_task = row_count;
      update public.maintenance_cycles set contact_status = 'pending' where id = any(r.cycles) and contact_status = 'not_contacted';
    end if;
  end loop;
  update public.job_runs set finished_at = now(), ok = true, detail = jsonb_build_object('messages', n_msg, 'tasks', n_task) where id = v_run;
  return jsonb_build_object('messages', n_msg, 'tasks', n_task);
end $$;

-- Worker: reserva mensagens com trava (dois workers não pegam a mesma)
create or replace function public.claim_messages(p_worker text, p_limit int default 10)
returns setof public.message_queue language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- devolve travas vencidas: o envio PODE ter ocorrido -> 'uncertain' (revisão manual, não reenvia às cegas)
  update public.message_queue set status = 'uncertain', needs_review = true, last_error = 'Trava expirada durante envio'
   where status = 'processing' and locked_until < now();
  return query
  update public.message_queue m set status = 'processing', locked_by = p_worker, locked_until = now() + interval '2 minutes',
         attempts = attempts + 1, updated_at = now()
   where m.id in (select id from public.message_queue
                   where status = 'pending' and next_attempt_at <= now() and scheduled_for <= now()
                   order by next_attempt_at limit p_limit for update skip locked)
  returning m.*;
end $$;

-- Checagem final imediatamente antes de enviar
create or replace function public.message_presend_check(p_message uuid)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.message_queue; reason text; c record;
begin
  select * into m from public.message_queue where id = p_message for update;
  if m.status <> 'processing' then return 'status ' || m.status; end if;
  if not public.client_consent(m.client_id, m.purpose) then reason := 'Consentimento retirado'; end if;
  if reason is null and (select messaging_mode from public.workshops where id = m.workshop_id) <> 'automatic' then
    reason := 'Modo automático desativado'; end if;
  if reason is null then
    for c in select cycle_id from public.message_queue_cycles where message_id = p_message loop
      reason := private.cycle_contact_block_reason(c.cycle_id);
      -- o limite/recência considera o próprio envio em curso
      if reason in ('contato recente','limite de contatos automáticos') then reason := null; end if;
      exit when reason is not null;
    end loop;
  end if;
  if reason is null and not private.in_send_window(m.workshop_id, now()) then
    update public.message_queue set status = 'pending', locked_until = null, attempts = attempts - 1,
           next_attempt_at = now() + interval '30 minutes' where id = p_message;
    return 'fora da janela de envio';
  end if;
  if reason is not null then
    update public.message_queue set status = 'cancelled', last_error = reason, locked_until = null where id = p_message;
    return reason;
  end if;
  insert into public.message_attempts(message_id, worker) values (p_message, m.locked_by);
  return null;
end $$;

create or replace function private.status_rank(s public.message_status)
returns int language sql immutable as $$
  select case s when 'pending' then 0 when 'processing' then 1 when 'uncertain' then 1 when 'failed' then 1
    when 'accepted' then 2 when 'delivered' then 3 when 'read' then 4 else 0 end
$$;

-- Resultado do envio reportado pelo worker
create or replace function public.message_send_result(p_message uuid, p_outcome text, p_provider_id text, p_error text,
                                                     p_http int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.message_queue;
begin
  select * into m from public.message_queue where id = p_message for update;
  update public.message_attempts set finished_at = now(), outcome = p_outcome, error = p_error, http_status = p_http
   where id = (select max(id) from public.message_attempts where message_id = p_message);
  if p_outcome = 'accepted' then
    update public.message_queue set status = case when private.status_rank(status) > 2 then status else 'accepted' end,
           provider_message_id = p_provider_id, locked_until = null, last_error = null where id = p_message;
    update public.maintenance_cycles c set auto_contacts_sent = auto_contacts_sent + 1, last_contact_at = now(),
           contact_status = case when contact_status in ('not_contacted','pending') then 'contacted' else contact_status end
      from public.message_queue_cycles x where x.message_id = p_message and x.cycle_id = c.id;
    insert into public.contact_log(workshop_id, client_id, channel, kind, message, outcome, cycle_id)
    select m.workshop_id, m.client_id, 'whatsapp', 'automatic', m.rendered_body, 'aceito pelo provedor', x.cycle_id
      from public.message_queue_cycles x where x.message_id = p_message limit 1;
  elsif p_outcome = 'uncertain' then
    update public.message_queue set status = 'uncertain', needs_review = true, last_error = p_error, locked_until = null where id = p_message;
  elsif p_outcome = 'retry' and m.attempts < m.max_attempts then
    update public.message_queue set status = 'pending', last_error = p_error, locked_until = null,
           next_attempt_at = now() + make_interval(mins => (power(4, m.attempts))::int) where id = p_message;
  else
    update public.message_queue set status = 'failed', needs_review = true, last_error = p_error, locked_until = null where id = p_message;
  end if;
end $$;

-- Webhook do provedor: tolera duplicidade e fora de ordem, não regride
create or replace function public.apply_provider_status(p_provider text, p_event_id text, p_provider_message_id text,
                                                       p_status text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_new public.message_status; m public.message_queue;
begin
  begin
    insert into public.webhook_events(provider, event_id, payload) values (p_provider, p_event_id, p_payload);
  exception when unique_violation then return 'duplicado';
  end;
  v_new := case p_status when 'sent' then 'accepted' when 'delivered' then 'delivered' when 'read' then 'read'
                         when 'failed' then 'failed' else null end;
  select * into m from public.message_queue where provider_message_id = p_provider_message_id for update;
  if m.id is null or v_new is null then
    update public.webhook_events set processed_at = now(), result = 'ignorado' where provider = p_provider and event_id = p_event_id;
    return 'ignorado';
  end if;
  if v_new = 'failed' and private.status_rank(m.status) < 3 then
    update public.message_queue set status = 'failed', needs_review = true, last_error = coalesce(p_payload->>'error','falha reportada pelo provedor')
     where id = m.id;
  elsif private.status_rank(v_new) > private.status_rank(m.status) then
    update public.message_queue set status = v_new, updated_at = now() where id = m.id;
  end if;
  update public.webhook_events set processed_at = now(), result = 'aplicado' where provider = p_provider and event_id = p_event_id;
  return 'aplicado';
end $$;

-- Resposta recebida pelo provedor com comando de parada
create or replace function public.apply_inbound_message(p_provider text, p_event_id text, p_from text, p_text text, p_payload jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare cl record;
begin
  begin
    insert into public.webhook_events(provider, event_id, payload) values (p_provider, p_event_id, p_payload);
  exception when unique_violation then return 'duplicado';
  end;
  for cl in select id, workshop_id from public.clients where whatsapp_norm = private.norm_phone(p_from) loop
    insert into public.contact_log(workshop_id, client_id, channel, kind, message, outcome)
    values (cl.workshop_id, cl.id, 'whatsapp', 'response', left(p_text, 2000), 'respondeu');
    if private.norm_text(trim(p_text)) in ('parar','pare','sair','stop','cancelar') then
      insert into public.contact_consents(workshop_id, client_id, purpose, granted, source, notes, recorded_by)
      values (cl.workshop_id, cl.id, 'maintenance_reminders', false, 'mensagem', 'Comando PARAR', null),
             (cl.workshop_id, cl.id, 'promotions', false, 'mensagem', 'Comando PARAR', null);
    else
      insert into public.contact_tasks(workshop_id, client_id, reason, notes)
      values (cl.workshop_id, cl.id, 'Cliente respondeu mensagem automática', left(p_text, 500));
    end if;
  end loop;
  update public.webhook_events set processed_at = now(), result = 'aplicado' where provider = p_provider and event_id = p_event_id;
  return 'aplicado';
end $$;

-- Revisão manual de envio incerto/falho
create or replace function public.review_message(p_message uuid, p_action text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.message_queue;
begin
  select * into m from public.message_queue where id = p_message for update;
  perform private.require_perm(m.workshop_id, 'messages.send');
  if p_action = 'retry' and m.status in ('failed','uncertain') then
    update public.message_queue set status = 'pending', needs_review = false, next_attempt_at = now(), attempts = 0,
      last_error = 'Reenvio autorizado: ' || coalesce(p_note,'') where id = p_message;
  elsif p_action = 'mark_sent' and m.status = 'uncertain' then
    update public.message_queue set status = 'accepted', needs_review = false, last_error = 'Confirmado manualmente: ' || coalesce(p_note,'')
     where id = p_message;
  elsif p_action = 'cancel' then
    update public.message_queue set status = 'cancelled', needs_review = false, last_error = coalesce(p_note,'Cancelado') where id = p_message
       and status in ('pending','failed','uncertain');
  else raise exception 'Ação inválida para o status atual'; end if;
end $$;

revoke execute on function public.enqueue_maintenance_reminders(), public.claim_messages(text, int),
  public.message_presend_check(uuid), public.message_send_result(uuid, text, text, text, int),
  public.apply_provider_status(text, text, text, text, jsonb), public.apply_inbound_message(text, text, text, text, jsonb)
  from public, anon, authenticated;

-- Painel preventivo
create or replace function public.maintenance_board(p_workshop uuid, p_tech_status text[] default null,
   p_contact_status public.contact_status[] default null, p_component text default null, p_responsible uuid default null,
   p_due_within_days int default null, p_limit int default 100, p_offset int default 0)
returns table(cycle_id uuid, plan_id uuid, vehicle_id uuid, vehicle_label text, plate text, client_id uuid, client_name text,
              client_whatsapp text, component text, component_label text, action text, rule text, base_date date, base_km int,
              target_date date, target_km int, tech_status text, last_km int, last_km_on date, last_km_source public.km_source,
              projected_km int, rate_confidence text, ask_km boolean, days_to_target int, contact_status public.contact_status,
              contact_postponed_until date, last_contact_at timestamptz, block_reason text, responsible uuid, total_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  with b as (
    select c.*, p.component, p.component_label, p.action, p.rule, p.responsible_membership_id,
           coalesce(v.brand || ' ','') || v.model vlabel, coalesce(v.plate, v.internal_code) vplate,
           cl.id clid, cl.name clname, cl.whatsapp_norm clwa, ts.status tstatus, ts.last_km, ts.last_km_on, ts.last_km_source,
           ts.projected_km, ts.rate_confidence, ts.ask_km, ts.days_to_target
      from public.maintenance_cycles c
      join public.maintenance_plans p on p.id = c.plan_id
      join public.vehicles v on v.id = c.vehicle_id
      left join public.vehicle_ownerships o on o.vehicle_id = c.vehicle_id and o.ended_at is null
      left join public.clients cl on cl.id = o.client_id
      cross join lateral public.cycle_technical_status(c.id) ts
     where c.workshop_id = p_workshop and c.status = 'open' and private.has_perm(p_workshop, 'maintenance.view')
       and (p_component is null or p.component = p_component)
       and (p_responsible is null or p.responsible_membership_id = p_responsible)
  )
  select b.id, b.plan_id, b.vehicle_id, b.vlabel, b.vplate, b.clid,
         case when private.has_perm(p_workshop,'clients.view') then b.clname else split_part(b.clname,' ',1) end,
         case when private.has_perm(p_workshop,'contacts.view') then b.clwa end,
         b.component, b.component_label, b.action, b.rule, b.base_date, b.base_km, b.target_date, b.target_km,
         b.tstatus, b.last_km, b.last_km_on, b.last_km_source, b.projected_km, b.rate_confidence, b.ask_km, b.days_to_target,
         b.contact_status, b.contact_postponed_until, b.last_contact_at, private.cycle_contact_block_reason(b.id),
         b.responsible_membership_id, count(*) over ()
    from b
   where (p_tech_status is null or b.tstatus = any(p_tech_status))
     and (p_contact_status is null or b.contact_status = any(p_contact_status))
     and (p_due_within_days is null or b.days_to_target <= p_due_within_days)
   order by case b.tstatus when 'overdue_km' then 0 when 'overdue_date' then 1 when 'due_soon' then 2 when 'estimated' then 3
            when 'awaiting_km' then 4 else 5 end, b.target_date nulls last
   limit p_limit offset p_offset
$$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.maintenance_plans enable row level security;
alter table public.maintenance_cycles enable row level security;
alter table public.contact_tasks enable row level security;
alter table public.contact_log enable row level security;
alter table public.message_templates enable row level security;
alter table public.message_queue enable row level security;
alter table public.message_queue_cycles enable row level security;
alter table public.message_attempts enable row level security;
alter table public.webhook_events enable row level security;
alter table public.job_runs enable row level security;

create policy mp_select on public.maintenance_plans for select to authenticated using (private.has_perm(workshop_id,'maintenance.view'));
create policy mp_update on public.maintenance_plans for update to authenticated
  using (private.has_perm(workshop_id,'maintenance.edit')) with check (private.has_perm(workshop_id,'maintenance.edit'));
create policy mc_select on public.maintenance_cycles for select to authenticated using (private.has_perm(workshop_id,'maintenance.view'));
create policy ctk_select on public.contact_tasks for select to authenticated using (private.has_perm(workshop_id,'contacts.view'));
create policy ctk_insert on public.contact_tasks for insert to authenticated with check (private.has_perm(workshop_id,'contacts.edit'));
create policy ctk_update on public.contact_tasks for update to authenticated
  using (private.has_perm(workshop_id,'contacts.edit')) with check (private.has_perm(workshop_id,'contacts.edit'));
create policy clog_select on public.contact_log for select to authenticated using (private.has_perm(workshop_id,'contacts.view'));
create policy mt_select on public.message_templates for select to authenticated using (private.has_perm(workshop_id,'contacts.view'));
create policy mt_write on public.message_templates for all to authenticated
  using (private.has_perm(workshop_id,'settings.manage')) with check (private.has_perm(workshop_id,'settings.manage'));
create policy mq_select on public.message_queue for select to authenticated using (private.has_perm(workshop_id,'messages.send'));
create policy jr_select on public.job_runs for select to authenticated using (
  exists (select 1 from public.memberships m where m.user_id = auth.uid() and m.status = 'active'
          and private.member_has_perm(m.id, 'integrations.manage')));
