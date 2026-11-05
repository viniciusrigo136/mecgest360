-- =====================================================================
-- Lembretes de retorno por serviço feito (ex.: "Amortecedor — 1 ano ou
-- 20 mil km"). O mecânico define na hora; o sistema cria um plano por
-- item e avisa quando estiver chegando a hora de o cliente voltar.
-- =====================================================================

create or replace function private.slug(p text)
returns text language sql immutable as $$
  select left(trim(both '_' from regexp_replace(private.norm_text(p), '[^a-z0-9]+', '_', 'g')), 60)
$$;

-- Cria (ou renova) o lembrete de retorno de um serviço desta OS.
create or replace function public.add_return_reminder(p_order uuid, p_label text, p_months int, p_km int)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.service_orders; v_comp text; v_plan public.maintenance_plans; v_cycle public.maintenance_cycles; v_rule text;
        v_today date; v_km int; v_id uuid;
begin
  o := private.require_order(p_order, null);
  if not (private.has_perm(o.workshop_id, 'orders.execute') or private.has_perm(o.workshop_id, 'maintenance.edit')) then
    raise exception 'Sem permissão para criar lembrete' using errcode = '42501';
  end if;
  if coalesce(trim(p_label), '') = '' then raise exception 'Diga o que foi feito (ex.: Amortecedor)'; end if;
  if coalesce(p_months, 0) <= 0 and coalesce(p_km, 0) <= 0 then raise exception 'Escolha depois de quanto tempo ou km o cliente deve voltar'; end if;
  v_comp := private.slug(p_label);
  v_rule := case when coalesce(p_months,0) > 0 and coalesce(p_km,0) > 0 then 'first' when coalesce(p_months,0) > 0 then 'date_only' else 'km_only' end;
  v_today := (now() at time zone (select timezone from public.workshops where id = o.workshop_id))::date;
  v_km := coalesce((select km from public.odometer_readings where order_id = p_order and invalidated_at is null and confirmed
                    order by created_at desc limit 1), o.km_entry);

  select * into v_plan from public.maintenance_plans where vehicle_id = o.vehicle_id and component = v_comp and status = 'active';
  if v_plan.id is null then
    insert into public.maintenance_plans(workshop_id, vehicle_id, component, component_label, action, interval_months, interval_km,
       rule, lead_days, lead_km, source, created_from_order)
    values (o.workshop_id, o.vehicle_id, v_comp, trim(p_label), 'avaliacao', nullif(p_months,0), nullif(p_km,0), v_rule, 15, 1000,
       'Definido pela oficina no serviço ' || o.number, p_order)
    returning id into v_id;
    perform private.open_cycle(v_id, v_today, v_km, p_order, 'order');
  else
    v_id := v_plan.id;
    select * into v_cycle from public.maintenance_cycles where plan_id = v_plan.id and status = 'open';
    if v_cycle.base_order_id = p_order then
      raise exception 'Já existe lembrete de "%" neste serviço', v_plan.component_label;
    end if;
    -- serviço refeito: atualiza o intervalo e começa a contar de novo a partir de hoje
    update public.maintenance_plans set interval_months = nullif(p_months,0), interval_km = nullif(p_km,0), rule = v_rule,
       component_label = trim(p_label) where id = v_plan.id;
    if v_cycle.id is not null then
      perform private.close_cycle_and_renew(v_cycle.id, v_today, v_km, p_order, 'executed_here', 'Refeito no serviço ' || o.number);
    else
      perform private.open_cycle(v_plan.id, v_today, v_km, p_order, 'order');
    end if;
  end if;
  update public.service_orders set maintenance_decision = 'registered' where id = p_order;
  return v_id;
end $$;

-- Finaliza com os lembretes escolhidos item a item.
-- p_returns: [{"label": "Amortecedor", "months": 12, "km": 20000}, ...]
create or replace function public.finish_service_with_returns(p_order uuid, p_returns jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare e jsonb;
begin
  for e in select * from jsonb_array_elements(coalesce(p_returns, '[]'::jsonb)) loop
    perform public.add_return_reminder(p_order, e->>'label', nullif(e->>'months','')::int, nullif(e->>'km','')::int);
  end loop;
  perform public.finish_service(p_order, null, null);
end $$;

-- Lembretes ligados a uma OS (para mostrar na tela do serviço)
create or replace function public.order_reminders(p_order uuid)
returns table(plan_id uuid, label text, interval_months int, interval_km int, target_date date, target_km int, status text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform private.require_order(p_order, null);
  return query
    select p.id, p.component_label, p.interval_months, p.interval_km, c.target_date, c.target_km, p.status
      from public.maintenance_cycles c join public.maintenance_plans p on p.id = c.plan_id
     where c.base_order_id = p_order and c.status <> 'cancelled'
     order by p.component_label;
end $$;

grant execute on function public.add_return_reminder(uuid, text, int, int), public.finish_service_with_returns(uuid, jsonb),
  public.order_reminders(uuid) to authenticated;
revoke execute on function public.add_return_reminder(uuid, text, int, int), public.finish_service_with_returns(uuid, jsonb),
  public.order_reminders(uuid) from anon, public;
