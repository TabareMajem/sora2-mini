import 'dotenv/config';
import express from 'express';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { Readable } from 'node:stream';

// ============ CONFIG ============
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_ORG = process.env.OPENAI_ORG || '';        // optional
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || ''; // optional
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'sora-2'; // API defaults to sora-2
const PORT = process.env.PORT || 4000;
if (!OPENAI_API_KEY) console.warn('[WARN] OPENAI_API_KEY missing. Set it in .env or your host env.');

// ============ DB (LowDB JSON) ============
const dbPath = process.env.DB_PATH || 'history.json';
const dbDir = path.dirname(dbPath);
if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Low(new JSONFile(dbPath), { jobs: [] });
await db.read();
if (!db.data) db.data = { jobs: [] };

async function upsertJob(id, patch) {
  const i = db.data.jobs.findIndex(j => j.id === id);
  if (i >= 0) db.data.jobs[i] = { ...db.data.jobs[i], ...patch };
  else db.data.jobs.push({ id, ...patch });
  await db.write();
}

const DONE = new Set(['completed', 'succeeded', 'ready']);

// ============ HELPERS ============
function apiHeaders(extra = {}) {
  const h = { Authorization: `Bearer ${OPENAI_API_KEY}`, ...extra };
  if (OPENAI_ORG) h['OpenAI-Organization'] = OPENAI_ORG;
  if (OPENAI_PROJECT) h['OpenAI-Project'] = OPENAI_PROJECT;
  return h;
}
async function fetchJSON(url, opts = {}, timeoutMs = 120000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await r.text();
    if (!r.ok) throw new Error(`${r.status}: ${text}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}
async function fetchWithTimeout(url, opts = {}, timeoutMs = 300000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function streamFromOpenAI(url, headers, res, timeoutMs = 300000) {
  const r = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!r.ok) {
    const body = await r.text();
    res.status(400).send(`Stream failed (${r.status}): ${body}`);
    return;
  }
  const ct = r.headers.get('content-type') || 'video/mp4';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'no-store');
  if (r.body?.getReader) { await Readable.fromWeb(r.body).pipe(res); }
  else if (r.body?.pipe) { r.body.pipe(res); }
  else { const buf = Buffer.from(await r.arrayBuffer()); res.end(buf); }
}

// Allowed sizes per docs; common reliable set
const ALLOWED_SIZES = new Set(['1280x720', '1920x1080', '720x1280', '1080x1080']);
function normalizeSeconds(raw) {
  // Practical ceiling: 20s; many accounts allow 4–10; clamp 1..20 for safety.
  const n = Number(String(raw || '4').trim());
  if (Number.isFinite(n)) return String(Math.max(1, Math.min(20, Math.round(n))));
  return '4';
}

// ============ SERVER ============
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// optional password gate
app.use((req, res, next) => {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return next();
  const provided = req.headers['x-app-password'] || req.query.pwd;
  if (provided === pass) return next();
  res.status(401).send('Unauthorized. Append ?pwd=YOUR_PASSWORD or set X-App-Password header.');
});

// health
app.get('/health', (_req, res) => {
  res.json({ ok: true, model: VIDEO_MODEL, has_api_key: !!OPENAI_API_KEY, time: new Date().toISOString() });
});

// ============ UI (inline HTML — no external file needed) ============
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sora 2 — Prompt → Video</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:900px;margin:24px}
  textarea,input,select,button{width:100%;padding:10px;margin:6px 0}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  video{width:100%;margin-top:12px;display:none}
  .mono{font-family:ui-monospace,Menlo,monospace}
  .muted{color:#666}.error{color:#b00020}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{border:1px solid #ddd;border-radius:12px;padding:12px}
  .small{font-size:13px}.pill{display:inline-block;border:1px solid #ccc;border-radius:999px;padding:2px 8px;margin-left:8px}
</style>
<h1>Sora 2 — Prompt to Video</h1>

<form id="f">
  <label>Prompt</label>
  <textarea id="prompt" rows="6" placeholder="Describe subject, setting, camera, motion, lighting, vibe..."></textarea>

  <div class="row">
    <div>
      <label>Seconds (1–20)</label>
      <input id="seconds" type="number" min="1" max="20" value="4">
    </div>
    <div>
      <label>Size</label>
      <select id="size">
        <option value="1280x720">1280x720 (16:9, 720p)</option>
        <option value="1920x1080">1920x1080 (16:9, 1080p)</option>
        <option value="720x1280">720x1280 (9:16 vertical)</option>
        <option value="1080x1080">1080x1080 (1:1 square)</option>
      </select>
    </div>
  </div>

  <label>Reference (image/video, optional)</label>
  <input id="ref" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm">

  <button>Generate</button>
</form>

<p id="status" class="mono muted"></p>
<p id="err" class="mono error"></p>
<video id="vid" controls></video>
<a id="dl" class="mono" download="output.mp4" style="display:none">Download video</a>

<hr style="margin:24px 0">
<div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
  <h2 style="margin:0">History</h2>
  <div>
    <button id="refresh" type="button">Refresh</button>
    <button id="list" type="button">List recent</button>
    <button id="clear" type="button">Clear List</button>
  </div>
</div>
<div id="hist" class="grid"></div>

<script>
  const $ = id => document.getElementById(id);
  const statusEl = $('status'), errEl = $('err'), vid = $('vid'), dl = $('dl'), hist = $('hist');

  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent=''; statusEl.textContent='Submitting job…';
    vid.style.display='none'; vid.removeAttribute('src'); dl.style.display='none';

    const form = new FormData();
    form.append('prompt', $('prompt').value.trim());
    form.append('seconds', String($('seconds').value || '4'));
    form.append('size', $('size').value);
    if ($('ref').files[0]) form.append('ref', $('ref').files[0]);

    const r = await fetch('/api/render', { method:'POST', body: form });
    const j = await r.json().catch(()=>({error:'Bad JSON'}));
    if (!r.ok || j.error) { errEl.textContent = 'Create error: ' + (j.error || r.status); statusEl.textContent=''; return; }

    let done=false, started=Date.now();
    while(!done){
      await new Promise(r=>setTimeout(r,2000));
      const sResp = await fetch('/api/status/'+j.id);
      let s; try { s = await sResp.json(); } catch { s = { error:'Bad JSON' } }
      if (!sResp.ok || s.error) {
        const msg = (s && s.error && (s.error.message || s.error)) || (typeof s==='string'?s:JSON.stringify(s)) || ('HTTP '+sResp.status);
        console.error('Status error payload:', s);
        errEl.textContent='Status error: ' + msg; statusEl.textContent=''; return;
      }
      const progress = s.progress ?? '';
      statusEl.textContent = 'Status: '+s.status+(progress!==''?' · '+progress:'');
      const final = ['completed','succeeded','ready'].includes(String(s.status).toLowerCase());

      if (final) {
        const streamUrl = '/api/content/' + j.id + '?type=video';
        vid.src = streamUrl; vid.style.display='block';
        dl.href = streamUrl; dl.style.display='inline-block';
        statusEl.textContent = 'Done ✅';
        await refreshHistory();
        done = true;
      } else if (String(s.status).toLowerCase()==='in_progress' && Number(progress)===100) {
        // test stream readiness while we wait for final flip
        const head = await fetch('/api/ping-content/' + j.id + '?type=video');
        if (head.ok) {
          const streamUrl = '/api/content/' + j.id + '?type=video';
          vid.src = streamUrl; vid.style.display='block';
          dl.href = streamUrl; dl.style.display='inline-block';
          statusEl.textContent = 'Ready (staged) ✅';
          await refreshHistory();
          done = true;
        } else if (Date.now() - started > 10*60*1000) {
          errEl.textContent = 'Took too long after 100% — try again.';
          statusEl.textContent=''; done = true;
        }
      } else if (Date.now() - started > 15*60*1000) {
        errEl.textContent = 'Timed out — try again.';
        statusEl.textContent=''; done = true;
      }
    }
  });

  async function refreshHistory(){
    const r = await fetch('/api/history'); const data = await r.json().catch(()=>[]);
    hist.innerHTML = '';
    if (!Array.isArray(data) || data.length===0){ hist.innerHTML = '<p class="muted">No history yet.</p>'; return; }
    for (const j of data){
      const when = j.completedAt || j.updatedAt || j.createdAt || '';
      const row = document.createElement('div'); row.className = 'card small';
      row.innerHTML = \`
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
          <div class="mono">#\${j.id.slice(0,8)}…</div>
          <div class="pill">\${j.status||'unknown'}</div>
        </div>
        <div style="margin-top:6px"><b>Prompt</b><br>\${(j.prompt||'').replaceAll('<','&lt;')}</div>
        <div style="margin-top:6px;color:#666">\${when}</div>
        <div style="margin-top:8px">
          <a href="/api/content/\${j.id}?type=video" target="_blank">Open video</a>
          · <a href="/api/content/\${j.id}?type=video" download="sora2-\${j.id}.mp4">Download</a>
        </div>
      \`;
      hist.appendChild(row);
    }
  }
  $('refresh').addEventListener('click', refreshHistory);
  $('clear').addEventListener('click', () => { hist.innerHTML=''; });
  $('list').addEventListener('click', async () => {
    const r = await fetch('/api/list?limit=5');
    const j = await r.json().catch(()=>({}));
    console.log('Recent videos:', j);
    alert('Open DevTools Console to see /api/list output.');
  });
  refreshHistory();
</script>`);
});

// ============ VALIDATION + UPLOAD ============
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp)|video\/(mp4|quicktime|webm))$/i.test(file.mimetype || '');
    cb(ok ? null : new Error('Unsupported reference type. Use JPG/PNG/WebP or MP4/MOV/WebM.'), ok);
  }
});

function clampSize(v) {
  const s = String(v || '').trim();
  return ALLOWED_SIZES.has(s) ? s : '1280x720';
}

// ============ CREATE ============
app.post('/api/render', upload.single('ref'), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) throw new Error('Server missing OPENAI_API_KEY.');

    const prompt = (req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Empty prompt' });

    const seconds = normalizeSeconds(req.body?.seconds);
    const size = clampSize(req.body?.size);

    const form = new FormData();
    form.append('prompt', prompt);
    form.append('seconds', seconds);
    form.append('size', size);
    form.append('model', VIDEO_MODEL);

    if (req.file) {
      const file = new File([req.file.buffer], req.file.originalname || 'reference.bin', {
        type: req.file.mimetype || 'application/octet-stream'
      });
      // API supports an image OR a video reference; send as input_reference (API will infer)
      form.append('input_reference', file);
    }

    const job = await fetchJSON('https://api.openai.com/v1/videos', {
      method: 'POST',
      headers: apiHeaders(), // do NOT set content-type; fetch sets boundary
      body: form
    });

    await upsertJob(job.id, {
      prompt, seconds, size,
      status: job.status || 'queued',
      createdAt: new Date().toISOString()
    });

    res.json({ id: job.id });
  } catch (e) {
    res.status(400).json({ error: 'OpenAI create failed: ' + (e?.message || String(e)) });
  }
});

// ============ STATUS ============
app.get('/api/status/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const resp = await fetchWithTimeout(`https://api.openai.com/v1/videos/${encodeURIComponent(id)}`, {
      method: 'GET', headers: apiHeaders()
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`${resp.status}: ${text}`);

    const out = JSON.parse(text);
    console.log('[VIDEOS] status', id, out);

    let status = String(out.status || '').toLowerCase();

    // If stuck at 100, probe content; if streamable, treat as 'ready'
    if (status === 'in_progress' && Number(out.progress) === 100) {
      const head = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=video`, {
        method: 'HEAD', headers: apiHeaders()
      });
      if (head.ok) { status = 'ready'; out.status = 'ready'; }
    }

    const patch = { status: out.status, progress: out.progress ?? null, updatedAt: new Date().toISOString() };
    if (DONE.has(status)) patch.completedAt = new Date().toISOString();
    await upsertJob(out.id, patch);

    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'OpenAI retrieve failed: ' + (e?.message || String(e)) });
  }
});

// quick HEAD probe used by the UI at 100%
app.get('/api/ping-content/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const t = (req.query.type || 'video').toString();
    const r = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=${encodeURIComponent(t)}`, {
      method: 'HEAD', headers: apiHeaders()
    });
    return res.status(r.ok ? 200 : r.status).send(r.ok ? 'ok' : 'not ready');
  } catch {
    return res.status(500).send('error');
  }
});

// ============ CONTENT STREAM ============
app.get('/api/content/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const t = (req.query.type || 'video').toString(); // 'video' | 'thumbnail' | 'audio'
    const url = `https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=${encodeURIComponent(t)}`;
    await streamFromOpenAI(url, apiHeaders(), res);
  } catch (e) {
    res.status(500).send('Content proxy error: ' + (e?.message || String(e)));
  }
});

// ============ LIST (debug) ============
app.get('/api/list', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const data = await fetchJSON(`https://api.openai.com/v1/videos?limit=${limit}`, { headers: apiHeaders() });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: 'OpenAI list failed: ' + (e?.message || String(e)) });
  }
});

// ============ HISTORY ============
app.get('/api/history', async (_req, res) => {
  await db.read();
  const jobs = (db.data.jobs || [])
    .slice()
    .sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''))
    .slice(0,50);
  res.json(jobs);
});
app.get('/api/job/:id', async (req, res) => {
  await db.read();
  const j = db.data.jobs.find(x => x.id === req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json(j);
});

// ============ START ============
app.listen(PORT, () => console.log('Open http://localhost:' + PORT));
