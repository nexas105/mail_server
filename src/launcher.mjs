// Launcher/Supervisor: kleiner Dauerprozess mit Control-Page, der den Mail-Server
// (src/server.js) als Kindprozess startet/stoppt/neustartet, Status prüft und Log liefert.
// Start:  node src/launcher.mjs   →   http://localhost:3999
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.join(__dirname, '..');
const SERVER = path.join(__dirname, 'server.js');
const LAUNCHER_PORT = Number(process.env.LAUNCHER_PORT || 3999);
const BACKEND_PORT = Number(process.env.PORT || 3000);
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

let child = null;
const LOG_CAP = 400;
const logs = [];
function log(line, stream = 'launcher') {
  for (const l of String(line).split('\n')) {
    if (l.trim() === '') continue;
    logs.push({ t: new Date().toISOString(), stream, line: l });
    if (logs.length > LOG_CAP) logs.shift();
  }
}

async function backendHealth() {
  try {
    const ctrl = AbortSignal.timeout(1500);
    const r = await fetch(`${BACKEND_URL}/api/health`, { signal: ctrl });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function start() {
  if (child && !child.killed) return { ok: true, note: 'Kindprozess läuft bereits', managed: true };
  const health = await backendHealth();
  if (health) return { ok: true, note: 'Backend läuft bereits (extern gestartet)', managed: false, health };
  log('Starte Backend …');
  child = spawn(process.execPath, [SERVER], { cwd: PROJECT, env: { ...process.env } });
  child.stdout.on('data', d => log(d, 'stdout'));
  child.stderr.on('data', d => log(d, 'stderr'));
  child.on('exit', (code, signal) => { log(`Backend beendet (code=${code} signal=${signal || '-'})`); child = null; });
  child.on('error', e => { log(`Start-Fehler: ${e.message}`); child = null; });
  // kurz auf Health warten
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (await backendHealth()) { log('Backend ist erreichbar ✓'); return { ok: true, managed: true }; }
    if (!child) break;
  }
  return { ok: !!child, managed: true, note: child ? 'gestartet (Health noch nicht bestätigt)' : 'Start fehlgeschlagen' };
}

async function stop() {
  if (!child) {
    const health = await backendHealth();
    if (health) return { ok: false, note: 'Backend läuft extern (nicht vom Launcher gestartet) – bitte dort beenden.' };
    return { ok: true, note: 'War nicht aktiv' };
  }
  log('Stoppe Backend …');
  const c = child;
  c.kill('SIGTERM');
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 200)); if (!child) break; }
  if (child) { log('SIGTERM ohne Wirkung – SIGKILL'); c.kill('SIGKILL'); }
  return { ok: true };
}

async function status() {
  const health = await backendHealth();
  return {
    launcher_pid: process.pid,
    backend_url: BACKEND_URL,
    managed: !!child,
    backend_pid: child?.pid ?? health?.pid ?? null,
    running: !!health,
    external: !child && !!health,
    health,
  };
}

const PAGE = /* html */ `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail-Server Launcher</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--border:#2a2f3a;--text:#e6e9ef;--muted:#8b93a3;--accent:#4f8cff;--green:#3ecf8e;--red:#ff5c5c;--amber:#f5a623}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:820px;margin:0 auto;padding:28px}
  h1{font-size:18px;display:flex;align-items:center;gap:10px}
  .dot{width:11px;height:11px;border-radius:50%;background:var(--muted);box-shadow:0 0 0 4px rgba(255,255,255,.03)}
  .dot.up{background:var(--green)}.dot.down{background:var(--red)}.dot.ext{background:var(--amber)}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin:16px 0}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  button{background:var(--accent);border:none;color:#fff;padding:10px 18px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer}
  button.ghost{background:#1e222b;border:1px solid var(--border);color:var(--text)}
  button.red{background:transparent;border:1px solid var(--border);color:var(--red)}
  button:disabled{opacity:.5;cursor:not-allowed}
  a.btn{display:inline-block;text-decoration:none;background:var(--green);color:#06251a;padding:10px 18px;border-radius:8px;font-weight:600}
  .meta{color:var(--muted);font-size:13px;margin-top:6px}
  pre{background:#0b0d11;border:1px solid var(--border);border-radius:8px;padding:12px;max-height:340px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap}
  .stderr{color:var(--amber)} .muted{color:var(--muted)}
</style></head><body><div class="wrap">
  <h1><span class="dot" id="dot"></span> Mail-Server Launcher</h1>
  <div class="card">
    <div class="row">
      <strong id="statusText">…</strong>
      <span class="meta" id="statusMeta"></span>
    </div>
    <div class="row" style="margin-top:14px">
      <button id="start">▶ Starten</button>
      <button id="restart" class="ghost">↻ Neustart</button>
      <button id="stop" class="red">■ Stoppen</button>
      <a class="btn" id="open" href="${BACKEND_URL}" target="_blank" rel="noopener">App öffnen ↗</a>
    </div>
  </div>
  <div class="card">
    <div class="row"><strong style="flex:1">Backend-Log</strong><button class="ghost" id="clear">Log leeren (Anzeige)</button></div>
    <pre id="log"></pre>
  </div>
  <div class="meta">Launcher auf Port ${LAUNCHER_PORT} · Backend ${BACKEND_URL} · nur lokal.</div>
</div>
<script>
let cleared = 0;
async function j(u,m){const r=await fetch(u,{method:m||'GET'});return r.json()}
async function refresh(){
  const s = await j('/api/status').catch(()=>null);
  const dot=document.getElementById('dot'), st=document.getElementById('statusText'), me=document.getElementById('statusMeta');
  if(!s){dot.className='dot down';st.textContent='Launcher nicht erreichbar';return}
  if(s.running){dot.className='dot '+(s.external?'ext':'up');st.textContent=s.external?'Backend läuft (extern)':'Backend läuft';
    me.textContent='PID '+(s.backend_pid??'?')+' · Uptime '+(s.health?.uptime_s??'?')+'s · '+(s.health?.accounts??'?')+' Accounts · Node '+(s.health?.node||'');}
  else{dot.className='dot down';st.textContent='Backend gestoppt';me.textContent='';}
  document.getElementById('stop').disabled = !s.running || s.external;
  document.getElementById('start').disabled = s.running;
  const lg = await j('/api/logs').catch(()=>({lines:[]}));
  const el=document.getElementById('log');
  el.innerHTML = lg.lines.slice(cleared).map(l=>'<span class="'+(l.stream==='stderr'?'stderr':(l.stream==='launcher'?'muted':''))+'">'+
    l.line.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</span>').join('\\n');
  el.scrollTop=el.scrollHeight;
}
async function act(u){const b=event.target;b.disabled=true;await j(u,'POST').catch(()=>{});setTimeout(()=>{b.disabled=false;refresh()},400);}
document.getElementById('start').onclick=()=>act('/api/start');
document.getElementById('stop').onclick=()=>act('/api/stop');
document.getElementById('restart').onclick=()=>act('/api/restart');
document.getElementById('clear').onclick=async()=>{const lg=await j('/api/logs');cleared=lg.lines.length;refresh()};
refresh();setInterval(refresh,2000);
</script></body></html>`;

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && url === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url === '/api/status') return send(res, 200, await status());
    if (req.method === 'GET' && url === '/api/logs') return send(res, 200, { lines: logs });
    if (req.method === 'POST' && url === '/api/start') return send(res, 200, await start());
    if (req.method === 'POST' && url === '/api/stop') return send(res, 200, await stop());
    if (req.method === 'POST' && url === '/api/restart') { await stop(); return send(res, 200, await start()); }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});

server.listen(LAUNCHER_PORT, '127.0.0.1', async () => {
  console.log(`Launcher:  http://localhost:${LAUNCHER_PORT}`);
  if (process.env.LAUNCHER_NO_AUTOSTART !== '1') { const r = await start(); log(r.note || 'Autostart'); }
});

// Beim Beenden des Launchers auch das Backend stoppen.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await stop(); process.exit(0); });
