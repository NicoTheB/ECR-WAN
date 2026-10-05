import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, makeTerminalSettings, TerminalRecord, TerminalSettings } from './config';

const storagePath = path.resolve(process.cwd(), config.terminalsFile);

function readRecords(): TerminalRecord[] {
  if (!existsSync(storagePath)) return config.initialTerminals.map(record => ({ ...record }));
  const parsed: unknown = JSON.parse(readFileSync(storagePath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`Terminal settings file must contain an array: ${storagePath}`);
  return parsed.map((value: any) => ({
    id: String(value.id ?? ''),
    name: String(value.name ?? value.id ?? ''),
    label: String(value.label ?? ''),
  }));
}

export class TerminalRegistry {
  private terminals = new Map<string, TerminalSettings>();

  constructor() {
    for (const record of readRecords()) {
      const terminal = makeTerminalSettings(record);
      if (this.terminals.has(terminal.id)) throw new Error(`Duplicate terminal ID in settings: ${terminal.id}`);
      this.terminals.set(terminal.id, terminal);
    }
    if (!this.terminals.size) throw new Error('Configure at least one terminal with TERMINALS and its credentials.');
  }

  list(): TerminalSettings[] { return [...this.terminals.values()]; }
  get(id: string): TerminalSettings | undefined { return this.terminals.get(id); }

  replace(records: TerminalRecord[]): TerminalSettings[] {
    if (!Array.isArray(records) || records.length < 1 || records.length > 50) {
      throw new Error('Configure between 1 and 50 terminals.');
    }
    const next: TerminalSettings[] = [];
    const ids = new Set<string>();
    for (const record of records) {
      const terminal = makeTerminalSettings(record);
      const key = terminal.id.toLowerCase();
      if (ids.has(key)) throw new Error(`Duplicate terminal ID: ${terminal.id}`);
      ids.add(key);
      next.push(terminal);
    }

    mkdirSync(path.dirname(storagePath), { recursive: true });
    const temporary = `${storagePath}.${process.pid}.tmp`;
    const publicRecords = next.map(({ id, name, label }) => ({ id, name, label }));
    writeFileSync(temporary, `${JSON.stringify(publicRecords, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, storagePath);
    this.terminals = new Map(next.map(terminal => [terminal.id, terminal]));
    return this.list();
  }
}
