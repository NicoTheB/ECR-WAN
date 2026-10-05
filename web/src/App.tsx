import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type Kind = 'payment' | 'refund' | 'reversal' | 'capture';
type OperationKind = Kind | 'print';
type OperationState = 'starting' | 'pending' | 'unknown' | 'abort-requested' | 'completed' | 'failed';
type Op = {
  operationId: string;
  terminalId: string;
  kind: OperationKind;
  state: OperationState;
  createdAt: string;
  result?: Record<string, any> | null;
  message?: string;
};
type Terminal = { id: string; name: string; label: string; online: boolean; address: string };
type TerminalConfig = { terminals: Terminal[]; pollIntervalMs: number; settingsEnabled: boolean };
type TerminalEdit = { id: string; name: string; label: string; isNew?: boolean };
type Product = { id: string; name: string; category: string; priceMinor: number; description?: string };
type ProductCatalog = { currency: string; minorUnitDivisor: number; products: Product[] };
type ReceiptToPrint = { receiptNumber?: string; plain?: string; printerCommands?: string; source: string };

const labels: Record<OperationKind, string> = { payment: 'Payment', refund: 'Refund', reversal: 'Reversal', capture: 'Capture', print: 'Terminal receipt print' };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

function getReceiptContent(response: any, source: string): ReceiptToPrint | null {
  const receipt = response?.receipt;
  if (!receipt) return null;
  const customer = receipt.customer ?? {};
  const merchant = receipt.merchant ?? {};
  const embedded = customer.embeddedPlain ?? merchant.embeddedPlain;
  const plain = customer.plain ?? merchant.plain ?? (embedded ? [embedded.header, embedded.content, embedded.footer].filter(Boolean).join('\n') : undefined);
  const printerCommands = customer.escpos ?? merchant.escpos;
  if (!plain && !printerCommands) return null;
  return { receiptNumber: response.receiptNumber, plain, printerCommands, source };
}

function printPlainReceipt(receiptText: string): boolean {
  const printWindow = window.open('', '_blank', 'width=480,height=720');
  if (!printWindow) return false;
  const doc = printWindow.document;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><title>Transaction receipt</title><style>body{margin:0;padding:12mm;color:#111;background:#fff;font:12px/1.35 monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}@media print{body{padding:0}}</style></head><body><pre></pre></body></html>');
  doc.close();
  const pre = doc.querySelector('pre');
  if (pre) pre.textContent = receiptText;
  printWindow.focus();
  window.setTimeout(() => {
    printWindow.print();
    printWindow.onafterprint = () => printWindow.close();
  }, 200);
  return true;
}

export default function App() {
  const [config, setConfig] = useState<TerminalConfig | null>(null);
  const [selectedTerminalId, setSelectedTerminalId] = useState('');
  const selectedTerminalRef = useRef('');
  const [catalog, setCatalog] = useState<ProductCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [view, setView] = useState<'products' | 'manual' | 'settings'>('products');
  const [category, setCategory] = useState('All');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartOperationId, setCartOperationId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>('payment');
  const [amount, setAmount] = useState('100');
  const [currency, setCurrency] = useState('DKK');
  const [receipt, setReceipt] = useState('');
  const [receiptSearch, setReceiptSearch] = useState('');
  const [receiptToPrint, setReceiptToPrint] = useState<ReceiptToPrint | null>(null);
  const [cashierId, setCashierId] = useState('');
  const [operation, setOperation] = useState<Op | null>(null);
  const [latest, setLatest] = useState<Record<string, any> | null>(null);
  const [latestError, setLatestError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [adminPin, setAdminPin] = useState('');
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [settings, setSettings] = useState<TerminalEdit[]>([]);
  const [settingsMessage, setSettingsMessage] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const polling = useRef(false);

  useEffect(() => {
    api<TerminalConfig>('/api/config').then(value => {
      setConfig(value);
      if (value.terminals.length) setSelectedTerminalId(current => current || value.terminals[0].id);
    }).catch(e => setNotice(e.message));
    fetch('/products.json').then(async response => {
      if (!response.ok) throw new Error(`Could not load products.json (${response.status})`);
      return response.json() as Promise<ProductCatalog>;
    }).then(value => {
      if (!value.currency || !Number.isFinite(value.minorUnitDivisor) || value.minorUnitDivisor <= 0 || !Array.isArray(value.products)) {
        throw new Error('Product configuration is missing currency, minorUnitDivisor, or products.');
      }
      setCatalog(value);
    }).catch(e => setCatalogError(e instanceof Error ? e.message : 'Could not load product list'));
  }, []);

  useEffect(() => {
    selectedTerminalRef.current = selectedTerminalId;
    if (!selectedTerminalId) return;
    setOperation(null);
    setLatest(null);
    setReceiptToPrint(null);
    const query = `?terminalId=${encodeURIComponent(selectedTerminalId)}`;
    api<Op | null>(`/api/operations/current${query}`).then(current => {
      if (selectedTerminalRef.current === selectedTerminalId) setOperation(current);
    }).catch(e => setNotice(e.message));
  }, [selectedTerminalId]);

  useEffect(() => {
    if (!operation || !['starting', 'pending', 'unknown', 'abort-requested'].includes(operation.state)) return;
    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const updated = await api<Op>(`/api/operations/${encodeURIComponent(operation.operationId)}`);
        if (selectedTerminalRef.current === updated.terminalId) setOperation(updated);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : 'Could not check operation status');
      } finally { polling.current = false; }
    }, config?.pollIntervalMs ?? 1500);
    return () => window.clearInterval(timer);
  }, [operation?.operationId, operation?.state, config?.pollIntervalMs]);

  const categories = useMemo(() => ['All', ...new Set((catalog?.products ?? []).map(product => product.category))], [catalog]);
  const visibleProducts = useMemo(() => (catalog?.products ?? []).filter(product => category === 'All' || product.category === category), [catalog, category]);
  const cartLines = useMemo(() => (catalog?.products ?? []).filter(product => (cart[product.id] ?? 0) > 0).map(product => ({ product, quantity: cart[product.id] })), [catalog, cart]);
  const cartTotalMinor = cartLines.reduce((sum, line) => sum + line.product.priceMinor * line.quantity, 0);
  const formatPrice = (minor: number) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: catalog?.currency ?? 'DKK',
    minimumFractionDigits: Math.log10(catalog?.minorUnitDivisor ?? 100),
    maximumFractionDigits: Math.log10(catalog?.minorUnitDivisor ?? 100),
  }).format(minor / (catalog?.minorUnitDivisor ?? 100));
  const selectedTerminal = config?.terminals.find(t => t.id === selectedTerminalId);
  const operationIsActive = !!operation && operation.terminalId === selectedTerminalId && ['starting', 'pending', 'unknown', 'abort-requested'].includes(operation.state);
  const result = operation?.result as any;
  const responseCurrency = result?.amounts?.currency?.symbol ?? result?.amounts?.currencySymbol;

  useEffect(() => {
    if (operation?.state === 'completed') {
      const content = getReceiptContent(operation.result, `${labels[operation.kind]} response`);
      if (content && selectedTerminalRef.current === operation.terminalId) setReceiptToPrint(content);
    }
  }, [operation?.state, operation?.operationId, operation?.terminalId, operation?.kind, operation?.result]);

  useEffect(() => {
    if (operation?.kind === 'payment' && operation.state === 'completed' && operation.operationId === cartOperationId && result?.transactionOutcome === 'Approved') {
      setCart({});
      setCartOperationId(null);
      setNotice('Payment approved. The cart has been cleared.');
    }
  }, [operation?.state, operation?.operationId, cartOperationId, result?.transactionOutcome]);

  function changeCart(productId: string, change: number) {
    setCart(current => {
      const quantity = Math.max(0, Math.min(99, (current[productId] ?? 0) + change));
      const next = { ...current };
      if (quantity === 0) delete next[productId]; else next[productId] = quantity;
      return next;
    });
  }

  async function startOperation(operationKind: Kind, body: Record<string, unknown>, fromCart = false) {
    setNotice('');
    setReceiptToPrint(null);
    setBusy(true);
    try {
      const started = await api<Op>(`/api/operations/${operationKind}`, { method: 'POST', body: JSON.stringify(body) });
      setOperation(started);
      if (fromCart) setCartOperationId(started.operationId);
      if (started.state === 'unknown') setNotice('The terminal response was uncertain. Checking this operation; do not retry yet.');
      setLatest(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not start operation');
    } finally { setBusy(false); }
  }

  async function checkout() {
    if (!selectedTerminalId || !catalog || cartTotalMinor <= 0) return;
    await startOperation('payment', { terminalId: selectedTerminalId, amount: cartTotalMinor, currencySymbol: catalog.currency }, true);
  }

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    const body = kind === 'reversal'
      ? { terminalId: selectedTerminalId, receiptNumber: receipt.trim() }
      : kind === 'capture'
        ? { terminalId: selectedTerminalId }
        : { terminalId: selectedTerminalId, amount: Number(amount), currencySymbol: currency.trim().toUpperCase(), ...(cashierId.trim() ? { cashierId: cashierId.trim() } : {}) };
    await startOperation(kind, body);
  }

  async function abort() {
    if (!operation) return;
    setBusy(true); setNotice('');
    try { setOperation(await api<Op>(`/api/operations/${encodeURIComponent(operation.operationId)}/abort`, { method: 'POST' })); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'Abort request failed'); }
    finally { setBusy(false); }
  }

  async function loadReceipt(receiptNumber: string) {
    setBusy(true); setLatestError(''); setNotice('');
    try {
      const found = await api<Record<string, any>>(`/api/payments/${encodeURIComponent(receiptNumber)}?terminalId=${encodeURIComponent(selectedTerminalId)}`);
      setLatest(found);
      const content = getReceiptContent(found, `Payment ${receiptNumber}`);
      setReceiptToPrint(content);
      if (!content) setLatestError('Payment was found, but its response does not contain receipt data for printing.');
    } catch (e) { setLatestError(e instanceof Error ? e.message : 'Could not retrieve payment'); }
    finally { setBusy(false); }
  }

  async function getLatest() {
    setBusy(true); setLatestError(''); setLatest(null); setNotice('');
    try {
      const found = await api<Record<string, any>>(`/api/payments/latest?terminalId=${encodeURIComponent(selectedTerminalId)}`);
      setLatest(found);
      setReceiptToPrint(getReceiptContent(found, 'Latest payment'));
    } catch (e) { setLatestError(e instanceof Error ? e.message : 'Could not retrieve latest payment'); }
    finally { setBusy(false); }
  }

  async function printOnTerminal() {
    if (!receiptToPrint?.printerCommands || !selectedTerminalId) return;
    setBusy(true); setNotice('');
    try {
      const started = await api<Op>('/api/operations/print', {
        method: 'POST',
        body: JSON.stringify({ terminalId: selectedTerminalId, receiptData: receiptToPrint.printerCommands }),
      });
      setOperation(started);
      if (started.state === 'unknown') setNotice('Print request outcome is uncertain; checking terminal status.');
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not start terminal receipt print'); }
    finally { setBusy(false); }
  }

  async function unlockSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true); setSettingsMessage('');
    try {
      const data = await api<{ terminals: TerminalEdit[] }>('/api/admin/terminals', { headers: { 'X-Admin-Pin': adminPin } });
      setSettings(data.terminals.map(t => ({ ...t, isNew: false })));
      setSettingsUnlocked(true);
      setSettingsMessage('Settings unlocked.');
    } catch (e) { setSettingsMessage(e instanceof Error ? e.message : 'Could not unlock settings'); }
    finally { setSettingsBusy(false); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setSettingsBusy(true); setSettingsMessage('');
    try {
      const terminals = await api<{ terminals: TerminalEdit[] }>('/api/admin/terminals', {
        method: 'PUT',
        headers: { 'X-Admin-Pin': adminPin },
        body: JSON.stringify({ terminals: settings.map(({ isNew: _isNew, ...t }) => t) }),
      });
      const updatedConfig = await api<TerminalConfig>('/api/config');
      setConfig(updatedConfig);
      setSettings(terminals.terminals.map(t => ({ ...t, isNew: false })));
      setSelectedTerminalId(current => updatedConfig.terminals.some(t => t.id === current) ? current : updatedConfig.terminals[0]?.id ?? '');
      setSettingsMessage('Terminal settings saved.');
    } catch (e) { setSettingsMessage(e instanceof Error ? e.message : 'Could not save terminal settings'); }
    finally { setSettingsBusy(false); }
  }

  function updateSetting(index: number, field: 'id' | 'name' | 'label', value: string) {
    setSettings(current => current.map((row, i) => {
      if (i !== index) return row;
      const next = { ...row };
      next[field] = value;
      return next;
    }));
  }

  function addTerminal() {
    const suffix = Date.now().toString(36).slice(-6);
    setSettings(current => [...current, { id: `terminal-${suffix}`, name: 'New terminal', label: 'New terminal', isNew: true }]);
  }

  async function refreshConfig() {
    const value = await api<TerminalConfig>('/api/config');
    setConfig(value);
    setSelectedTerminalId(current => value.terminals.some(t => t.id === current) ? current : value.terminals[0]?.id ?? '');
  }

  const operationStatus = <section className="card status-card">
    <div className="card-title"><div><span className="eyebrow">LIVE STATUS</span><h3>Terminal operation</h3></div><span className="step">STATUS</span></div>
    {!operation || operation.terminalId !== selectedTerminalId ? <div className="empty-state"><div className="empty-icon">↗</div><strong>Ready for an operation</strong><p>The selected terminal's current operation and result will appear here.</p></div> : <>
      <div className={`state-banner ${operation.state}`}><span className="state-dot" /><div><strong>{stateLabel(operation.state)}</strong><span>{operation.message || (operation.state === 'pending' ? 'Waiting for the terminal operation to finish.' : operation.state === 'completed' ? 'Terminal returned the final operation response.' : operation.state === 'failed' ? 'The terminal did not accept the operation.' : 'Requesting operation status from terminal…')}</span></div></div>
      <div className="meta-row"><span>Terminal</span><span>{selectedTerminal?.label ?? operation.terminalId}</span></div>
      <div className="meta-row"><span>Operation</span><code>{operation.operationId}</code></div>
      <div className="meta-row"><span>Type</span><span>{labels[operation.kind]}</span></div>
      <div className="meta-row"><span>Started</span><span>{new Date(operation.createdAt).toLocaleTimeString()}</span></div>
      {operation.result && <div className="result-box"><div className="result-heading">FINAL RESPONSE</div><div className="meta-row"><span>Result</span><strong className={result?.transactionOutcome === 'Approved' || result?.printResult === 'Success' ? 'approved' : ''}>{result?.transactionOutcome ?? result?.printResult ?? 'Completed'}</strong></div>{result?.outcomeDescription && <div className="meta-row"><span>Description</span><span>{result.outcomeDescription}</span></div>}{result?.receiptNumber !== undefined && <div className="meta-row"><span>Receipt</span><span>{result.receiptNumber}</span></div>}{result?.approvalCode && <div className="meta-row"><span>Approval code</span><span>{result.approvalCode}</span></div>}{result?.amounts && <div className="meta-row"><span>Amount</span><span>{result.amounts.total !== undefined ? `${result.amounts.total} ${responseCurrency ?? ''}` : formatPrice(result.amounts.base ?? 0)}</span></div>}<details><summary>Full terminal response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></div>}
      {operationIsActive && <button className="abort" type="button" onClick={abort} disabled={busy || operation.state === 'abort-requested'}>{operation.state === 'abort-requested' ? 'Abort requested…' : 'Abort operation'}</button>}
    </>}
    {notice && <div className="notice" role="alert">{notice}</div>}
  </section>;

  return <main className="shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">W</div><div><span className="eyebrow">SAMPORT INSTORE TERMINALS</span><h1>Showroom ECR</h1></div></div>
      <div className="terminal-pill"><span className={`dot ${selectedTerminal?.online ? 'online' : ''}`} />{selectedTerminal?.label ?? 'Connecting to backend…'}{selectedTerminal ? ` · WAN ${selectedTerminal.online ? 'online' : 'offline'}` : ''}</div>
    </header>

    <section className="intro"><div><span className="eyebrow">ECR · ASYNCHRONOUS MODE</span><h2>Showroom ECR</h2><p>Build a product cart or start a manual terminal operation.</p></div><div className="intro-badge">TEST / SHOWROOM</div></section>

    {config && config.terminals.length > 1 && <div className="terminal-toolbar"><label htmlFor="terminal-select">Active terminal</label><select id="terminal-select" value={selectedTerminalId} onChange={e => { setLatest(null); setLatestError(''); setReceiptToPrint(null); setNotice(''); setSelectedTerminalId(e.target.value); }} disabled={busy}><option value="" disabled>Select a terminal</option>{config.terminals.map(t => <option key={t.id} value={t.id}>{t.label}{t.name && t.name !== t.label ? ` · ${t.name}` : ''} </option>)}</select><span>Operations are tracked separately for each terminal.</span></div>}

    <div className="register-tabs" role="tablist" aria-label="Register mode">
      <button type="button" role="tab" aria-selected={view === 'products'} className={view === 'products' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('products'); setNotice(''); }}>Product register</button>
      <button type="button" role="tab" aria-selected={view === 'manual'} className={view === 'manual' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('manual'); setNotice(''); }}>Manual operations</button>
      <button type="button" role="tab" aria-selected={view === 'settings'} className={view === 'settings' ? 'register-tab selected' : 'register-tab'} onClick={() => { setView('settings'); setNotice(''); setSettingsMessage(''); }}>Terminal settings</button>
    </div>

    {view === 'products' ? <>
      <div className="product-layout">
        <section className="card catalog-card">
          <div className="card-title"><div><span className="eyebrow">PRODUCT CATALOG</span><h3>Tap to add products</h3></div><span className="step">{catalog?.products.length ?? '—'} ITEMS</span></div>
          {catalogError && <div className="notice" role="alert">{catalogError} Check `public/products.json` in the project root.</div>}
          {!catalog && !catalogError && <p className="muted">Loading product catalog…</p>}
          {catalog && <>
            <div className="category-list">{categories.map(value => <button type="button" key={value} className={category === value ? 'category-chip active' : 'category-chip'} onClick={() => setCategory(value)}>{value}</button>)}</div>
            <div className="product-grid">{visibleProducts.map(product => <button type="button" className="product-tile" key={product.id} onClick={() => changeCart(product.id, 1)} disabled={!selectedTerminalId || operationIsActive}>
              <span className="product-category">{product.category}</span><strong>{product.name}</strong>{product.description && <span className="product-description">{product.description}</span>}<span className="product-price">{formatPrice(product.priceMinor)}</span>
            </button>)}</div>
            {visibleProducts.length === 0 && <p className="muted">No products in this category.</p>}
          </>}
        </section>

        <section className="card cart-card">
          <div className="card-title"><div><span className="eyebrow">CURRENT ORDER</span><h3>Cart <span className="cart-count">{cartLines.reduce((sum, line) => sum + line.quantity, 0)}</span></h3></div><button className="text-button" type="button" disabled={!cartLines.length || operationIsActive || busy} onClick={() => setCart({})}>Clear</button></div>
          {cartLines.length === 0 ? <div className="empty-cart"><div className="empty-icon">＋</div><strong>Cart is empty</strong><p>Select a product to start an order.</p></div> : <div className="cart-lines">{cartLines.map(({ product, quantity }) => <div className="cart-line" key={product.id}>
            <div className="cart-line-info"><strong>{product.name}</strong><span>{formatPrice(product.priceMinor)} each</span></div>
            <div className="quantity-control"><button type="button" aria-label={`Remove one ${product.name}`} onClick={() => changeCart(product.id, -1)} disabled={operationIsActive || busy}>−</button><span>{quantity}</span><button type="button" aria-label={`Add one ${product.name}`} onClick={() => changeCart(product.id, 1)} disabled={operationIsActive || busy}>＋</button></div>
            <strong className="line-total">{formatPrice(product.priceMinor * quantity)}</strong>
          </div>)}</div>}
          <div className="cart-total"><span>Total</span><strong>{formatPrice(cartTotalMinor)}</strong></div>
          <button className="primary checkout-button" type="button" disabled={busy || operationIsActive || !selectedTerminalId || !catalog || cartTotalMinor <= 0} onClick={checkout}>{busy ? 'Please wait…' : 'Pay at selected terminal'}<span>→</span></button>
          <p className="security-note"><span>◆</span> Product lines stay in this register; the terminal receives the total amount only.</p>
        </section>
      </div>
      {operationStatus}
    </> : view === 'manual' ? <>
      <div className="layout">
        <section className="card transaction-card">
          <div className="card-title"><div><span className="eyebrow">MANUAL TRANSACTION</span><h3>Operation</h3></div><span className="step">01</span></div>
          <div className="tabs" role="tablist">{(['payment', 'refund', 'reversal', 'capture'] as Kind[]).map(value => <button type="button" key={value} role="tab" aria-selected={kind === value} className={kind === value ? 'tab selected' : 'tab'} disabled={operationIsActive || busy} onClick={() => { setKind(value); setNotice(''); }}>{labels[value]}</button>)}</div>
          <form onSubmit={submitManual}>
            {kind === 'payment' || kind === 'refund' ? <>
              <label>Amount <span className="hint">integer in terminal currency units</span></label>
              <div className="amount-row"><input className="amount-input" type="number" min="1" step="1" required value={amount} onChange={e => setAmount(e.target.value)} disabled={operationIsActive || busy} /><select aria-label="Currency" value={currency} onChange={e => setCurrency(e.target.value)} disabled={operationIsActive || busy}><option>SEK</option><option>EUR</option><option>USD</option><option>NOK</option><option>DKK</option><option>GBP</option></select></div>
              {kind === 'payment' && <><label htmlFor="cashier">Cashier ID <span className="hint">optional</span></label><input id="cashier" type="text" maxLength={6} placeholder="e.g. CS01" value={cashierId} onChange={e => setCashierId(e.target.value)} disabled={operationIsActive || busy} /></>}
            </> : kind === 'reversal' ? <><label htmlFor="receipt">Original receipt number</label><input id="receipt" type="text" required maxLength={6} placeholder="e.g. 000013" value={receipt} onChange={e => setReceipt(e.target.value)} disabled={operationIsActive || busy} /><p className="field-note">The terminal uses this reference to identify the transaction to reverse.</p></> : <p className="field-note">Capture runs the terminal's CaptureAll / End-of-Day settlement operation.</p>}
            <button className="primary" type="submit" disabled={busy || operationIsActive || !config || !selectedTerminalId}>{busy ? 'Please wait…' : `Start ${labels[kind].toLowerCase()}`}<span>→</span></button>
          </form>
          <p className="security-note"><span>◆</span> Terminal credentials stay on the backend. Never retry while an operation outcome is unknown.</p>
        </section>
        {operationStatus}
      </div>
    </> : <section className="card settings-card">
      <div className="card-title"><div><span className="eyebrow">BACKEND-MANAGED</span><h3>Terminal configuration</h3></div><span className="step">ADMIN</span></div>
      {!config?.settingsEnabled && <div className="notice" role="alert">Terminal settings are locked. Add `ADMIN_PIN` to the backend `.env` file and restart the app to enable this page.</div>}
      {!settingsUnlocked ? <form className="settings-unlock" onSubmit={unlockSettings}>
        <p>Enter the administrator PIN to load and edit the terminal list. The PIN stays in this browser session and is never written to disk.</p>
        <label htmlFor="admin-pin">Administrator PIN</label><input id="admin-pin" type="password" inputMode="numeric" autoComplete="current-password" value={adminPin} onChange={e => setAdminPin(e.target.value)} disabled={!config?.settingsEnabled || settingsBusy} />
        <button className="primary settings-submit" type="submit" disabled={!config?.settingsEnabled || settingsBusy || !adminPin}>{settingsBusy ? 'Checking…' : 'Unlock settings'}<span>→</span></button>
      </form> : <form onSubmit={saveSettings}>
        <p className="field-note settings-note">Terminal IDs, names, and site labels are saved to the backend. Terminal IDs must exactly match the IDs configured on the terminals. Integration keys and secrets remain in server environment variables; each terminal needs the shared credentials or matching `TERMINAL_ID_INTEGRATION_KEY` and `TERMINAL_ID_SECRET` values.</p>
        <div className="settings-table-head"><span>Terminal ID</span><span>Terminal name</span><span>Site label</span><span /></div>
        {settings.map((row, index) => <div className="settings-row" key={`${row.id}-${index}`}>
          <input aria-label="Terminal ID" value={row.id} onChange={e => updateSetting(index, 'id', e.target.value)} disabled={!row.isNew || settingsBusy} />
          <input aria-label="Terminal name" value={row.name} onChange={e => updateSetting(index, 'name', e.target.value)} disabled={settingsBusy} />
          <input aria-label="Site label" value={row.label} onChange={e => updateSetting(index, 'label', e.target.value)} disabled={settingsBusy} />
          <button className="remove-terminal" type="button" aria-label={`Remove ${row.label}`} onClick={() => setSettings(current => current.filter((_, i) => i !== index))} disabled={settingsBusy || settings.length <= 1}>×</button>
        </div>)}
        <div className="settings-actions"><button className="secondary" type="button" onClick={addTerminal} disabled={settingsBusy || settings.length >= 50}>＋ Add terminal</button><button className="primary settings-save" type="submit" disabled={settingsBusy || settings.length < 1}>{settingsBusy ? 'Saving…' : 'Save terminal settings'}<span>→</span></button></div>
        <button className="text-button lock-settings" type="button" onClick={() => { setSettingsUnlocked(false); setSettings([]); setAdminPin(''); }}>Lock settings</button>
      </form>}
      {settingsMessage && <div className="notice" role="status">{settingsMessage}</div>}
    </section>}

    {view !== 'settings' && <>
      <section className="card latest-card"><div className="latest-copy"><span className="eyebrow">LOOKUP</span><h3>Latest payment</h3><p>Retrieve the most recent payment response saved on the selected terminal.</p></div><button className="secondary" type="button" onClick={getLatest} disabled={busy || operationIsActive || !selectedTerminalId}>{busy ? 'Working…' : 'Get latest payment'}<span>↗</span></button>{latestError && <div className="notice latest-notice">{latestError}</div>}{latest && <div className="latest-result"><div className="meta-row"><span>Outcome</span><strong className={latest.transactionOutcome === 'Approved' ? 'approved' : ''}>{latest.transactionOutcome ?? '—'}</strong></div><div className="meta-row"><span>Receipt</span><span>{latest.receiptNumber ?? '—'}</span></div><div className="meta-row"><span>Amount</span><span>{latest.amounts?.total ?? latest.amounts?.base ?? '—'} {latest.amounts?.currency?.symbol ?? ''}</span></div><details><summary>Full terminal response</summary><pre>{JSON.stringify(latest, null, 2)}</pre></details></div>}</section>

      <section className="card receipt-lookup-card"><div className="latest-copy"><span className="eyebrow">REPRINT</span><h3>Find transaction receipt</h3><p>Look up a payment on the selected terminal by its six-digit receipt number.</p></div><form className="receipt-lookup-form" onSubmit={e => { e.preventDefault(); void loadReceipt(receiptSearch.trim()); }}><input aria-label="Receipt number to look up" inputMode="numeric" maxLength={6} pattern="[0-9]{6}" placeholder="Six-digit receipt number" value={receiptSearch} onChange={e => setReceiptSearch(e.target.value)} disabled={busy || operationIsActive || !selectedTerminalId} required /><button className="secondary" type="submit" disabled={busy || operationIsActive || !selectedTerminalId}>{busy ? 'Looking up…' : 'Find receipt'}<span>⌕</span></button></form>{receiptToPrint && <div className="receipt-actions"><div><strong>{receiptToPrint.source}</strong><span>{receiptToPrint.receiptNumber ? ` · Receipt ${receiptToPrint.receiptNumber}` : ''}</span></div><div className="receipt-buttons"><button className="secondary" type="button" onClick={() => { if (!receiptToPrint.plain) return; if (!printPlainReceipt(receiptToPrint.plain)) setNotice('Allow pop-ups for this site to print the receipt.'); }} disabled={!receiptToPrint.plain}>Print on this device</button><button className="secondary" type="button" onClick={printOnTerminal} disabled={busy || operationIsActive || !receiptToPrint.printerCommands}>Print on terminal</button></div>{!receiptToPrint.printerCommands && <p className="field-note">This response has no ESC/P printer-command receipt, so terminal printing is unavailable. Plain-text printing may still be available.</p>}</div>}{latestError && !latest && <div className="notice latest-notice">{latestError}</div>}</section>
    </>}

    <footer><span>Samport ECR REST API v2</span><span>Local showroom utility · Keep terminal and server clocks synchronized</span></footer>
  </main>;
}

function stateLabel(state: OperationState) {
  const names: Record<OperationState, string> = {
    starting: 'Starting', pending: 'In progress', unknown: 'Outcome unknown — checking',
    'abort-requested': 'Abort requested', completed: 'Completed', failed: 'Not accepted',
  };
  return names[state];
}
