import dotenv from 'dotenv';
import path from 'node:path';
import { existsSync } from 'node:fs';

dotenv.config();

export type TerminalSettings = {
  id: string;
  name: string;
  label: string;
  integrationKey: string;
  secret: string;
};

export type TerminalRecord = Pick<TerminalSettings, 'id' | 'name' | 'label'>;

function clean(name: string, value = process.env[name]): string {
  const result = value?.trim() ?? '';
  return result.startsWith('REPLACE_WITH_') ? '' : result;
}

function required(name: string, value: string): string {
  if (!value) throw new Error(`Missing configuration: ${name}. Set it in the environment or .env file.`);
  return value;
}

function terminalEnvKey(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function terminalCredentials(id: string) {
  const key = terminalEnvKey(id);
  return {
    integrationKey: clean(`TERMINAL_${key}_INTEGRATION_KEY`) || clean('INTEGRATION_KEY'),
    secret: clean(`TERMINAL_${key}_SECRET`) || clean('TERMINAL_SECRET'),
  };
}

function readBootstrapRecords(): TerminalRecord[] {
  const terminalsFile = clean('TERMINALS_FILE') || path.join(clean('DATA_DIR') || 'data', 'terminals.json');
  // The persisted settings list is authoritative after the first save.
  if (existsSync(path.resolve(process.cwd(), terminalsFile))) return [];

  const ids = (clean('TERMINALS') || clean('TERMINAL_ID') || 'terminal')
    .split(',').map(value => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  return ids.map(id => {
    const normalized = id.toLowerCase();
    if (seen.has(normalized)) throw new Error(`Duplicate terminal id in TERMINALS: ${id}`);
    seen.add(normalized);
    const key = terminalEnvKey(id);
    return {
      id,
      name: clean(`TERMINAL_${key}_NAME`) || clean(`TERMINAL_${key}_LABEL`) || id,
      label: clean(`TERMINAL_${key}_LABEL`) || id,
    };
  });
}

const webUsername = clean('WEB_USERNAME');
const webPassword = clean('WEB_PASSWORD');
if ((webUsername && !webPassword) || (!webUsername && webPassword)) {
  throw new Error('Set both WEB_USERNAME and WEB_PASSWORD, or neither (the latter is for local development only).');
}
if (process.env.NODE_ENV === 'production' && (!webUsername || !webPassword)) {
  throw new Error('WEB_USERNAME and WEB_PASSWORD are required in production to protect the public cash-register UI and API.');
}

const dataDir = clean('DATA_DIR') || 'data';
const supabaseUrl = clean('SUPABASE_URL');
const supabaseServiceRoleKey = clean('SUPABASE_SERVICE_ROLE_KEY');
if (Boolean(supabaseUrl) !== Boolean(supabaseServiceRoleKey)) {
  throw new Error('Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
}
if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for durable WAN state.');
}
const adminPin = clean('ADMIN_PIN');
if (adminPin && adminPin.length < 6) throw new Error('ADMIN_PIN must be at least 6 characters.');

export const config = {
  initialTerminals: readBootstrapRecords(),
  terminalsFile: clean('TERMINALS_FILE') || path.join(dataDir, 'terminals.json'),
  // Durable request/operation/session state lives in Supabase PostgreSQL.
  supabaseUrl: (clean('SUPABASE_URL') || '').replace(/\/$/, ''),
  supabaseServiceRoleKey: clean('SUPABASE_SERVICE_ROLE_KEY'),
  databasePollIntervalMs: Number(clean('DATABASE_POLL_INTERVAL_MS') || 1000),
  terminalApiPrefix: '/v2/terminals',
  apiPort: Number(process.env.PORT || process.env.API_PORT || 3001),
  pollTimeoutMs: 45_000,
  modelessTimeoutMs: Number(clean('MODELESS_TIMEOUT_MS') || 70_000),
  verifyServerSignature: true,
  adminPin,
  webUsername,
  webPassword,
  publicBaseUrl: (clean('PUBLIC_BASE_URL') || clean('RENDER_EXTERNAL_URL') || 'http://localhost:3001').replace(/\/$/, ''),
};

export function makeTerminalSettings(record: TerminalRecord): TerminalSettings {
  const id = String(record.id ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`Invalid terminal ID "${id}". Use 1-64 letters, numbers, dash or underscore.`);
  }
  const name = String(record.name ?? '').trim();
  const label = String(record.label ?? '').trim();
  if (!name || name.length > 80) throw new Error(`Terminal ${id}: name is required (max 80 characters).`);
  if (!label || label.length > 80) throw new Error(`Terminal ${id}: site label is required (max 80 characters).`);
  const credentials = terminalCredentials(id);
  return {
    id,
    name,
    label,
    integrationKey: required(`integration key for terminal ${id}`, credentials.integrationKey),
    secret: required(`secret key for terminal ${id}`, credentials.secret),
  };
}
