import { config } from './config';

export type OperationKind = 'payment' | 'refund' | 'reversal' | 'capture' | 'print';
export type OperationState = 'starting' | 'pending' | 'unknown' | 'abort-requested' | 'completed' | 'failed';
export type Operation = {
  operationId: string;
  terminalId: string;
  kind: OperationKind;
  state: OperationState;
  createdAt: string;
  result?: unknown;
  message?: string;
};
export type RequestEnvelope = {
  id: string;
  createdAt: string;
  integrationKey: string;
  type: string;
  data: Record<string, unknown>;
};
export type ResponseEnvelope = {
  id: string;
  createdAt: string;
  status: string;
  data: Record<string, unknown>;
};
type CreateResult = { conflict: boolean; operation: Operation; envelope?: RequestEnvelope };
type SubmitResponseResult = { duplicate: boolean; httpStatus: number; error?: string };

const apiBase = `${config.supabaseUrl}/rest/v1`;

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let response: globalThis.Response;
  try {
    response = await fetch(`${apiBase}/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: config.supabaseServiceRoleKey,
        Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error && error.name === 'AbortError' ? 'database request timed out' : 'could not reach the database';
    throw new Error(`WAN state database ${detail}.`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    console.error(`Supabase RPC ${name} failed with HTTP ${response.status}.`);
    throw new Error(`WAN state database request failed (HTTP ${response.status}).`);
  }
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`WAN state database returned invalid JSON for ${name}.`); }
}

export const wanStore = {
  async initialize(terminalIds: string[]): Promise<void> {
    await rpc<void>('wan_bootstrap_terminals', { p_terminal_ids: terminalIds });
  },
  async allOperations(): Promise<Operation[]> {
    return (await rpc<Operation[]>('wan_all_operations')) ?? [];
  },
  async getOperation(id: string): Promise<Operation | undefined> {
    return (await rpc<Operation | null>('wan_get_operation', { p_operation_id: id })) ?? undefined;
  },
  async latestOperation(terminalId: string): Promise<Operation | undefined> {
    return (await rpc<Operation | null>('wan_latest_operation', { p_terminal_id: terminalId })) ?? undefined;
  },
  async activeOperation(terminalId: string): Promise<Operation | undefined> {
    return (await rpc<Operation | null>('wan_active_operation', { p_terminal_id: terminalId })) ?? undefined;
  },
  async session(terminalId: string): Promise<{ sessionId: string | null; lastSeen: string | null } | undefined> {
    return (await rpc<{ sessionId: string | null; lastSeen: string | null } | null>('wan_get_session', { p_terminal_id: terminalId })) ?? undefined;
  },
  async touchTerminal(terminalId: string, sessionId: string): Promise<void> {
    await rpc<void>('wan_touch_terminal', { p_terminal_id: terminalId, p_session_id: sessionId });
  },
  async createOperation(operation: Operation, integrationKey: string, type: string, data: Record<string, unknown>): Promise<CreateResult> {
    return rpc<CreateResult>('wan_create_operation', {
      p_operation_id: operation.operationId,
      p_terminal_id: operation.terminalId,
      p_kind: operation.kind,
      p_created_at: operation.createdAt,
      p_integration_key: integrationKey,
      p_request_type: type,
      p_data: data,
    });
  },
  async enqueue(terminalId: string, integrationKey: string, type: string, data: Record<string, unknown>, relatedOperationId?: string): Promise<RequestEnvelope> {
    return rpc<RequestEnvelope>('wan_enqueue_request', {
      p_terminal_id: terminalId,
      p_integration_key: integrationKey,
      p_request_type: type,
      p_data: data,
      p_related_operation_id: relatedOperationId ?? null,
    });
  },
  async enqueueAbort(terminalId: string, integrationKey: string, operationId: string): Promise<RequestEnvelope | undefined> {
    return (await rpc<RequestEnvelope | null>('wan_enqueue_abort', {
      p_terminal_id: terminalId, p_integration_key: integrationKey, p_operation_id: operationId,
    })) ?? undefined;
  },
  async nextRequest(terminalId: string): Promise<RequestEnvelope | undefined> {
    return (await rpc<RequestEnvelope | null>('wan_next_request', { p_terminal_id: terminalId })) ?? undefined;
  },
  async submitResponse(terminalId: string, envelope: ResponseEnvelope): Promise<SubmitResponseResult> {
    return rpc<SubmitResponseResult>('wan_submit_response', { p_terminal_id: terminalId, p_envelope: envelope });
  },
  async responseFor(messageId: string): Promise<ResponseEnvelope | undefined> {
    return (await rpc<ResponseEnvelope | null>('wan_response_for', { p_message_id: messageId })) ?? undefined;
  },
  async submitEvent(terminalId: string, event: { id: string; type: string; operationId?: string; data?: Record<string, unknown> }): Promise<{ duplicate: boolean }> {
    return rpc<{ duplicate: boolean }>('wan_submit_event', { p_terminal_id: terminalId, p_event: event });
  },
};
