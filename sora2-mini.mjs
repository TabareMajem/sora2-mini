import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

// --- LowDB (JSON file) setup ---
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

const db = new Low(new JSONFile('history.json'), { jobs: [] });
await db.read();
if (!db.data) db.data = { jobs: [] };

// Helpers
async function upsertJob(id, patch) {
  const idx = db.data.jobs.findIndex(j => j.id === id);
  if (idx >= 0) db.data.jobs[idx] = { ...db.data.jobs[idx], ...patch };
  else db.data.jobs.push({ id, ...patch });
  await db.write();
}
function extractAssetUrl(out) {
  return (out?.assets?.video?.[0]?.url) || out?.asset_url || null;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- optional password gate via APP_PASSWORD ----
app.use((req, res, next) => {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return next();
  const header = req.headers['x-app-password'] || req.query.pwd;
  if (header === pass) return next();
  res.status(401).send('Unauthorized. Append ?pwd=YOUR_PASSWORD or send X-App-Password header.');
});

// ---- inline UI + history ----
app.get('/', async (_req, res) => {
  res.type('html').send(`<!doctype html>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sora 2 – Prompt → Video</title>
  <style>
    body{font:16px/1.4 system-ui,sans-serif;max-width:900px;margin:24px}
    textarea,input,select,button{width:100%;padding:10px;margin:6px 0}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    video{width:100%;margin-top:12px;display:none}
    .mono{font-family:ui-monospace,Menlo,monospace}
    .muted{color:#666}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .card{border:1px solid #ddd;border-radius:12px;padding:12px}
    .small{font-size:13px}
    .pill{display:inline-block;border:1px solid #ccc;border-radius:999px;padding:2px 8px;margin-left:8px}
    .nowrap{white-space:nowrap}
  </style>
  <h1>Sora 2 – Prompt to Video</h1>
  <form id=f>
    <label>Prompt</label>
    <textarea id=prompt rows=6 placeholder="Describe subject, setting, camera, motion, lighting, vibe..."></textarea>
    <div class=row>
      <div><label>Duration (s)</label><input id=duration type=number min=1 max=20 value=8></div>
      <div><label>Aspect ratio</label>
        <select id=ar><option>16:9</option><option>9:16</option><option>1:1</option></select>
      </div>
    </div>
    <label>Audio</label>
    <select id=audio><option value="auto">auto</option><option value="none">none</option></select>
    <button>Generate</button>
  </form>
  <p id=status class="mono muted"></p>
  <video id=vid controls></video>
  <a id=dl class="mono" download="output.mp4" style="display:none">Download video</a>

  <hr style="margin:24px 0">
  <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
    <h2 style="margin:0">History</h2>
    <div>
      <button id="refresh" type="button">Refresh</button>
      <button id="clear" type="button" title="clear local list only">Clear List</button>
    </div>
  </div>
  <div id="hist" class="grid"></div>

  <script>
    const $ = id => document.getElementById(id);
    const status = $('status'), vid = $('vid'), dl = $('dl');
    const hist = $('hist');

    $('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      status.textContent = 'Submitting job…';
      vid.style.display='none'; vid.removeAttribute('src'); dl.style.display='none';

      const r = await fetch('/api/render', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          prompt: $('prompt').value.trim(),
          duration: $('duration').value,
          aspect_ratio: $('ar').value,
          audio: $('audio').value
        })
      });
      const j = await r.json();
      if (j.error) { status.textContent = 'Error: '+j.error; return; }

      let done=false, assetUrl=null;
      while(!done){
        await new Promise(r=>setTimeout(r,2000));
        const s = await fetch('/api/status/'+j.id).then(r=>r.json());
        status.textContent = 'Status: '+s.status+(s.progress?' · '+s.progress:'');
        if (['completed','failed','canceled'].includes(s.status)) {
          done=true;
          if (s.status==='completed'){
            assetUrl = (s.assets?.video?.[0]?.url) || s.asset_url;
            vid.src = assetUrl; vid.style.display='block';
            dl.href = assetUrl; dl.style.display='inline-block';
            status.textContent = 'Done ✅';
            await refreshHistory();
          } else {
            status.textContent = 'Failed: '+(s.error?.message||s.status);
          }
        }
      }
    });

    async function refreshHistory(){
      const data = await fetch('/api/history').then(r=>r.json());
      hist.innerHTML = '';
      if (!Array.isArray(data) || data.length===0){
        hist.innerHTML = '<p class="muted">No history yet.</p>';
        return;
      }
      for (const j of data){
        const div = document.createElement('div');
        div.className = 'card small';
        const when = j.completedAt || j.updatedAt || j.createdAt || '';
        const url = j.assetUrl || '';
        div.innerHTML = \`
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
            <div class="mono nowrap">#\${j.id.slice(0,8)}…</div>
            <div class="pill">\${j.status||'unknown'}</div>
          </div>
          <div style="margin-top:6px"><b>Prompt</b><br>\${(j.prompt||'').replace(/</g,'&lt;')}</div>
          <div style="margin-top:6px">AR: \${j.aspect_ratio||'-'} · Dur: \${j.duration||'-'}s · Audio: \${(j.audio?.mode)||j.audio||'-'}</div>
          <div style="margin-top:6px;color:#666">\${when}</div>
          <div style="margin-top:8px">\${url ? ('<a href="'+url+'" target="_blank">Open video</a> · <a href="'+url+'" download="sora2-'+j.id+'.mp4">Download</a>') : ''}</div>
        \`;
        hist.appendChild(div);
      }
    }
    $('refresh').addEventListener('click', async () => { await refreshHistory(); });
    $('clear').addEventListener('click', () => { hist.innerHTML=''; });
    refreshHistory();
  </script>`);
});

// ---- API wiring ----
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/render', async (req, res) => {
  try {
    const { prompt, duration = 8, aspect_ratio = '16:9', audio = 'auto' } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Empty prompt' });

    const job = await client.videos.generate({
      model: 'sora-2',
      prompt,
      duration: Number(duration),
      aspect_ratio,
      audio: { mode: audio }
    });

    await upsertJob(job.id, {
      prompt, duration: Number(duration), aspect_ratio,
      audio: typeof audio === 'string' ? { mode: audio } : audio,
      status: job.status || 'queued',
      createdAt: new Date().toISOString()
    });

    res.json({ id: job.id });
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const out = await client.videos.retrieve(req.params.id);
    const patch = {
      status: out.status,
      progress: out.progress || null,
      updatedAt: new Date().toISOString()
    };
    if (out.status === 'completed') {
      patch.completedAt = new Date().toISOString();
      patch.assetUrl = extractAssetUrl(out);
    }
    await upsertJob(out.id, patch);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

app.get('/api/history', async (_req, res) => {
  await db.read();
  const jobs = (db.data.jobs || [])
    .slice()
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .slice(0, 50);
  res.json(jobs);
});

app.get('/api/job/:id', async (req, res) => {
  await db.read();
  const j = db.data.jobs.find(x => x.id === req.params.id);
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json(j);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log('Open http://localhost:' + PORT));
