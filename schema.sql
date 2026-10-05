-- Supabase/PostgreSQL schema for durable WAN request and operation state.
-- Run once in Supabase Dashboard -> SQL Editor. Do not expose the service-role key to browsers.
create extension if not exists pgcrypto;

create table if not exists public.wan_terminal_state (
  terminal_id text primary key,
  session_id uuid,
  last_seen timestamptz,
  last_response_id uuid,
  last_event_id uuid
);

create table if not exists public.wan_operations (
  operation_id uuid primary key,
  terminal_id text not null,
  kind text not null check (kind in ('payment','refund','reversal','capture','print')),
  state text not null check (state in ('starting','pending','unknown','abort-requested','completed','failed')),
  created_at timestamptz not null default now(),
  result jsonb,
  message text
);
create index if not exists wan_operations_terminal_created_idx
  on public.wan_operations (terminal_id, created_at desc);
create index if not exists wan_operations_active_idx
  on public.wan_operations (terminal_id)
  where state in ('starting','pending','unknown','abort-requested');

create table if not exists public.wan_requests (
  terminal_id text not null,
  message_id uuid not null,
  created_at timestamptz not null default now(),
  integration_key text not null,
  request_type text not null,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','delivered','responded')),
  kind text,
  operation_id uuid,
  related_operation_id uuid,
  response jsonb,
  primary key (terminal_id, message_id)
);
create index if not exists wan_requests_pending_idx
  on public.wan_requests (terminal_id, created_at)
  where status <> 'responded';

alter table public.wan_terminal_state enable row level security;
alter table public.wan_operations enable row level security;
alter table public.wan_requests enable row level security;
grant usage on schema public to service_role;
grant select, insert, update, delete on public.wan_terminal_state, public.wan_operations, public.wan_requests to service_role;

create or replace function public.wan_operation_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'operationId', o.operation_id,
    'terminalId', o.terminal_id,
    'kind', o.kind,
    'state', o.state,
    'createdAt', o.created_at,
    'result', o.result,
    'message', o.message
  ) from public.wan_operations o where o.operation_id = p_id;
$$;

create or replace function public.wan_bootstrap_terminals(p_terminal_ids text[])
returns void language plpgsql security definer set search_path = public as $$
declare v_id text;
begin
  foreach v_id in array p_terminal_ids loop
    insert into public.wan_terminal_state(terminal_id) values (v_id) on conflict (terminal_id) do nothing;
  end loop;
end;
$$;

create or replace function public.wan_touch_terminal(p_terminal_id text, p_session_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.wan_terminal_state(terminal_id, session_id, last_seen)
  values (p_terminal_id, p_session_id, now())
  on conflict (terminal_id) do update set session_id = excluded.session_id, last_seen = excluded.last_seen;
end;
$$;

create or replace function public.wan_get_session(p_terminal_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when s.terminal_id is null then null else jsonb_build_object(
    'sessionId', s.session_id, 'lastSeen', s.last_seen
  ) end from (select p_terminal_id as terminal_id) q
  left join public.wan_terminal_state s on s.terminal_id = q.terminal_id;
$$;

create or replace function public.wan_all_operations()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.wan_operation_json(o.operation_id) order by o.created_at desc), '[]'::jsonb)
  from public.wan_operations o;
$$;

create or replace function public.wan_get_operation(p_operation_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.wan_operation_json(p_operation_id);
$$;

create or replace function public.wan_latest_operation(p_terminal_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.wan_operation_json(o.operation_id) from public.wan_operations o
  where o.terminal_id = p_terminal_id order by o.created_at desc limit 1;
$$;

create or replace function public.wan_active_operation(p_terminal_id text)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.wan_operation_json(o.operation_id) from public.wan_operations o
  where o.terminal_id = p_terminal_id and o.state in ('starting','pending','unknown','abort-requested')
  order by o.created_at desc limit 1;
$$;

create or replace function public.wan_create_operation(
  p_operation_id uuid, p_terminal_id text, p_kind text, p_created_at timestamptz,
  p_integration_key text, p_request_type text, p_data jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_active uuid; v_envelope jsonb; v_operation jsonb;
begin
  insert into public.wan_terminal_state(terminal_id) values (p_terminal_id) on conflict (terminal_id) do nothing;
  perform 1 from public.wan_terminal_state where terminal_id = p_terminal_id for update;
  select operation_id into v_active from public.wan_operations
    where terminal_id = p_terminal_id and state in ('starting','pending','unknown','abort-requested')
    order by created_at desc limit 1;
  if v_active is not null then
    return jsonb_build_object('conflict', true, 'operation', public.wan_operation_json(v_active));
  end if;
  insert into public.wan_operations(operation_id, terminal_id, kind, state, created_at, message)
    values (p_operation_id, p_terminal_id, p_kind, 'pending', p_created_at, 'Queued for delivery to the terminal.');
  v_envelope := jsonb_build_object(
    'id', gen_random_uuid(), 'createdAt', now(), 'integrationKey', p_integration_key,
    'type', p_request_type, 'data', p_data
  );
  insert into public.wan_requests(terminal_id, message_id, created_at, integration_key, request_type, data, status, kind, operation_id)
    values (p_terminal_id, (v_envelope->>'id')::uuid, (v_envelope->>'createdAt')::timestamptz,
      p_integration_key, p_request_type, p_data, 'queued', p_kind, p_operation_id);
  v_operation := public.wan_operation_json(p_operation_id);
  return jsonb_build_object('conflict', false, 'operation', v_operation, 'envelope', v_envelope);
end;
$$;

create or replace function public.wan_enqueue_request(
  p_terminal_id text, p_integration_key text, p_request_type text, p_data jsonb, p_related_operation_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_envelope jsonb;
begin
  insert into public.wan_terminal_state(terminal_id) values (p_terminal_id) on conflict (terminal_id) do nothing;
  v_envelope := jsonb_build_object('id', gen_random_uuid(), 'createdAt', now(), 'integrationKey', p_integration_key,
    'type', p_request_type, 'data', p_data);
  insert into public.wan_requests(terminal_id, message_id, created_at, integration_key, request_type, data, status, related_operation_id)
    values (p_terminal_id, (v_envelope->>'id')::uuid, (v_envelope->>'createdAt')::timestamptz,
      p_integration_key, p_request_type, p_data, 'queued', p_related_operation_id);
  return v_envelope;
end;
$$;

create or replace function public.wan_enqueue_abort(p_terminal_id text, p_integration_key text, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_op public.wan_operations%rowtype; v_envelope jsonb;
begin
  select * into v_op from public.wan_operations where operation_id = p_operation_id and terminal_id = p_terminal_id for update;
  if not found then return null; end if;
  insert into public.wan_terminal_state(terminal_id) values (p_terminal_id) on conflict (terminal_id) do nothing;
  v_envelope := jsonb_build_object('id', gen_random_uuid(), 'createdAt', now(), 'integrationKey', p_integration_key,
    'type', 'Abort', 'data', jsonb_build_object('operationId', p_operation_id));
  insert into public.wan_requests(terminal_id, message_id, created_at, integration_key, request_type, data, status, related_operation_id)
    values (p_terminal_id, (v_envelope->>'id')::uuid, (v_envelope->>'createdAt')::timestamptz,
      p_integration_key, 'Abort', v_envelope->'data', 'queued', p_operation_id);
  update public.wan_operations set state = 'abort-requested', message = 'Abort requested. Waiting for the terminal to report the final result.'
    where operation_id = p_operation_id;
  return v_envelope;
end;
$$;

create or replace function public.wan_next_request(p_terminal_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_request public.wan_requests%rowtype;
begin
  select * into v_request from public.wan_requests where terminal_id = p_terminal_id and status <> 'responded'
    order by created_at, message_id limit 1 for update skip locked;
  if not found then return null; end if;
  if v_request.status = 'queued' then
    update public.wan_requests set status = 'delivered' where terminal_id = p_terminal_id and message_id = v_request.message_id;
  end if;
  return jsonb_build_object('id', v_request.message_id, 'createdAt', v_request.created_at,
    'integrationKey', v_request.integration_key, 'type', v_request.request_type, 'data', v_request.data);
end;
$$;

create or replace function public.wan_submit_response(p_terminal_id text, p_envelope jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_request public.wan_requests%rowtype; v_operation_id uuid; v_status text; v_description text;
begin
  v_id := (p_envelope->>'id')::uuid;
  insert into public.wan_terminal_state(terminal_id) values (p_terminal_id) on conflict (terminal_id) do nothing;
  perform 1 from public.wan_terminal_state where terminal_id = p_terminal_id for update;
  if (select last_response_id from public.wan_terminal_state where terminal_id = p_terminal_id) = v_id then
    return jsonb_build_object('duplicate', true, 'httpStatus', 201);
  end if;
  select * into v_request from public.wan_requests where terminal_id = p_terminal_id and message_id = v_id for update;
  if not found then return jsonb_build_object('duplicate', false, 'httpStatus', 404, 'error', 'No outstanding request has this message ID.'); end if;
  update public.wan_requests set status = 'responded', response = p_envelope where terminal_id = p_terminal_id and message_id = v_id;
  update public.wan_terminal_state set last_response_id = v_id where terminal_id = p_terminal_id;
  v_status := p_envelope->>'status';
  v_operation_id := coalesce(v_request.operation_id, v_request.related_operation_id);
  if v_request.operation_id is not null then
    if v_status = 'OK' then
      update public.wan_operations set state = 'pending', message = 'Accepted by the terminal. Waiting for the completion event.' where operation_id = v_request.operation_id;
    else
      v_description := coalesce(p_envelope #>> '{data,description}', v_status);
      update public.wan_operations set state = 'failed', message = 'Terminal rejected the request: ' || v_description where operation_id = v_request.operation_id;
    end if;
  elsif v_request.request_type = 'Abort' and v_status <> 'OK' and v_operation_id is not null then
    update public.wan_operations set state = 'pending', message = 'Terminal did not accept the abort request (' || v_status || ').' where operation_id = v_operation_id;
  end if;
  return jsonb_build_object('duplicate', false, 'httpStatus', 200);
end;
$$;

create or replace function public.wan_response_for(p_message_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select response from public.wan_requests where message_id = p_message_id and status = 'responded' limit 1;
$$;

create or replace function public.wan_submit_event(p_terminal_id text, p_event jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_operation_id uuid; v_type text;
begin
  v_id := (p_event->>'id')::uuid;
  insert into public.wan_terminal_state(terminal_id) values (p_terminal_id) on conflict (terminal_id) do nothing;
  perform 1 from public.wan_terminal_state where terminal_id = p_terminal_id for update;
  if (select last_event_id from public.wan_terminal_state where terminal_id = p_terminal_id) = v_id then
    return jsonb_build_object('duplicate', true);
  end if;
  update public.wan_terminal_state set last_event_id = v_id where terminal_id = p_terminal_id;
  v_type := p_event->>'type';
  begin v_operation_id := nullif(p_event->>'operationId','')::uuid; exception when invalid_text_representation then v_operation_id := null; end;
  if v_operation_id is not null and v_type in ('PaymentCompleted','RefundCompleted','CaptureCompleted','ReversalCompleted','PrintCompleted') then
    update public.wan_operations set state = 'completed', result = coalesce(p_event->'data','null'::jsonb), message = null where operation_id = v_operation_id and terminal_id = p_terminal_id;
  end if;
  return jsonb_build_object('duplicate', false);
end;
$$;

-- The app calls these RPCs with the Supabase service-role key from its server only.
revoke all on function public.wan_operation_json(uuid) from public, anon, authenticated;
revoke all on function public.wan_bootstrap_terminals(text[]) from public, anon, authenticated;
revoke all on function public.wan_touch_terminal(text,uuid) from public, anon, authenticated;
revoke all on function public.wan_get_session(text) from public, anon, authenticated;
revoke all on function public.wan_all_operations() from public, anon, authenticated;
revoke all on function public.wan_get_operation(uuid) from public, anon, authenticated;
revoke all on function public.wan_latest_operation(text) from public, anon, authenticated;
revoke all on function public.wan_active_operation(text) from public, anon, authenticated;
revoke all on function public.wan_create_operation(uuid,text,text,timestamptz,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.wan_enqueue_request(text,text,text,jsonb,uuid) from public, anon, authenticated;
revoke all on function public.wan_enqueue_abort(text,text,uuid) from public, anon, authenticated;
revoke all on function public.wan_next_request(text) from public, anon, authenticated;
revoke all on function public.wan_submit_response(text,jsonb) from public, anon, authenticated;
revoke all on function public.wan_response_for(uuid) from public, anon, authenticated;
revoke all on function public.wan_submit_event(text,jsonb) from public, anon, authenticated;
grant execute on function public.wan_operation_json(uuid) to service_role;
grant execute on function public.wan_bootstrap_terminals(text[]) to service_role;
grant execute on function public.wan_touch_terminal(text,uuid) to service_role;
grant execute on function public.wan_get_session(text) to service_role;
grant execute on function public.wan_all_operations() to service_role;
grant execute on function public.wan_get_operation(uuid) to service_role;
grant execute on function public.wan_latest_operation(text) to service_role;
grant execute on function public.wan_active_operation(text) to service_role;
grant execute on function public.wan_create_operation(uuid,text,text,timestamptz,text,text,jsonb) to service_role;
grant execute on function public.wan_enqueue_request(text,text,text,jsonb,uuid) to service_role;
grant execute on function public.wan_enqueue_abort(text,text,uuid) to service_role;
grant execute on function public.wan_next_request(text) to service_role;
grant execute on function public.wan_submit_response(text,jsonb) to service_role;
grant execute on function public.wan_response_for(uuid) to service_role;
grant execute on function public.wan_submit_event(text,jsonb) to service_role;
