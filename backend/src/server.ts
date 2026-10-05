import express, { NextFunction, Request, Response } from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { config, TerminalSettings } from './config';
import { TerminalRegistry } from './terminalRegistry';
import { Operation, OperationKind, ResponseEnvelope, wanStore } from './wanStore';

const app = express();
app.set('trust proxy', 1);
const registry = new TerminalRegistry();
type RawRequest = Request & { rawBody?: Buffer };
app.use(express.json({ limit: '256kb', verify: (req, _res, buffer) => { (req as RawRequest).rawBody = Buffer.from(buffer); } }));

const money = z.object({
  terminalId: z.string().optional(), amount: z.number().int().positive().max(2_000_000_000),
  currencySymbol: z.string().trim().length(3).transform(value => value.toUpperCase()),
  cashierId: z.string().trim().min(1).max(6).regex(/^[a-zA-Z0-9]+$/).optional(), printReceipt: z.boolean().optional(),
});
const reversal = z.object({ terminalId: z.string().optional(), receiptNumber: z.string().trim().min(1).max(6), printReceipt: z.boolean().optional() });
const capture = z.object({ terminalId: z.string().optional(), printReceipt: z.boolean().optional(), receiptWidth: z.number().min(30).max(128).optional() });
const printRequest = z.object({ terminalId: z.string().optional(), receiptData: z.string().min(1).max(200_000).refine(isPrinterCommandData, 'receiptData must be base64 or hexadecimal printer-command data') });
const terminalRecords = z.array(z.object({ id: z.string(), name: z.string(), label: z.string() })).min(1).max(50);
const responseEnvelopeSchema = z.object({
  id: z.string().uuid(), createdAt: z.string().datetime({ offset: true }), status: z.string().min(1).max(64),
  data: z.record(z.string(), z.unknown()),
});
const eventEnvelopeSchema = z.object({
  id: z.string().uuid(), createdAt: z.string().datetime({ offset: true }), type: z.string().min(1).max(128),
  operationId: z.string().optional(), data: z.record(z.string(), z.unknown()).optional(),
});
const failedAdminAttempts = new Map<string, { count: number; until: number }>();

function isPrinterCommandData(value: string): boolean {
  const compact = value.replace(/\s/g, '');
  if (!compact) return false;
  const isHex = /^[\da-fA-F]+$/.test(compact) && compact.length % 2 === 0;
  const isBase64 = /^[A-Za-z\d+/]*={0,2}$/.test(compact) && compact.length % 4 !== 1;
  return isHex || isBase64;
}
function selectedId(value: unknown): string {
  if (typeof value === 'string' && value) return value;
  return registry.list().length === 1 ? registry.list()[0].id : '';
}
function publicOperation(operation: Operation) { return { ...operation }; }
async function safeTerminal(terminal: TerminalSettings) {
  const session = await wanStore.session(terminal.id);
  const lastSeen = session?.lastSeen;
  const online = Boolean(lastSeen && Date.now() - Date.parse(lastSeen) < 120_000);
  return {
    id: terminal.id, name: terminal.name, label: terminal.label, online,
    address: `${config.publicBaseUrl}${config.terminalApiPrefix}/${encodeURIComponent(terminal.id)}`,
  };
}
function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'); const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!config.adminPin) { res.status(503).json({ error: 'Settings are locked: configure ADMIN_PIN and restart the server.' }); return; }
  const ip = req.ip || 'unknown';
  const failed = failedAdminAttempts.get(ip);
  if (failed && failed.until > Date.now()) { res.status(429).json({ error: 'Too many incorrect PIN attempts. Wait one minute and try again.' }); return; }
  if (!timingSafeStringEqual(req.get('X-Admin-Pin') ?? '', config.adminPin)) {
    const count = (failed?.count ?? 0) + 1;
    failedAdminAttempts.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
    res.status(401).json({ error: 'Incorrect settings PIN.' }); return;
  }
  failedAdminAttempts.delete(ip); next();
}

function sha256Base64(value: string): string { return createHash('sha256').update(value, 'utf8').digest('base64'); }
function signatureInput(secret: string, timestamp: string, method: string, requestPath: string, status: number | undefined, body: string): string {
  return status === undefined
    ? `${secret}\n${timestamp}\n${method}\n${requestPath}\n${body}\n${secret}`
    : `${secret}\n${timestamp}\n${method}\n${requestPath}\n${status}\n${body}\n${secret}`;
}
function requestPath(req: Request): string { return req.originalUrl.split('?')[0]; }
function verifyTerminalAuthorization(req: Request, terminal: TerminalSettings): string | null {
  const parts = (req.get('Authorization') ?? '').trim().split(/\s+/);
  if (parts.length !== 3 || parts[0] !== 'Samport-Keyed-Hash-v1') return null;
  const [, timestamp, received] = parts;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 15 * 60_000) return null;
  const raw = (req as RawRequest).rawBody;
  const body = raw ? raw.toString('utf8') : '';
  const expected = Buffer.from(sha256Base64(signatureInput(terminal.secret, timestamp, req.method.toUpperCase(), requestPath(req), undefined, body)), 'base64');
  const actual = Buffer.from(received, 'base64');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return timestamp;
}
function sendSigned(req: Request, res: Response, terminal: TerminalSettings, status: number, body?: unknown, timestamp?: string): void {
  const responseBody = body === undefined ? '' : JSON.stringify(body);
  const signedTimestamp = timestamp ?? new Date().toISOString();
  const hash = sha256Base64(signatureInput(terminal.secret, signedTimestamp, req.method.toUpperCase(), requestPath(req), status, responseBody));
  res.status(status).set('Server-Authorization', `Samport-Keyed-Hash-v1 ${signedTimestamp} ${hash}`).set('Cache-Control', 'no-store');
  if (body === undefined) { res.end(); return; }
  res.type('application/json').send(responseBody);
}
async function terminalForRequest(req: Request, res: Response): Promise<{ terminal: TerminalSettings; timestamp: string; sessionId: string } | null> {
  const rawId = req.params.terminalId;
  let terminalId = rawId;
  try { terminalId = decodeURIComponent(rawId); } catch { /* Keep the raw ID; it will fail lookup. */ }
  const terminal = registry.get(terminalId);
  if (!terminal) { res.status(401).end(); return null; }
  const timestamp = verifyTerminalAuthorization(req, terminal);
  if (!timestamp) { sendSigned(req, res, terminal, 401); return null; }
  const protocolVersion = req.get('Protocol-Version');
  const sessionId = req.get('Session-ID') ?? '';
  if (!protocolVersion || !z.string().uuid().safeParse(sessionId).success) {
    sendSigned(req, res, terminal, 400, { error: 'Protocol-Version and a UUID Session-ID header are required.' }, timestamp);
    return null;
  }
  await wanStore.touchTerminal(terminal.id, sessionId);
  return { terminal, timestamp, sessionId };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// WAN routes use terminal HMAC auth; they intentionally bypass browser Basic Auth.
app.get('/v2/terminals/:terminalId/requests', async (req, res) => {
  let terminal: TerminalSettings | undefined;
  let timestamp: string | undefined;
  try {
    const auth = await terminalForRequest(req, res); if (!auth) return;
    terminal = auth.terminal; timestamp = auth.timestamp;
    const deadline = Date.now() + config.pollTimeoutMs;
    while (!res.headersSent && Date.now() < deadline) {
      const envelope = await wanStore.nextRequest(auth.terminal.id);
      if (envelope) { sendSigned(req, res, auth.terminal, 200, envelope, auth.timestamp); return; }
      await sleep(Math.min(config.databasePollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    if (!res.headersSent) sendSigned(req, res, auth.terminal, 204, undefined, auth.timestamp);
  } catch (error) {
    if (terminal && timestamp && !res.headersSent) sendSigned(req, res, terminal, 500, { error: 'WAN state database unavailable.' }, timestamp);
    else if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : 'Request failed' });
    console.error('WAN requests handler failed:', error instanceof Error ? error.message : 'unknown error');
  }
});

app.post('/v2/terminals/:terminalId/responses', async (req, res) => {
  try {
    const auth = await terminalForRequest(req, res); if (!auth) return;
    const parsed = responseEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) { sendSigned(req, res, auth.terminal, 400, { error: 'Invalid ResponseEnvelope.' }, auth.timestamp); return; }
    const result = await wanStore.submitResponse(auth.terminal.id, parsed.data as ResponseEnvelope);
    if (result.error) { sendSigned(req, res, auth.terminal, result.httpStatus, { error: result.error }, auth.timestamp); return; }
    sendSigned(req, res, auth.terminal, result.duplicate ? 201 : 200, undefined, auth.timestamp);
  } catch (error) {
    console.error('WAN response handler failed:', error instanceof Error ? error.message : 'unknown error');
    if (!res.headersSent) res.status(500).json({ error: 'WAN state database unavailable.' });
  }
});

app.post('/v2/terminals/:terminalId/events', async (req, res) => {
  try {
    const auth = await terminalForRequest(req, res); if (!auth) return;
    const parsed = eventEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) { sendSigned(req, res, auth.terminal, 400, { error: 'Invalid EventEnvelope.' }, auth.timestamp); return; }
    await wanStore.submitEvent(auth.terminal.id, parsed.data);
    sendSigned(req, res, auth.terminal, 200, undefined, auth.timestamp);
  } catch (error) {
    console.error('WAN event handler failed:', error instanceof Error ? error.message : 'unknown error');
    if (!res.headersSent) res.status(500).json({ error: 'WAN state database unavailable.' });
  }
});
app.all('/v2/terminals/*', (_req, res) => res.status(404).end());

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Protect the register UI and its operation APIs; terminal routes above use HMAC instead.
app.use((req, res, next) => {
  if (!config.webUsername || !config.webPassword) { next(); return; }
  const header = req.get('Authorization') ?? '';
  let suppliedUser = ''; let suppliedPassword = '';
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) { suppliedUser = decoded.slice(0, separator); suppliedPassword = decoded.slice(separator + 1); }
    } catch { /* Invalid credentials are rejected below. */ }
  }
  if (timingSafeStringEqual(suppliedUser, config.webUsername) && timingSafeStringEqual(suppliedPassword, config.webPassword)) { next(); return; }
  res.set('WWW-Authenticate', 'Basic realm="Showroom ECR", charset="UTF-8"').status(401).send('Authentication required');
});

app.get('/api/config', async (_req, res, next) => {
  try {
    const terminals = await Promise.all(registry.list().map(safeTerminal));
    res.json({ terminalConfigured: true, settingsEnabled: Boolean(config.adminPin), terminals, pollIntervalMs: 1500 });
  } catch (error) { next(error); }
});
app.get('/api/admin/terminals', requireAdmin, (_req, res) => {
  res.json({ terminals: registry.list().map(({ id, name, label }) => ({ id, name, label })) });
});
app.put('/api/admin/terminals', requireAdmin, async (req, res) => {
  try {
    const operations = await wanStore.allOperations();
    if (operations.some(operation => ['starting', 'pending', 'unknown', 'abort-requested'].includes(operation.state))) {
      res.status(409).json({ error: 'Finish or resolve all active terminal operations before saving terminal settings.' }); return;
    }
    const terminals = registry.replace(terminalRecords.parse(req.body?.terminals));
    await wanStore.initialize(terminals.map(terminal => terminal.id));
    res.json({ terminals: terminals.map(({ id, name, label }) => ({ id, name, label })) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid terminal settings', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) }); return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save terminal settings' });
  }
});

app.get('/api/operations/current', async (req, res, next) => {
  try {
    const terminalId = selectedId(req.query.terminalId);
    if (!registry.get(terminalId)) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
    const operation = await wanStore.latestOperation(terminalId);
    res.json(operation ? publicOperation(operation) : null);
  } catch (error) { next(error); }
});
app.post('/api/operations/payment', (req, res, next) => startOperation('payment', req, res, next));
app.post('/api/operations/refund', (req, res, next) => startOperation('refund', req, res, next));
app.post('/api/operations/reversal', (req, res, next) => startOperation('reversal', req, res, next));
app.post('/api/operations/capture', (req, res, next) => startOperation('capture', req, res, next));
app.post('/api/operations/print', (req, res, next) => startOperation('print', req, res, next));

function requestType(kind: OperationKind): string {
  return ({ payment: 'Payment', refund: 'Refund', reversal: 'Reversal', capture: 'Capture', print: 'Print' })[kind];
}
async function startOperation(kind: OperationKind, req: Request, res: Response, next: NextFunction) {
  const terminalId = selectedId(req.body?.terminalId);
  const terminal = registry.get(terminalId);
  if (!terminal) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
  let payload: Record<string, unknown>;
  try {
    if (kind === 'payment' || kind === 'refund') {
      const input = money.parse(req.body);
      payload = { amounts: { base: input.amount, currencySymbol: input.currencySymbol }, ...(input.cashierId ? { cashierId: input.cashierId } : {}), ...(input.printReceipt !== undefined ? { printReceipt: input.printReceipt } : {}) };
    } else if (kind === 'reversal') {
      const input = reversal.parse(req.body);
      payload = { receiptNumber: input.receiptNumber, ...(input.printReceipt !== undefined ? { printReceipt: input.printReceipt } : {}) };
    } else if (kind === 'capture') {
      const input = capture.parse(req.body);
      payload = { ...(input.printReceipt !== undefined ? { printReceipt: input.printReceipt } : {}), ...(input.receiptWidth !== undefined ? { receiptWidth: input.receiptWidth } : {}) };
    } else {
      const input = printRequest.parse(req.body);
      payload = { receiptData: input.receiptData };
    }
  } catch (error) { next(error); return; }

  try {
    const operationId = randomUUID();
    const operation: Operation = { operationId, terminalId, kind, state: 'pending', createdAt: new Date().toISOString(), message: 'Queued for delivery to the terminal.' };
    payload.operationId = operationId;
    const result = await wanStore.createOperation(operation, terminal.integrationKey, requestType(kind), payload);
    if (result.conflict) {
      res.status(409).json({ error: `Terminal ${terminal.label} already has an active operation. Finish or resolve it first.`, operationId: result.operation.operationId }); return;
    }
    res.status(202).json(publicOperation(result.operation));
  } catch (error) { next(error); }
}

app.get('/api/operations/:operationId', async (req, res, next) => {
  try {
    const operation = await wanStore.getOperation(req.params.operationId);
    if (!operation) { res.status(404).json({ error: 'Operation not found.' }); return; }
    res.json(publicOperation(operation));
  } catch (error) { next(error); }
});
app.post('/api/operations/:operationId/abort', async (req, res, next) => {
  try {
    const operation = await wanStore.getOperation(req.params.operationId);
    if (!operation || (await wanStore.activeOperation(operation.terminalId))?.operationId !== operation.operationId) {
      res.status(404).json({ error: 'No active operation with that ID.' }); return;
    }
    if (!['starting', 'pending', 'unknown', 'abort-requested'].includes(operation.state)) {
      res.status(409).json({ error: 'This operation is no longer in progress.', operation: publicOperation(operation) }); return;
    }
    if (operation.state !== 'abort-requested') {
      const terminal = registry.get(operation.terminalId);
      if (!terminal) { res.status(500).json({ error: 'Operation terminal is no longer configured.' }); return; }
      await wanStore.enqueueAbort(operation.terminalId, terminal.integrationKey, operation.operationId);
    }
    const updated = await wanStore.getOperation(operation.operationId);
    res.json(publicOperation(updated ?? operation));
  } catch (error) { next(error); }
});

app.get('/api/payments/latest', getPaymentRoute(true));
app.get('/api/payments/:receiptNumber', getPaymentRoute(false));
function statusCodeForWan(status: string): number {
  const codes: Record<string, number> = { NotFound: 404, BadRequest: 400, Unauthorized: 401, Forbidden: 403, TooManyRequests: 429, ServiceUnavailable: 503, InternalServerError: 500 };
  return codes[status] ?? 502;
}
async function waitForResponse(messageId: string, timeoutMs: number): Promise<ResponseEnvelope | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const response = await wanStore.responseFor(messageId);
    if (response) return response;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(config.databasePollIntervalMs, deadline - Date.now()));
  } while (Date.now() < deadline);
  return undefined;
}
function getPaymentRoute(latest: boolean) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const terminalId = selectedId(req.query.terminalId);
      const terminal = registry.get(terminalId);
      if (!terminal) { res.status(400).json({ error: 'Select a configured terminal.' }); return; }
      const receiptNumber = req.params.receiptNumber;
      if (!latest && (!receiptNumber || !/^\d{6}$/.test(receiptNumber))) { res.status(400).json({ error: 'Receipt number must contain exactly 6 digits.' }); return; }
      const envelope = await wanStore.enqueue(terminalId, terminal.integrationKey, 'GetPayment', latest ? {} : { receiptNumber });
      const response = await waitForResponse(envelope.id, config.modelessTimeoutMs);
      if (!response) { res.status(504).json({ error: 'Timed out waiting for a response from the terminal. The request remains queued and may still complete.' }); return; }
      if (response.status !== 'OK') {
        res.status(statusCodeForWan(response.status)).json({ error: typeof response.data.description === 'string' ? response.data.description : response.status }); return;
      }
      res.json(response.data);
    } catch (error) { next(error); }
  };
}

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (req.path.startsWith('/v2/terminals/')) {
    const match = req.path.match(/^\/v2\/terminals\/([^/]+)\/(requests|responses|events)$/);
    let terminalId = match?.[1] ?? '';
    try { terminalId = decodeURIComponent(terminalId); } catch { /* no-op */ }
    const terminal = registry.get(terminalId);
    if (terminal) {
      const timestamp = verifyTerminalAuthorization(req, terminal);
      if (timestamp) { sendSigned(req, res, terminal, 400, { error: 'Invalid JSON request body.' }, timestamp); return; }
      sendSigned(req, res, terminal, 401); return;
    }
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid request', details: error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })) }); return;
  }
  console.error('Request failed:', error instanceof Error ? error.message : 'unknown error');
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected server error' });
});

const staticDir = path.resolve(process.cwd(), 'web/dist');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
}

async function start(): Promise<void> {
  await wanStore.initialize(registry.list().map(terminal => terminal.id));
  app.listen(config.apiPort, '0.0.0.0', () => {
    console.log(`WAN showroom ECR listening on port ${config.apiPort}; ${registry.list().length} terminal(s) configured; Supabase state store connected.`);
  });
}
start().catch(error => {
  console.error('Could not initialize WAN state database:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
