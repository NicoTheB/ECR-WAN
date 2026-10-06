-- Safe migration for the existing Supabase WAN database.
-- Run once in Supabase Dashboard -> SQL Editor. Does not rewrite existing operations.
-- New event payloads are retained for diagnosis; late acknowledgements cannot revert final states.

create table if not exists public.wan_events (
  terminal_id text not null,
  event_id uuid not null,
  created_at timestamptz not null,
  received_at timestamptz not null default now(),
  event_type text not null,
  operation_id uuid,
  event_data jsonb,
  primary key (terminal_id, event_id)
);
create index if not exists wan_events_operation_idx
  on public.wan_events (terminal_id, operation_id, created_at desc);

alter table public.wan_events enable row level security;
revoke all on public.wan_events from public, anon, authenticated;
grant select, insert, update, delete on public.wan_events to service_role;

create or replace function public.wan_submit_response(p_terminal_id text, p_envelope jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_request public.wan_requests%rowtype;
  v_operation_id uuid;
  v_status text;
  v_description text;
begin
  v_id := (p_envelope->>'id')::uuid;
  insert into public.wan_terminal_state(terminal_id) values (p_terminal_id) on conflict (terminal_id) do nothing;
  perform 1 from public.wan_terminal_state where terminal_id = p_terminal_id for update;

  if (select last_response_id from public.wan_terminal_state where terminal_id = p_terminal_id) = v_id then
    return jsonb_build_object('duplicate', true, 'httpStatus', 201);
  end if;

  select * into v_request
    from public.wan_requests
    where terminal_id = p_terminal_id and message_id = v_id
    for update;
  if not found then
    return jsonb_build_object('duplicate', false, 'httpStatus', 404, 'error', 'No outstanding request has this message ID.');
  end if;

  update public.wan_requests
    set status = 'responded', response = p_envelope
    where terminal_id = p_terminal_id and message_id = v_id;
  update public.wan_terminal_state set last_response_id = v_id where terminal_id = p_terminal_id;

  v_status := p_envelope->>'status';
  v_operation_id := coalesce(v_request.operation_id, v_request.related_operation_id);

  -- A late initial acknowledgement/rejection must not overwrite an already final result.
  if v_request.operation_id is not null then
    if v_status = 'OK' then
      update public.wan_operations
        set state = 'pending', message = 'Accepted by the terminal. Waiting for the completion event.'
        where operation_id = v_request.operation_id
          and state not in ('completed', 'failed');
    else
      v_description := coalesce(p_envelope #>> '{data,description}', v_status);
      update public.wan_operations
        set state = 'failed', message = 'Terminal rejected the request: ' || v_description
        where operation_id = v_request.operation_id
          and state not in ('completed', 'failed');
    end if;
  elsif v_request.request_type = 'Abort' and v_operation_id is not null then
    if v_status = 'OK' then
      -- This is only an Abort-request acknowledgement, not proof the payment ended.
      update public.wan_operations
        set message = 'Terminal acknowledged the abort request. Waiting for the operation final result.'
        where operation_id = v_operation_id and state = 'abort-requested';
    else
      update public.wan_operations
        set state = 'pending', message = 'Terminal did not accept the abort request (' || v_status || ').'
        where operation_id = v_operation_id and state = 'abort-requested';
    end if;
  end if;

  return jsonb_build_object('duplicate', false, 'httpStatus', 200);
end;
$$;

create or replace function public.wan_submit_event(p_terminal_id text, p_event jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_operation_id uuid;
  v_type text;
  v_created_at timestamptz;
  v_inserted integer;
begin
  v_id := (p_event->>'id')::uuid;
  v_created_at := (p_event->>'createdAt')::timestamptz;
  v_type := p_event->>'type';
  begin
    v_operation_id := nullif(p_event->>'operationId', '')::uuid;
  exception when invalid_text_representation then
    v_operation_id := null;
  end;

  insert into public.wan_terminal_state(terminal_id) values (p_terminal_id) on conflict (terminal_id) do nothing;
  perform 1 from public.wan_terminal_state where terminal_id = p_terminal_id for update;

  insert into public.wan_events(terminal_id, event_id, created_at, event_type, operation_id, event_data)
    values (p_terminal_id, v_id, v_created_at, v_type, v_operation_id, p_event->'data')
    on conflict (terminal_id, event_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return jsonb_build_object('duplicate', true);
  end if;

  update public.wan_terminal_state set last_event_id = v_id where terminal_id = p_terminal_id;

  if v_operation_id is not null
     and v_type in ('PaymentCompleted','RefundCompleted','CaptureCompleted','ReversalCompleted','PrintCompleted') then
    update public.wan_operations
      set state = 'completed',
          result = coalesce(p_event->'data', 'null'::jsonb),
          message = null
      where operation_id = v_operation_id
        and terminal_id = p_terminal_id
        and state <> 'completed';
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'operationMatched', exists (
      select 1 from public.wan_operations
      where operation_id = v_operation_id and terminal_id = p_terminal_id
    )
  );
end;
$$;

revoke all on function public.wan_submit_response(text,jsonb) from public, anon, authenticated;
revoke all on function public.wan_submit_event(text,jsonb) from public, anon, authenticated;
grant execute on function public.wan_submit_response(text,jsonb) to service_role;
grant execute on function public.wan_submit_event(text,jsonb) to service_role;
