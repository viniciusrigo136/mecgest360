-- O cliente continua vendo o orçamento (com a decisão registrada) depois de aprovar.
-- Antes, o link era revogado na hora e ele via "Link inválido".

create or replace function private.apply_quote_decision(p_version uuid, p_approved uuid[], p_channel text,
   p_name text, p_recorded_by uuid, p_evidence jsonb, p_note text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.quote_versions; q public.quotes; n_total int; n_ok int; v_dec text; v_total bigint;
        bad record; o public.service_orders;
begin
  select * into v from public.quote_versions where id = p_version for update;
  if v.id is null then raise exception 'Orçamento não encontrado'; end if;
  select * into q from public.quotes where id = v.quote_id for update;
  -- Idempotência: decisão existente com o mesmo conteúdo devolve o resultado anterior
  if exists (select 1 from public.quote_decisions where version_id = p_version) then
    select decision into v_dec from public.quote_decisions where version_id = p_version
       and approved_item_ids @> coalesce(p_approved,'{}') and approved_item_ids <@ coalesce(p_approved,'{}');
    if v_dec is not null then return v_dec; end if;
    raise exception 'Este orçamento já recebeu uma decisão diferente' using errcode = 'P0007';
  end if;
  if q.current_version_id <> v.id or v.status = 'superseded' then
    raise exception 'Esta versão do orçamento foi substituída e não pode ser aprovada' using errcode = 'P0008';
  end if;
  if v.status <> 'sent' then raise exception 'Orçamento não está disponível para decisão' using errcode = 'P0008'; end if;
  if v.valid_until < (now() at time zone (select timezone from public.workshops where id = v.workshop_id))::date then
    update public.quote_versions set status = 'expired' where id = v.id;
    update public.quotes set status = 'expired' where id = q.id;
    raise exception 'Orçamento vencido em %', to_char(v.valid_until, 'DD/MM/YYYY') using errcode = 'P0009';
  end if;
  if exists (select unnest(coalesce(p_approved,'{}')) except select id from public.quote_items where version_id = v.id) then
    raise exception 'Itens inválidos para este orçamento';
  end if;
  -- Dependências: conjunto (group_key) aprovado inteiro; item dependente exige o principal
  for bad in
    select i.description from public.quote_items i
     where i.version_id = v.id and i.group_key is not null and i.id = any(coalesce(p_approved,'{}'))
       and exists (select 1 from public.quote_items j where j.version_id = v.id and j.group_key = i.group_key
                    and not (j.id = any(coalesce(p_approved,'{}'))))
  loop
    raise exception 'O item "%" faz parte de um conjunto que deve ser aprovado inteiro. Fale com a oficina para revisar.', bad.description
      using errcode = 'P0010';
  end loop;
  for bad in
    select i.description from public.quote_items i
     where i.version_id = v.id and i.depends_on is not null and i.id = any(coalesce(p_approved,'{}'))
       and not (i.depends_on = any(coalesce(p_approved,'{}')))
  loop
    raise exception 'O item "%" depende de outro item não aprovado', bad.description using errcode = 'P0010';
  end loop;

  select count(*), count(*) filter (where id = any(coalesce(p_approved,'{}'))),
         coalesce(sum(total_cents) filter (where id = any(coalesce(p_approved,'{}'))),0)
    into n_total, n_ok, v_total from public.quote_items where version_id = v.id;
  v_dec := case when n_ok = 0 then 'declined' when n_ok = n_total then 'approved' else 'partially_approved' end;

  insert into public.quote_decisions(workshop_id, version_id, decision, approved_item_ids, total_approved_cents, channel,
                                     decided_by_name, recorded_by, evidence, note)
  values (v.workshop_id, v.id, v_dec, coalesce(p_approved,'{}'), v_total, p_channel, p_name, p_recorded_by,
          coalesce(p_evidence,'{}'::jsonb) || jsonb_build_object('version_no', v.version_no, 'total_cents', v.total_cents,
          'items', (select jsonb_agg(jsonb_build_object('id',id,'d',description,'t',total_cents)) from public.quote_items where version_id = v.id)),
          p_note);
  update public.quote_versions set status = v_dec::public.quote_status, locked_at = coalesce(locked_at, now()) where id = v.id;
  update public.quotes set status = v_dec::public.quote_status where id = q.id;
  -- o link continua abrindo para o cliente ver a decisão; nova decisão já é bloqueada (uma por versão)

  -- Itens recusados viram recomendações separadas (preservados)
  insert into public.recommendations(workshop_id, vehicle_id, client_id, order_id, quote_item_id, description, reason, priority,
                                     follow_up_on)
  select v.workshop_id, q.vehicle_id, q.client_id, q.order_id, i.id, i.description, 'Recusado no orçamento ' || q.number,
         i.priority, current_date + 30
    from public.quote_items i where i.version_id = v.id and not (i.id = any(coalesce(p_approved,'{}')))
  on conflict do nothing;

  -- Itens aprovados entram na OS (uma única vez: quote_item_id é único)
  if q.order_id is not null then
    insert into public.order_items(workshop_id, order_id, kind, description, service_id, product_id, quantity, unit_price_cents,
       discount_cents, status, quote_item_id, approval_source, is_addendum, maintenance_component, sort)
    select v.workshop_id, q.order_id, i.kind, i.description, i.service_id, i.product_id, i.quantity, i.unit_price_cents,
       i.discount_cents, 'approved', i.id, 'quote', q.is_addendum,
       coalesce(i.maintenance_component, (select maintenance_component from public.service_catalog s where s.id = i.service_id)),
       i.sort
      from public.quote_items i where i.version_id = v.id and i.id = any(coalesce(p_approved,'{}'))
    on conflict (quote_item_id) do nothing;
    -- custos estimados dos itens com produto
    insert into public.order_item_costs(item_id, workshop_id, unit_cost_cents, total_cost_cents, cost_source)
    select oi.id, oi.workshop_id, p.avg_cost_cents, round(oi.quantity * p.avg_cost_cents), 'stock_avg'
      from public.order_items oi join public.product_costs p on p.product_id = oi.product_id
     where oi.order_id = q.order_id and oi.quote_item_id = any(coalesce(p_approved,'{}'))
    on conflict do nothing;
    select * into o from public.service_orders where id = q.order_id for update;
    if v_dec <> 'declined' and o.status in ('open','diagnosis','awaiting_approval') then
      update public.service_orders set status = 'approved' where id = o.id;
      insert into public.order_status_history(workshop_id, order_id, from_status, to_status, reason)
      values (o.workshop_id, o.id, o.status, 'approved', 'Orçamento ' || q.number || ' ' || v_dec);
    end if;
    insert into public.order_events(workshop_id, order_id, kind, message, visible_to_client)
    values (v.workshop_id, q.order_id, 'quote',
            'Orçamento ' || q.number || case v_dec when 'approved' then ' aprovado' when 'declined' then ' recusado'
            else ' aprovado parcialmente' end || ' por ' || p_name || ' (' || p_channel || ')', true);
  end if;
  return v_dec;
end $$;
