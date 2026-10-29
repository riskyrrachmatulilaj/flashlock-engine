import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, Check, ChevronRight, CircleAlert, Copy, Database, FlaskConical, Layers, LoaderCircle, LockKeyhole, Radio, ShieldCheck, Terminal, Users, Zap } from 'lucide-react';

type Telemetry = {
  saleId: string; totalStock: number; availableStock: number; heldStock: number;
  soldStock: number; invariantValid: boolean; timestamp: string | number;
};
type Connection = 'idle' | 'connecting' | 'live' | 'reconnecting';
type Action = 'initialize' | 'stampede' | 'race';
type LogEntry = { id: number; time: string; message: string; kind: 'info' | 'success' | 'warning' | 'error' };

function isTelemetry(value: unknown): value is Telemetry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.saleId === 'string' && typeof item.invariantValid === 'boolean'
    && ['totalStock', 'availableStock', 'heldStock', 'soldStock'].every(key => typeof item[key] === 'number' && Number.isFinite(item[key]))
    && (typeof item.timestamp === 'string' || typeof item.timestamp === 'number');
}

async function post(path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : {}; } catch { data = undefined; }
  if (!response.ok) {
    const detail = data && typeof data === 'object' ? (data as Record<string, unknown>).message : undefined;
    const hint = response.status >= 500 ? ' Check API on 127.0.0.1:3000 and its Redis / PostgreSQL connections.' : '';
    const message = typeof detail === 'string' && detail.trim()
      ? detail.trim()
      : response.statusText || 'Backend request failed';
    throw new Error(`HTTP ${response.status}: ${message}.${hint}`);
  }
  if (!data || typeof data !== 'object') throw new Error('Server returned an invalid JSON response.');
  return data as Record<string, unknown>;
}

export default function App() {
  const [saleId, setSaleId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [connection, setConnection] = useState<Connection>('idle');
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [raceResult, setRaceResult] = useState<string | null>(null);
  const [lastReceived, setLastReceived] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState('all');
  const [copyStatus, setCopyStatus] = useState('');
  const sequence = useRef(0);
  const request = useRef<AbortController | null>(null);
  const lastCounts = useRef('');

  function log(message: string, kind: LogEntry['kind'] = 'info') {
    const entry = { id: ++sequence.current, time: new Date().toLocaleTimeString('en-GB'), message, kind };
    setLogs(previous => [entry, ...previous].slice(0, 100));
  }

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (!saleId) return;
    let active = true;
    let malformedReported = false;
    let disconnected = false;
    setConnection('connecting');
    const source = new EventSource(`/api/v1/sales/${encodeURIComponent(saleId)}/stream`);
    source.onopen = () => {
      if (!active) return;
      disconnected = false;
      setConnection('live');
      log('Telemetry stream connected.', 'success');
    };
    source.onerror = () => {
      if (!active) return;
      if (!disconnected) log('Stream interrupted. Waiting for automatic reconnect.', 'warning');
      disconnected = true;
      setConnection('reconnecting');
    };
    const onTelemetry = (event: MessageEvent<string>) => {
      if (!active) return;
      try {
        const data: unknown = JSON.parse(event.data);
        if (!isTelemetry(data) || data.saleId !== saleId) throw new Error('Invalid telemetry');
        setTelemetry(data);
        setConnection('live');
        setLastReceived(new Date().toLocaleTimeString('en-GB'));
        const counts = `${data.availableStock}/${data.heldStock}/${data.soldStock}/${data.invariantValid}`;
        if (lastCounts.current !== counts) {
          lastCounts.current = counts;
          log(`Inventory · available ${data.availableStock} · held ${data.heldStock} · sold ${data.soldStock}`, data.invariantValid ? 'info' : 'error');
        }
      } catch {
        if (!malformedReported) {
          log('Malformed telemetry ignored. Waiting for a valid snapshot.', 'error');
          malformedReported = true;
        }
      }
    };
    source.addEventListener('telemetry', onTelemetry);
    return () => { active = false; source.removeEventListener('telemetry', onTelemetry); source.close(); };
  }, [saleId]);

  function activate(id: string) {
    setTelemetry(null);
    setLastReceived(null);
    setCopyStatus('');
    lastCounts.current = '';
    setConnection('connecting');
    setSaleId(id);
  }

  async function run(action: Action) {
    if (request.current || (action !== 'initialize' && !saleId)) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(action);
    setError(null);
    try {
      if (action === 'initialize') {
        const data = await post('/api/v1/sales', { title: 'FlashLock Concurrency Lab', totalStock: 100 }, controller.signal);
        if (typeof data.id !== 'string' || !data.id) throw new Error('Create sale response is missing its ID.');
        activate(data.id);
        setRaceResult(null);
        log('Sale initialized with 100 units. Awaiting authoritative telemetry.', 'success');
      } else if (action === 'stampede') {
        await post(`/api/v1/sales/${encodeURIComponent(saleId!)}/stampede`, { buyers: 1000, checkoutRatio: 0.7 }, controller.signal);
        log('1.000 buyer dikirim · 70% mencoba memulai pembayaran, bukan jaminan sukses; 30% abandonment. Pantau stok live.', 'success');
      } else {
        const data = await post(`/api/v1/sales/${encodeURIComponent(saleId!)}/race`, undefined, controller.signal);
        if (typeof data.saleId !== 'string' || !data.saleId) throw new Error('Race response is missing its isolated sale ID.');
        if (typeof data.status !== 'string') throw new Error('Race response is missing its status.');
        setRaceResult(data.status);
        activate(data.saleId);
        log(`Isolated race · ${data.status}${typeof data.reservationId === 'string' ? ` · reservation ${data.reservationId}` : ''} · simulated time (logical reaper clock). Switched to isolated sale.`, data.status === 'REFUNDED_LATE' ? 'success' : 'warning');
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = cause instanceof DOMException && cause.name === 'TimeoutError'
        ? 'Request timed out after 10 seconds. Check API on 127.0.0.1:3000 and its Redis / PostgreSQL connections.'
        : cause instanceof TypeError
          ? 'Backend unavailable. Start API on 127.0.0.1:3000 with Redis and PostgreSQL running, then retry.'
          : cause instanceof Error ? cause.message : 'Unexpected request failure.';
      setError(message);
      log(message, 'error');
    } finally {
      if (!controller.signal.aborted) setPending(null);
      request.current = null;
    }
  }

  const total = telemetry?.totalStock ?? 0;
  const sum = telemetry ? telemetry.availableStock + telemetry.heldStock + telemetry.soldStock : null;
  const valid = telemetry ? telemetry.invariantValid && sum === total : null;
  const stocks = [
    { label: 'Available', subtitle: 'Siap direservasi', value: telemetry?.availableStock, color: 'mint', icon: Layers },
    { label: 'Held', subtitle: 'Reservasi aktif · TTL 5 menit', value: telemetry?.heldStock, color: 'amber', icon: LockKeyhole },
    { label: 'Sold', subtitle: 'Pembayaran terkonfirmasi', value: telemetry?.soldStock, color: 'blue', icon: Check },
  ];

  const visibleLogs = logs.filter(entry => logFilter === 'all' || entry.kind === logFilter);
  const disabledReason = pending ? 'Tunggu request aktif selesai sebelum menjalankan aksi lain.' : !saleId ? 'Buat sesi melalui Initialize untuk membuka simulasi.' : 'Request dikirim ke API; hasil diperbarui melalui SSE.';

  async function copySaleId() {
    if (!saleId) return;
    try { await navigator.clipboard.writeText(saleId); setCopyStatus('Sale ID tersalin.'); }
    catch { setCopyStatus('Gagal menyalin. Pilih Sale ID lalu salin manual.'); }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="./"><span className="brand-icon"><Zap size={22} fill="currentColor" /></span>FlashLock<span className="brand-dot">.</span></a>
        <div className="workspace-label">OPERATIONS WORKSPACE</div>
        <a href="#dashboard" className="nav-active" aria-current="page"><Activity size={18} /> Concurrency lab <span>01</span></a>
        <div className="sidebar-note"><ShieldCheck size={24} /><strong>Setiap unit,<br />tetap tercatat.</strong><p>Uji reservasi atomik dan konsistensi stok saat trafik memuncak.</p><div className="stack-label">REDIS + POSTGRESQL</div></div>
        <div className="sidebar-footer"><span className="small-dot" /> Development workspace</div>
      </aside>

      <main id="dashboard">
        <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={14} /><span>Concurrency lab</span></div><span className="environment">DEVELOPMENT</span></header>
        <div className="page-content">
          <section className="page-heading"><div><div className="eyebrow">REAL-TIME CONCURRENCY LAB</div><h1>Trafik tinggi.<br /><span>Stok tetap terkendali.</span></h1><p>Uji batas konkurensi. Amati reservasi, pembayaran,<br className="desktop-break" /> dan konservasi stok dari satu konsol.</p></div><div className="session-card"><div className="session-label">SESI SAAT INI <div className={`connection ${connection}`} role="status"><span className="small-dot" />{({ idle: 'Belum terhubung', connecting: 'Menghubungkan', live: 'SSE terhubung', reconnecting: 'Terputus · retry' })[connection]}</div></div><code className="session-id">{saleId ?? 'Belum ada sesi aktif'}</code><div className="session-bottom"><span>{lastReceived ? `Snapshot diterima ${lastReceived}` : 'Menunggu snapshot API'}</span><button className="copy-button" disabled={!saleId} onClick={() => void copySaleId()} aria-label="Salin ID sale"><Copy size={15} /> Salin ID</button></div><span className="copy-status" role="status">{copyStatus}</span></div></section>

          {error && <div className="error-banner" role="alert"><CircleAlert size={19} /><div><strong>Request failed</strong><p>{error}</p></div><button onClick={() => setError(null)} aria-label="Dismiss error">×</button></div>}
          {connection === 'reconnecting' && <div className="stream-warning" role="status">Koneksi terputus. Angka ditampilkan dari snapshot terakhir, bukan kondisi live. SSE mencoba tersambung otomatis.</div>}

          <section className={`invariant-card ${valid === false ? 'failed' : ''}`} aria-label="Inventory invariant">
            <div className="invariant-heading"><div><ShieldCheck size={19} /><span>KONSERVASI INVENTORY</span></div><span className={`proof-badge ${valid === null ? 'waiting' : valid ? '' : 'bad'}`}>{valid === null ? 'MENUNGGU DATA' : valid ? 'PASS · STOK SEIMBANG' : 'FAIL · STOCK DRIFT'}</span></div>
            <div className="equation"><div><strong>{telemetry?.availableStock ?? '—'}</strong><span>Available</span></div><b>+</b><div><strong>{telemetry?.heldStock ?? '—'}</strong><span>Held</span></div><b>+</b><div><strong>{telemetry?.soldStock ?? '—'}</strong><span>Sold</span></div><b>=</b><div className="equation-total"><strong>{telemetry?.totalStock ?? '—'}</strong><span>Initial stock</span></div></div>
            <div className="invariant-foot"><span><span className="small-dot" /> {valid === null ? 'Buat sesi untuk memverifikasi stok.' : valid ? 'Semua unit tercatat pada snapshot ini.' : 'Invariant dilanggar. Periksa state backend.'}</span><code>available + held + sold == total</code></div>
          </section>

          <section className="stock-grid" aria-label="Live stock counters">{stocks.map(stock => <article className={`stock-card ${stock.color}`} key={stock.label}><div className="stock-card-heading"><span>{stock.label}</span><stock.icon size={18} /></div><div className="stock-number">{stock.value ?? '—'}<span>/ {telemetry ? total : '—'}</span></div><div className="stock-track" role="progressbar" aria-label={`${stock.label} stock`} aria-valuemin={0} aria-valuemax={total || 100} aria-valuenow={stock.value ?? 0}><div style={{ width: `${total > 0 ? Math.min(100, ((stock.value ?? 0) / total) * 100) : 0}%` }} /></div><div className="stock-subtitle">{stock.subtitle}<span>{stock.value !== undefined && total > 0 ? `${Math.round(stock.value / total * 100)}%` : '—'}</span></div></article>)}</section>

          <div className="lower-grid">
            <section className="panel controls-panel"><div className="panel-title"><div><FlaskConical size={19} /><h2>Jalankan skenario</h2></div><span className="mini-tag">REAL REQUESTS</span></div><p className="panel-description">API nyata. Kontensi nyata. Tanpa angka sintetis.</p>
              <article className="action-card"><div className="control-step"><span className="step-number">01</span><div><h3>Initialize</h3><p>Buat sale baru berisi 100 unit. Sale sebelumnya tidak dihapus.</p></div></div>
              <button className="action-button secondary" aria-describedby="action-help" disabled={pending !== null} onClick={() => void run('initialize')}>{pending === 'initialize' ? <LoaderCircle className="spin" size={17} /> : <Database size={17} />}{pending === 'initialize' ? 'Membuat sesi…' : 'Initialize 100 stok'}<ArrowUpRight size={16} /></button></article>
              <article className="action-card"><div className="control-step"><span className="step-number">02</span><div><h3>Stampede</h3><p>1.000 buyer konkuren. 70% mencoba memulai pembayaran, bukan jaminan sukses. 30% abandonment.</p></div></div>
              <button className="action-button primary" aria-describedby="action-help" disabled={pending !== null || !saleId} onClick={() => void run('stampede')}>{pending === 'stampede' ? <LoaderCircle className="spin" size={17} /> : <Users size={17} />}{pending === 'stampede' ? 'Mengirim buyer…' : 'Kirim 1.000 buyer'}<Zap size={16} /></button></article>
              <article className="action-card"><div className="control-step"><span className="step-number">03</span><div><h3>Late payment race</h3><p>Uji pembayaran setelah reservasi kedaluwarsa.</p></div></div>
              <button className="action-button race" aria-describedby="action-help race-help" disabled={pending !== null || !saleId} onClick={() => void run('race')}>{pending === 'race' ? <LoaderCircle className="spin" size={17} /> : <FlaskConical size={17} />}{pending === 'race' ? 'Menjalankan race…' : 'Jalankan isolated race'}</button>
              <div className="race-note" id="race-help"><ShieldCheck size={16} /><p>Logical reaper clock melewati waktu tunggu 5 menit. Race memakai sale terisolasi; sale sebelumnya tetap utuh. Dashboard berpindah ke Sale ID hasil race.</p></div></article>
              <p className="action-help" id="action-help" role="status">{disabledReason}</p>
              {raceResult && <div className="race-result" role="status">Hasil race: <code>{raceResult}</code></div>}
            </section>

            <section className="panel event-panel"><div className="panel-title"><div><Terminal size={18} /><h2>Event stream</h2><span className="event-count">{logs.length}</span></div><button className="text-button" onClick={() => setLogs([])} disabled={!logs.length}>Bersihkan</button></div><div className="event-toolbar"><span><Radio size={14} /> CLIENT + TELEMETRY</span><label>Filter <select value={logFilter} onChange={event => setLogFilter(event.target.value)}><option value="all">Semua event</option><option value="info">Info</option><option value="success">Success</option><option value="warning">Warning</option><option value="error">Error</option></select></label></div>
              <div className="event-list" role="log" tabIndex={0} aria-label="Event simulasi, terbaru di atas" aria-live="polite" aria-relevant="additions">{visibleLogs.length === 0 ? <div className="empty-log"><div><Terminal size={28} /></div><h3>{logs.length ? 'Tidak ada event sesuai filter.' : 'Sistem siap. Menunggu sesi.'}</h3><p>{logs.length ? 'Pilih filter lain untuk melihat event.' : 'Initialize stok untuk membuka koneksi SSE.'}<br />Maksimal 100 event terbaru, urutan terbaru di atas.</p></div> : visibleLogs.map(entry => <div className={`event-row ${entry.kind}`} key={entry.id}><time>{entry.time}</time><span className="event-marker" aria-hidden="true">{entry.kind === 'success' ? <Check size={13} /> : entry.kind === 'error' || entry.kind === 'warning' ? <CircleAlert size={13} /> : <ArrowDownLeft size={13} />}</span><p><span className="event-kind">{entry.kind}</span>{entry.message}</p></div>)}</div>
              <div className="event-footer"><span className="small-dot" /> {connection === 'live' ? 'SSE terhubung' : connection === 'idle' ? 'Menunggu sesi' : 'Menunggu koneksi'}<span>Snapshot {lastReceived ?? '—'}</span></div>
            </section>
          </div>
          <footer className="page-footer"><span>FlashLock Engine <span className="footer-slash">/</span> Built for the rush.</span><span className="sale-id" title={saleId ?? undefined}>SALE {saleId ?? 'NOT INITIALIZED'}</span></footer>
        </div>
      </main>
    </div>
  );
}
