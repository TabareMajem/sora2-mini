import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
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
const FALLBACK_WITHOUT_REF = process.env.FALLBACK_WITHOUT_REF === 'true';

if (!OPENAI_API_KEY) console.warn('[WARN] OPENAI_API_KEY not set');

// org constraints you’ve hit
const ALLOWED_SECONDS = ['4', '8', '12'];
const DEFAULT_SIZE = '1280x720';
const UI_SIZES = ['1280x720','1920x1080','720x1280','1080x1080']; // add more if you like

// folders
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const LOCK_FILE = path.join(UPLOAD_DIR, 'character-lock.jpg'); // server-side persistent lock

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
const normSize = v => {
  const m = String(v||'').trim().match(/^(\d+)x(\d+)$/);
  return m ? `${m[1]}x${m[2]}` : DEFAULT_SIZE;
};
const parseSize = v => {
  const m = String(v||'').trim().match(/^(\d+)x(\d+)$/);
  if (!m) return { w: 1280, h: 720 };
  return { w: parseInt(m[1],10), h: parseInt(m[2],10) };
};

// -- sharp resize/convert to exact size --
// fitMode: 'cover' (crop to fill) | 'contain' (letterbox)
async function processImageBufferToSize(inputBuffer, desiredSize, fitMode='cover') {
  const { w, h } = parseSize(desiredSize);
  let quality = 85;
  let out = await sharp(inputBuffer)
    .resize(w, h, {
      fit: fitMode === 'contain' ? 'contain' : 'cover',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();

  // size guard (~15MB)
  if (out.length > 15 * 1024 * 1024) {
    quality = 70;
    out = await sharp(inputBuffer)
      .resize(w, h, {
        fit: fitMode === 'contain' ? 'contain' : 'cover',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }
  return { buffer: out, mime: 'image/jpeg', filename: `reference_${w}x${h}.jpg` };
}

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
  .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
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
      <label>Size (resolution)</label>
      <select id="size">
        ${UI_SIZES.map(s=>`<option value="${s}">${s}</option>`).join('')}
      </select>
    </div>
  </div>

  <div class="row3">
    <div>
      <label>Reference image (optional — JPG/PNG/WEBP)</label>
      <input id="ref" type="file" accept="image/jpeg,image/png,image/webp">
      <div class="muted small">We’ll auto-resize to your selected Size.</div>
    </div>
    <div>
      <label>Image fit</label>
      <select id="fit">
        <option value="cover">cover (crop to fill)</option>
        <option value="contain">contain (letterbox)</option>
      </select>
      <div class="muted small">Only applies when a reference image is provided.</div>
    </div>
    <div>
      <label>Character Lock</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input id="useLock" type="checkbox">
        <span class="muted small">Auto-attach server-side locked image</span>
      </div>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        <button id="lockStatus" type="button">Check lock</button>
        <button id="lockFromThumb" type="button">Lock from last video</button>
        <label style="display:inline-block">
          <input id="lockFile" type="file" accept="image/jpeg,image/png,image/webp" style="display:none">
          <span class="pill" style="cursor:pointer;padding:6px 10px">Upload lock image</span>
        </label>
        <button id="lockClear" type="button">Clear lock</button>
      </div>
      <div id="lockInfo" class="muted small" style="margin-top:6px"></div>
    </div>
  </div>

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
  const statusEl = $('status'), errEl = $('err'), vid = $('vid'), dl = $('dl'), hist = $('hist'), lockInfo = $('lockInfo');

  async function getJSON(u, opts){ const r = await fetch(u,opts); const j = await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||r.status); return j; }

  $('lockStatus').onclick = async () => {
    errEl.textContent=''; lockInfo.textContent='…';
    try { const j = await getJSON('/api/lock'); lockInfo.textContent = j.locked ? ('Locked ✓ ('+j.size+')') : 'No lock.'; }
    catch(e){ lockInfo.textContent = 'Error: '+e.message; }
  };

  $('lockClear').onclick = async () => {
    errEl.textContent=''; lockInfo.textContent='…';
    try { const r = await fetch('/api/lock', { method:'DELETE' }); const j = await r.json(); lockInfo.textContent = j.ok ? 'Lock cleared' : (j.error||'Error'); }
    catch(e){ lockInfo.textContent = 'Error: '+e.message; }
  };

  $('lockFile').addEventListener('change', async () => {
    const f = $('lockFile').files[0]; if(!f) return;
    errEl.textContent=''; lockInfo.textContent='Uploading…';
    const fd = new FormData(); fd.append('ref', f);
    try {
      const j = await getJSON('/api/lock/upload', { method:'POST', body: fd });
      lockInfo.textContent = 'Locked ✓ ('+j.size+')';
    } catch(e){ lockInfo.textContent = 'Error: '+e.message; }
    $('lockFile').value = '';
  });

  $('lockFromThumb').onclick = async () => {
    errEl.textContent=''; lockInfo.textContent='Fetching last thumbnail…';
    try {
      // naive: pick most recent completed job from /api/history
      const hist = await getJSON('/api/history');
      const done = hist.find(j => ['completed','succeeded','ready'].includes(String(j.status).toLowerCase()));
      if(!done){ lockInfo.textContent='No completed job found.'; return; }
      const j = await getJSON('/api/lock/from/'+encodeURIComponent(done.id));
      lockInfo.textContent = 'Locked from #'+done.id.slice(0,8)+' ✓ ('+j.size+')';
    } catch(e){ lockInfo.textContent = 'Error: '+e.message; }
  };

  $('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent=''; statusEl.textContent='Submitting job…';
    vid.style.display='none'; vid.removeAttribute('src'); dl.style.display='none';

    const form = new FormData();
    form.append('prompt', $('prompt').value.trim());
    form.append('seconds', $('seconds').value);
    form.append('size', $('size').value);
    form.append('fit', $('fit').value);
    form.append('useLock', $('useLock').checked ? '1' : '0');
    const f = $('ref').files[0];
    if (f) form.append('ref', f);

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

// ====== uploads ======
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp))$/i.test(file.mimetype || '');
    cb(ok ? null : new Error('Only JPG/PNG/WEBP images are allowed as reference.'), ok);
  }
});

// ====== Character Lock endpoints ======

// GET status
app.get('/api/lock', async (_req, res) => {
  if (!fs.existsSync(LOCK_FILE)) return res.json({ locked: false });
  const { size } = fs.statSync(LOCK_FILE);
  res.json({ locked: true, size: (size/1024).toFixed(1)+' KB' });
});

// DELETE clear
app.delete('/api/lock', async (_req, res) => {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); }
  catch { /* ignore */ }
  res.json({ ok: true });
});

// POST upload lock image
app.post('/api/lock/upload', upload.single('ref'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    // normalize to a medium baseline (we’ll still resize per-request later)
    const out = await sharp(req.file.buffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    fs.writeFileSync(LOCK_FILE, out);
    return res.json({ ok: true, size: (out.length/1024).toFixed(1)+' KB' });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// GET lock from last job’s thumbnail (or by id you can extend)
app.get('/api/lock/from/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const url = `https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=thumbnail`;
    const r = await fetchWithTimeout(url, { headers: apiHeaders() });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`Fetch thumb failed (${r.status}): ${txt}`);
    }
    const arrayBuf = await r.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    // Normalize/store as jpeg
    const out = await sharp(buf).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
    fs.writeFileSync(LOCK_FILE, out);
    return res.json({ ok: true, size: (out.length/1024).toFixed(1)+' KB' });
  } catch (e) {
    return res.status(400).json({ error: e?.message || String(e) });
  }
});

// ====== CREATE (with Character Lock + fallback) ======
app.post('/api/render', upload.single('ref'), async (req, res) => {
  const hadRef = !!req.file;
  const useLock = req.body?.useLock === '1';
  try {
    if (!OPENAI_API_KEY) throw new Error('Server missing OPENAI_API_KEY.');
    const prompt = (req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Empty prompt' });

    const seconds = normSeconds(req.body?.seconds);
    const size = normSize(req.body?.size);
    const fit = (req.body?.fit === 'contain') ? 'contain' : 'cover';

    async function buildForm(includeAdhocRef, includeLock) {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('seconds', seconds);
      form.append('size', size);
      form.append('model', VIDEO_MODEL);

      // Priority: ad-hoc ref (if provided), else lock (if requested and exists)
      if (includeAdhocRef && req.file) {
        const { buffer, mime, filename } = await processImageBufferToSize(req.file.buffer, size, fit);
        const blob = new Blob([buffer], { type: mime });
        form.append('input_reference', blob, filename);
      } else if (includeLock && useLock && fs.existsSync(LOCK_FILE)) {
        const raw = fs.readFileSync(LOCK_FILE);
        const { buffer, mime, filename } = await processImageBufferToSize(raw, size, fit);
        const blob = new Blob([buffer], { type: mime });
        form.append('input_reference', blob, filename);
      }
      return form;
    }

    // Attempt 1: include both (ad-hoc ref wins), or lock if requested
    try {
      const form1 = await buildForm(true, true);
      const job1 = await fetchJSON('https://api.openai.com/v1/videos', {
        method: 'POST',
        headers: apiHeaders(),
        body: form1
      });
      await upsertJob(job1.id, {
        prompt, seconds, size,
        status: job1.status || 'queued',
        createdAt: new Date().toISOString(),
        usedLock: (!!useLock && fs.existsSync(LOCK_FILE))
      });
      return res.json({ id: job1.id });
    } catch (err1) {
      const msg = String(err1?.message || '');
      const isModeration = /moderation/i.test(msg);
      const hadAnyRef = hadRef || (useLock && fs.existsSync(LOCK_FILE));
      if (hadAnyRef && isModeration && FALLBACK_WITHOUT_REF) {
        // Attempt 2: same request WITHOUT any image reference
        const form2 = await buildForm(false, false);
        const job2 = await fetchJSON('https://api.openai.com/v1/videos', {
          method: 'POST',
          headers: apiHeaders(),
          body: form2
        });
        await upsertJob(job2.id, {
          prompt, seconds, size,
          status: job2.status || 'queued',
          createdAt: new Date().toISOString(),
          note: 'reference removed due to moderation'
        });
        return res.json({ id: job2.id, note: 'Reference removed due to moderation' });
      }
      throw err1;
    }
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
