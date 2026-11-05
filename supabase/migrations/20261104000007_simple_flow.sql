-- =====================================================================
-- Fluxo simples (estilo ChapGest): menos passos para o mecânico.
-- - "Pronto para entrega" em um toque (finish_service)
-- - "Entregar o carro" respondendo só "como foi pago?" (deliver_simple)
-- - checklist de qualidade só obrigatório se a oficina quiser
-- - dinheiro pode ser recebido sem caixa aberto (o caixa é opcional)
-- - começar o serviço direto, sem passar por diagnóstico/aprovação formal
-- - resumo do dia e indicadores do período
-- =====================================================================

alter table public.workshops add column if not exists require_quality_check boolean not null default false;

insert into public.order_transitions values
  ('open','in_progress','orders.execute'),
  ('diagnosis','in_progress','orders.execute'),
  ('awaiting_approval','in_progress','orders.execute'),
  ('in_progress','ready','orders.execute')
on conflict do nothing;

create or replace function public.order_transition(p_order uuid, p_to public.order_status, p_reason text default null,
                                                  p_expected_version int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; t public.order_transitions; q public.order_checklists; n int;
begin
  o := private.require_order(p_order, null);
  select * into o from public.service_orders where id = p_order for update;
  if p_expected_version is not null and o.version <> p_expected_version then
    raise exception 'OS alterada por outra pessoa. Recarregue.' using errcode = '40001';
  end if;
  if p_to in ('delivered','cancelled') then raise exception 'Use a ação própria de entrega/cancelamento'; end if;
  select * into t from public.order_transitions where from_status = o.status and to_status = p_to;
  if t.from_status is null then
    raise exception 'Transição não permitida: % → %', o.status, p_to using errcode = 'P0005';
  end if;
  perform private.require_perm(o.workshop_id, t.permission);

  if p_to = 'in_progress' then
    if not exists (select 1 from public.order_items where order_id = p_order and status in ('approved','in_progress','done')) then
      raise exception 'Adicione o serviço que será feito (aprovado pelo cliente) antes de começar';
    end if;
  end if;

  if p_to = 'ready' then
    select count(*) into n from public.order_items where order_id = p_order and status in ('approved','in_progress');
    if n > 0 then raise exception 'Revise os itens: % item(ns) aprovado(s) ainda não marcado(s) como executado ou não executado', n; end if;
    if exists (select 1 from public.order_items where order_id = p_order and status = 'done' and executed_confirmed_at is null) then
      raise exception 'Confirme a revisão dos itens executados';
    end if;
    if exists (select 1 from public.stock_reservations r where r.order_id = p_order and r.status = 'reserved') then
      raise exception 'Há peças reservadas sem consumo ou devolução';
    end if;
    -- checklist de qualidade: obrigatório só quando a oficina ativa essa exigência
    if (select require_quality_check from public.workshops where id = o.workshop_id) then
      select * into q from public.order_checklists where order_id = p_order and kind = 'quality';
      if q.id is not null and q.completed_at is null then raise exception 'Conclua o checklist de qualidade'; end if;
    end if;
    if o.maintenance_decision is null then
      raise exception 'Defina o retorno preventivo: cadastrar plano ou marcar como não aplicável';
    end if;
    if exists (select 1 from public.time_entries where order_id = p_order and ended_at is null) then
      raise exception 'Há apontamentos de tempo em aberto nesta OS';
    end if;
    update public.service_orders set ready_at = now(), ready_by = auth.uid() where id = p_order;
  end if;

  update public.service_orders set status = p_to where id = p_order;
  insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
  values (o.workshop_id, p_order, o.status, p_to, p_reason);
  insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
  values (o.workshop_id, p_order, 'status',
    case p_to when 'diagnosis' then 'Em diagnóstico' when 'awaiting_approval' then 'Aguardando aprovação do orçamento'
      when 'approved' then 'Serviço aprovado e programado' when 'in_progress' then 'Seu carro está em serviço'
      when 'quality_check' then 'Conferência final' when 'ready' then 'Seu carro está pronto para retirada!'
      else p_to::text end, true);
end $$;

-- "Pronto para entrega" em um toque: o mecânico confirma que terminou.
-- Itens aprovados viram executados, apontamentos abertos são fechados,
-- peças reservadas são consumidas e o retorno é decidido na mesma hora.
create or replace function public.finish_service(p_order uuid, p_return_months int default null, p_return_km int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; r record; v_plan uuid; v_rule text;
begin
  o := private.require_order(p_order, 'orders.execute');
  select * into o from public.service_orders where id = p_order for update;
  if o.status not in ('approved','in_progress','quality_check') then
    raise exception 'Comece o serviço antes de marcar como pronto';
  end if;
  update public.order_items set status = 'done' where order_id = p_order and status in ('approved','in_progress');
  if not exists (select 1 from public.order_items where order_id = p_order and status = 'done') then
    raise exception 'Adicione o serviço que foi feito antes de finalizar';
  end if;
  update public.order_items set executed_confirmed_at = coalesce(executed_confirmed_at, now()) where order_id = p_order and status = 'done';
  update public.time_entries set ended_at = now(), pause_reason = 'Serviço finalizado' where order_id = p_order and ended_at is null;
  for r in select id from public.stock_reservations where order_id = p_order and status = 'reserved' loop
    perform public.consume_reservation(r.id);
  end loop;

  if coalesce(p_return_months, 0) > 0 or coalesce(p_return_km, 0) > 0 then
    if not exists (select 1 from public.maintenance_plans where vehicle_id = o.vehicle_id and component = 'revisao' and status = 'active') then
      v_rule := case when coalesce(p_return_months,0) > 0 and coalesce(p_return_km,0) > 0 then 'first'
                     when coalesce(p_return_months,0) > 0 then 'date_only' else 'km_only' end;
      insert into public.maintenance_plans(workshop_id, vehicle_id, component, component_label, action, interval_months, interval_km,
         rule, lead_days, lead_km, source, created_from_order)
      values (o.workshop_id, o.vehicle_id, 'revisao', 'Revisão / retorno', 'avaliacao', nullif(p_return_months,0), nullif(p_return_km,0),
         v_rule, 15, 500, 'Definido pela oficina ao finalizar o serviço', p_order)
      returning id into v_plan;
      perform private.open_cycle(v_plan, (now() at time zone (select timezone from public.workshops where id = o.workshop_id))::date,
                                 o.km_entry, p_order, 'order');
    end if;
    update public.service_orders set maintenance_decision = 'registered' where id = p_order;
  else
    update public.service_orders set maintenance_decision = coalesce(maintenance_decision, 'not_applicable') where id = p_order;
  end if;

  update public.service_orders set status = 'ready', ready_at = now(), ready_by = auth.uid() where id = p_order;
  insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
  values (o.workshop_id, p_order, o.status, 'ready', 'Finalizado');
  insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
  values (o.workshop_id, p_order, 'status', 'Seu carro está pronto para retirada!', true);
end $$;

-- "Entregar o carro": uma pergunta — como foi pago?
--   paid_now      → cobra o total agora na forma escolhida
--   already_paid  → registra que o cliente já tinha pago (sem lançar valor)
--   later         → deixa a cobrança em aberto com vencimento
create or replace function public.deliver_simple(p_order uuid, p_mode text, p_method text default null,
                                                p_due date default null, p_km int default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; v_total bigint; v_acc uuid; i record; tz text; today date; v_note text; v_allow boolean := false;
begin
  o := private.require_order(p_order, 'orders.deliver');
  if p_mode not in ('paid_now','already_paid','later') then raise exception 'Escolha como foi pago'; end if;
  select timezone into tz from public.workshops where id = o.workshop_id;
  today := (now() at time zone tz)::date;
  select coalesce(sum(total_cents),0) into v_total from public.order_items where order_id = p_order and status = 'done';

  if v_total > 0 and p_mode in ('paid_now','later') then
    perform private.require_perm(o.workshop_id, 'payments.receive');
    select id into v_acc from public.accounts where order_id = p_order and kind = 'receivable' and status <> 'cancelled';
    if v_acc is null then
      insert into public.accounts(workshop_id, kind, order_id, client_id, category, description, total_cents)
      values (o.workshop_id, 'receivable', p_order, o.client_id, 'servicos', 'OS ' || o.number, v_total) returning id into v_acc;
      insert into public.account_installments(workshop_id, account_id, seq, due_date, amount_cents)
      values (o.workshop_id, v_acc, 1, case when p_mode = 'later' then coalesce(p_due, today + 7) else today end, v_total);
    end if;
  end if;

  if v_total = 0 then
    v_note := 'Sem valor a cobrar'; v_allow := true;
  elsif p_mode = 'paid_now' then
    if p_method is null then raise exception 'Escolha a forma de pagamento'; end if;
    for i in select id, amount_cents - paid_cents bal from public.account_installments where account_id = v_acc and amount_cents > paid_cents order by seq loop
      perform public.register_payment(i.id, i.bal, p_method, 'entrega:' || p_order || ':' || i.id);
    end loop;
    v_note := 'Pago na entrega';
  elsif p_mode = 'already_paid' then
    v_note := 'Cliente já tinha pago'; v_allow := true;
  else
    v_note := 'Vai pagar até ' || to_char(coalesce(p_due, today + 7), 'DD/MM/YYYY'); v_allow := true;
  end if;
  perform public.deliver_order(p_order, null, v_note, p_km, v_allow);
end $$;

-- Caixa opcional: dinheiro entra no caixa só se houver caixa aberto.
create or replace function public.register_payment(p_installment uuid, p_amount_cents bigint, p_method text, p_idem text,
   p_fee_cents bigint default 0, p_reference text default null, p_notes text default null, p_paid_at timestamptz default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare i public.account_installments; a public.accounts; v uuid; v_cash uuid; w public.workshops;
begin
  select id into v from public.account_payments where idempotency_key = p_idem;
  if v is not null then return v; end if;
  select * into i from public.account_installments where id = p_installment for update;
  select * into a from public.accounts where id = i.account_id for update;
  if a.kind = 'receivable' then perform private.require_perm(a.workshop_id, 'payments.receive');
  else perform private.require_perm(a.workshop_id, 'finance.edit'); end if;
  if a.status = 'cancelled' then raise exception 'Conta cancelada'; end if;
  if p_amount_cents <= 0 then raise exception 'Valor deve ser positivo'; end if;
  if p_amount_cents > i.amount_cents - i.paid_cents then
    raise exception 'Valor (%) maior que o saldo da parcela (%)', p_amount_cents, i.amount_cents - i.paid_cents using errcode = 'P0013';
  end if;
  select * into w from public.workshops where id = a.workshop_id;
  if not (w.payment_methods ? p_method) then raise exception 'Forma de pagamento não habilitada: %', p_method; end if;
  if p_method = 'dinheiro' then
    select id into v_cash from public.cash_sessions where workshop_id = a.workshop_id and closed_at is null;
  end if;
  insert into public.account_payments(workshop_id, installment_id, amount_cents, method, fee_cents, paid_at, cash_session_id,
     reference, notes, idempotency_key, receipt_number)
  values (a.workshop_id, p_installment, p_amount_cents, p_method, coalesce(p_fee_cents,0), coalesce(p_paid_at, now()), v_cash,
     p_reference, p_notes, p_idem, case when a.kind = 'receivable' then private.next_number(a.workshop_id, 'receipt') end)
  returning id into v;
  update public.account_installments set paid_cents = paid_cents + p_amount_cents where id = p_installment;
  if v_cash is not null then
    insert into public.cash_movements(workshop_id, session_id, kind, amount_cents, description, payment_id)
    values (a.workshop_id, v_cash, case when a.kind = 'receivable' then 'entrada' else 'saida' end, p_amount_cents, a.description, v);
  end if;
  perform private.refresh_account_status(a.id);
  if a.order_id is not null and (select status from public.accounts where id = a.id) = 'paid' then
    perform private.generate_commissions(a.order_id, 'recebimento');
  end if;
  return v;
end $$;

create or replace function public.reverse_payment(p_payment uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.account_payments; a public.accounts; v uuid; v_cash uuid;
begin
  select * into p from public.account_payments where id = p_payment for update;
  perform private.require_perm(p.workshop_id, 'payments.refund');
  if p.reverses_payment_id is not null then raise exception 'Não é possível estornar um estorno'; end if;
  if p.reversed_at is not null then
    select id into v from public.account_payments where reverses_payment_id = p_payment; return v;   -- idempotente
  end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'Informe o motivo do estorno'; end if;
  select a2.* into a from public.accounts a2 join public.account_installments i on i.account_id = a2.id where i.id = p.installment_id;
  if p.method = 'dinheiro' then
    select id into v_cash from public.cash_sessions where workshop_id = p.workshop_id and closed_at is null;
  end if;
  insert into public.account_payments(workshop_id, installment_id, amount_cents, method, cash_session_id, reverses_payment_id,
     notes, idempotency_key)
  values (p.workshop_id, p.installment_id, -p.amount_cents, p.method, v_cash, p_payment, p_reason, 'rev:' || p_payment)
  returning id into v;
  update public.account_payments set reversed_at = now(), reversal_reason = p_reason where id = p_payment;
  update public.account_installments set paid_cents = paid_cents - p.amount_cents where id = p.installment_id;
  if v_cash is not null then
    insert into public.cash_movements(workshop_id, session_id, kind, amount_cents, description, payment_id)
    values (p.workshop_id, v_cash, case when a.kind = 'receivable' then 'saida' else 'entrada' end, p.amount_cents,
            'Estorno: ' || p_reason, v);
  end if;
  perform private.refresh_account_status(a.id);
  update public.commission_entries set status = 'reversed', reversed_reason = 'Pagamento estornado'
   where order_id = a.order_id and basis = 'recebimento' and status <> 'reversed';
  return v;
end $$;

-- Resumo do dia (janela que abre no primeiro acesso do dia)
create or replace function public.day_summary(p_workshop uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; today date; r jsonb;
begin
  if not private.is_member(p_workshop) then raise exception 'Sem acesso' using errcode = '42501'; end if;
  select timezone into tz from public.workshops where id = p_workshop;
  today := (now() at time zone tz)::date;
  select jsonb_build_object(
    'today', today,
    'delivered_yesterday', (select count(*) from public.service_orders where workshop_id = p_workshop and status = 'delivered'
                             and (delivered_at at time zone tz)::date = today - 1),
    'services_7d', (select count(*) from public.service_orders where workshop_id = p_workshop and status <> 'cancelled'
                     and (entry_at at time zone tz)::date > today - 7),
    'in_shop', (select count(*) from public.service_orders where workshop_id = p_workshop and status not in ('delivered','cancelled')),
    'ready', (select count(*) from public.service_orders where workshop_id = p_workshop and status = 'ready'),
    'late', (select count(*) from public.service_orders where workshop_id = p_workshop and expected_delivery_at < now()
              and status not in ('ready','delivered','cancelled')),
    'parts_pending', (select count(*) from public.service_orders where workshop_id = p_workshop and parts_pending
                       and status not in ('delivered','cancelled')),
    'awaiting_approval', (select count(*) from public.quotes where workshop_id = p_workshop and status = 'sent'),
    'received_yesterday_cents', case when private.has_perm(p_workshop, 'finance.view') then
        (select coalesce(sum(p.amount_cents),0) from public.account_payments p join public.account_installments i on i.id = p.installment_id
          join public.accounts a on a.id = i.account_id where a.workshop_id = p_workshop and a.kind = 'receivable'
          and (p.paid_at at time zone tz)::date = today - 1) end
  ) into r;
  return r;
end $$;

-- Indicadores do período comparados com o período anterior de mesmo tamanho
create or replace function public.indicators(p_workshop uuid, p_days int)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare tz text; today date; c_from date; p_from date; p_to date; money bool; fin bool; r jsonb;
begin
  perform private.require_perm(p_workshop, 'reports.view');
  p_days := least(greatest(coalesce(p_days, 30), 1), 366);
  select timezone into tz from public.workshops where id = p_workshop;
  today := (now() at time zone tz)::date;
  c_from := today - p_days + 1; p_to := c_from - 1; p_from := p_to - p_days + 1;
  money := private.has_perm(p_workshop, 'prices.view');
  fin := private.has_perm(p_workshop, 'reports.financial');

  with o as (
    select so.*, (so.entry_at at time zone tz)::date d,
           (select coalesce(sum(i.total_cents),0) from public.order_items i where i.order_id = so.id and i.status in ('approved','in_progress','done')) val
      from public.service_orders so
     where so.workshop_id = p_workshop and so.status <> 'cancelled' and (so.entry_at at time zone tz)::date between p_from and today
  ), per as (
    select case when d >= c_from then 'cur' else 'prev' end k, count(*) n, sum(val) sales,
           avg(val) filter (where status = 'delivered' and val > 0) ticket
      from o group by 1
  ), q as (
    select case when (v.sent_at at time zone tz)::date >= c_from then 'cur' else 'prev' end k,
           count(*) filter (where v.status in ('approved','partially_approved')) ok,
           count(*) filter (where v.status in ('approved','partially_approved','declined')) decided
      from public.quote_versions v where v.workshop_id = p_workshop and v.sent_at is not null
       and (v.sent_at at time zone tz)::date between p_from and today group by 1
  ), pay as (
    select case when (p.paid_at at time zone tz)::date >= c_from then 'cur' else 'prev' end k, sum(p.amount_cents) s
      from public.account_payments p join public.account_installments i on i.id = p.installment_id join public.accounts a on a.id = i.account_id
     where a.workshop_id = p_workshop and a.kind = 'receivable' and (p.paid_at at time zone tz)::date between p_from and today group by 1
  ), cl as (
    select case when (created_at at time zone tz)::date >= c_from then 'cur' else 'prev' end k, count(*) n
      from public.clients where workshop_id = p_workshop and (created_at at time zone tz)::date between p_from and today group by 1
  )
  select jsonb_build_object(
    'days', p_days, 'from', c_from, 'to', today,
    'sales', case when money then jsonb_build_object('cur', coalesce((select sales from per where k='cur'),0), 'prev', (select sales from per where k='prev')) end,
    'received', case when fin then jsonb_build_object('cur', coalesce((select s from pay where k='cur'),0), 'prev', (select s from pay where k='prev')) end,
    'services', jsonb_build_object('cur', coalesce((select n from per where k='cur'),0), 'prev', (select n from per where k='prev')),
    'ticket', case when money then jsonb_build_object('cur', coalesce(round((select ticket from per where k='cur')),0), 'prev', round((select ticket from per where k='prev'))) end,
    'quotes_pct', jsonb_build_object(
        'cur', (select round(100.0 * ok / nullif(decided,0)) from q where k='cur'),
        'prev', (select round(100.0 * ok / nullif(decided,0)) from q where k='prev')),
    'new_clients', jsonb_build_object('cur', coalesce((select n from cl where k='cur'),0), 'prev', (select n from cl where k='prev')),
    'daily', case when money then (select coalesce(jsonb_agg(jsonb_build_object('day', g.day, 'cur', coalesce(c.s,0), 'prev', coalesce(pv.s,0)) order by g.day), '[]'::jsonb)
        from generate_series(c_from, today, interval '1 day') g(day)
        left join (select d, sum(val) s from o group by d) c on c.d = g.day::date
        left join (select d, sum(val) s from o group by d) pv on pv.d = (g.day::date - p_days)) end,
    'origins', (select coalesce(jsonb_object_agg(origin, n), '{}'::jsonb) from (select origin, count(*) n from o where d >= c_from group by origin) x),
    'by_brand', (select coalesce(jsonb_agg(b order by b.n desc), '[]'::jsonb) from (
        select coalesce(nullif(trim(v.brand),''), 'Sem marca') brand, count(*) n,
               case when money then sum(o.val) end revenue,
               round(avg(extract(epoch from (o.delivered_at - o.entry_at)) / 86400) filter (where o.status = 'delivered')::numeric, 1) avg_days
          from o join public.vehicles v on v.id = o.vehicle_id where o.d >= c_from group by 1 limit 12) b)
  ) into r;
  return r;
end $$;

grant execute on function public.finish_service(uuid, int, int), public.deliver_simple(uuid, text, text, date, int),
  public.day_summary(uuid), public.indicators(uuid, int) to authenticated;
revoke execute on function public.finish_service(uuid, int, int), public.deliver_simple(uuid, text, text, date, int),
  public.day_summary(uuid), public.indicators(uuid, int) from anon, public;
