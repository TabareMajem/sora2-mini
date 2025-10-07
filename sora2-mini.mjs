import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- inline minimal HTML UI ----
app.get('/', (_, res) => {
  res.type('html').send(`<!doctype html>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sora 2 – Prompt → Video</title>
  <style>
    body{font:16px/1.4 system-ui,sans-serif;max-width:780px;margin:24px}
    textarea,input,select,button{width:100%;padding:10px;margin:6px 0}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    video{width:100%;margin-top:12px;display:none}
    .mono{font-family:ui-monospace,Menlo,monospace}
    .muted{color:#666}
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

  <script>
    const $ = id => document.getElementById(id);
    const status = $('status'), vid = $('vid'), dl = $('dl');
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
          } else {
            status.textContent = 'Failed: '+(s.error?.message||s.status);
          }
        }
      }
    });
  </script>`);
});

// ---- API wiring ----
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/api/render', async (req, res) => {
  try {
    const { prompt, duration = 8, aspect_ratio = '16:9', audio = 'auto' } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Empty prompt' });

    const job = await client.videos.generate({
      model: 'sora-2',           // 'sora-2-pro' if your org has it
      prompt,
      duration: Number(duration),
      aspect_ratio,
      audio: { mode: audio }
      // Optional: remix_id, references, seeds, style, camera controls, etc.
    });
    res.json({ id: job.id });
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const out = await client.videos.retrieve(req.params.id);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e?.message || String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Open http://localhost:'+PORT));
