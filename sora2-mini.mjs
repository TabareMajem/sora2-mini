import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';

// ====== CONFIG ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_ORG = process.env.OPENAI_ORG || '';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || '';
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'sora-2';
const PORT = process.env.PORT || 4000;

if (!OPENAI_API_KEY) console.warn('[WARN] OPENAI_API_KEY not set');

const ALLOWED_SECONDS = ['4', '8', '12'];
const ALLOWED_SIZES = new Set(['1280x720','1920x1080','720x1280','1080x1080']);
const IMAGE_MIMES = ['image/jpeg','image/png','image/webp']; // image-only

// ====== DB ======
const dbFile = path.join(process.cwd(), 'history.json');
const db = new Low(new JSONFile(dbFile), { jobs: [] });
await db.read();
db.data ||= { jobs: [] };

async function upsertJob(id, patch) {
  const i = db.data.jobs.findIndex(j => j.id === id);
  if (i >= 0) db.data.jobs[i] = { ...db.data.jobs[i], ...patch };
  else db.data.jobs.push({ id, ...patch });
  await db.write();
}
const DONE = new Set(['completed','succeeded','ready']);

// ====== helpers ======
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
    const txt = await r.text();
    if (!r.ok) throw new Error(`${r.status}: ${txt}`);
    return JSON.parse(txt);
  } finally { clearTimeout(t); }
}
async function fetchWithTimeout(url, opts = {}, timeoutMs = 300000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function streamFromOpenAI(url, headers, res, timeoutMs = 300000) {
  const r = await fetchWithTimeout(url, { headers }, timeoutMs);
  if (!r.ok) { const body = await r.text(); res.status(400).send(`Stream failed (${r.status}): ${body}`); return; }
  const ct = r.headers.get('content-type') || 'video/mp4';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'no-store');
  if (r.body?.getReader) await Readable.fromWeb(r.body).pipe(res);
  else if (r.body?.pipe) r.body.pipe(res);
  else res.end(Buffer.from(await r.arrayBuffer()));
}
const normSeconds = v => (ALLOWED_SECONDS.includes(String(v||'').trim()) ? String(v).trim() : '4');
const normSize = v => (ALLOWED_SIZES.has(String(v||'').trim()) ? String(v).trim() : '1280x720');

// ====== app ======
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req,res)=>res.json({ ok:true, model:VIDEO_MODEL, has_key:!!OPENAI_API_KEY }));

// ====== UI (inline) ======
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
      <label>Seconds</label>
      <select id="seconds">
        <option value="4">4</option>
        <option value="8">8</option>
        <option value="12">12</option>
      </select>
      <div class="muted small">Your org supports 4, 8, 12s.</div>
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

  <label>Reference image (optional — JPG/PNG/WEBP only)</label>
  <input id="ref" type="file" accept="image/jpeg,image/png,image/webp">
  <div class="muted small">Video references (mp4/mov) are not available for your org.</div>

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
    form.append('seconds', $('seconds').value);
    form.append('size', $('size').value);
    const f = $('ref').files[0];
    if (f) {
      if (!/^image\\/(jpeg|png|webp)$/i.test(f.type)) {
        errEl.textContent = 'Only JPG/PNG/WEBP images are allowed as reference for this org.';
        statusEl.textContent=''; return;
      }
      form.append('ref', f); // image only
    }

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

// ====== upload (image-only) ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = IMAGE_MIMES.includes(file.mimetype || '');
    cb(ok ? null : new Error('Only JPG/PNG/WEBP images are allowed as reference for this org.'), ok);
  }
});

// ====== CREATE ======
app.post('/api/render', upload.single('ref'), async (req, res) => {
  try {
    if (!OPENAI_API_KEY) throw new Error('Server missing OPENAI_API_KEY.');
    const prompt = (req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Empty prompt' });

    const seconds = normSeconds(req.body?.seconds);
    const size = normSize(req.body?.size);

    const form = new FormData();
    form.append('prompt', prompt);
    form.append('seconds', seconds);
    form.append('size', size);
    form.append('model', VIDEO_MODEL);

    if (req.file) {
      // IMAGE reference only
      const name = req.file.originalname || 'reference.jpg';
      const mime = req.file.mimetype || 'image/jpeg';
      if (!IMAGE_MIMES.includes(mime)) {
        return res.status(400).json({ error: `Only image/jpeg, image/png, image/webp are allowed.` });
      }
      const blob = new Blob([req.file.buffer], { type: mime });
      form.append('input_reference', blob, name);
    }

    const job = await fetchJSON('https://api.openai.com/v1/videos', {
      method: 'POST',
      headers: apiHeaders(), // boundary auto-set
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

// ====== STATUS ======
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

    // If stuck at 100, probe content; if streamable, mark as ready
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

// quick HEAD probe
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

// ====== CONTENT STREAM ======
app.get('/api/content/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const t = (req.query.type || 'video').toString(); // video | thumbnail | audio
    const url = `https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=${encodeURIComponent(t)}`;
    await streamFromOpenAI(url, apiHeaders(), res);
  } catch (e) {
    res.status(500).send('Content proxy error: ' + (e?.message || String(e)));
  }
});

// ====== LIST / HISTORY ======
app.get('/api/list', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const data = await fetchJSON(`https://api.openai.com/v1/videos?limit=${limit}`, { headers: apiHeaders() });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: 'OpenAI list failed: ' + (e?.message || String(e)) });
  }
});
app.get('/api/history', async (_req, res) => {
  await db.read();
  const jobs = (db.data.jobs || []).slice().sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,50);
  res.json(jobs);
});
app.get('/api/job/:id', async (req, res) => {
  await db.read();
  const j = db.data.jobs.find(x => x.id === req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json(j);
});

// ====== START ======
app.listen(PORT, () => console.log('Open http://localhost:' + PORT));
