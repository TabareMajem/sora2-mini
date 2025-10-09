import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

// =====================
// Config
// =====================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_ORG = process.env.OPENAI_ORG || '';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || '';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'sora-2';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || 'sora-2';
const FALLBACK_WITHOUT_REF = process.env.FALLBACK_WITHOUT_REF === 'true';
const ALLOWED_MODELS = new Set(['sora-2', 'sora-2-pro']);
const PORT = process.env.PORT || 4000;

if (!OPENAI_API_KEY) console.warn('[WARN] OPENAI_API_KEY not set');

const ALLOWED_SECONDS = ['4', '8', '12'];
const UI_SIZES = ['1280x720', '1920x1080', '720x1280', '1080x1080'];
const DEFAULT_SIZE = '1280x720';

// Folders
const ROOT = process.cwd();
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const LOCKS_DIR = path.join(UPLOAD_DIR, 'locks');
if (!fs.existsSync(LOCKS_DIR)) fs.mkdirSync(LOCKS_DIR, { recursive: true });

// =====================
// Databases
// =====================
const dbHistory = new Low(new JSONFile(path.join(ROOT, 'history.json')), { jobs: [] });
const dbChars = new Low(new JSONFile(path.join(ROOT, 'characters.json')), { characters: {} });
const dbSnapshots = new Low(new JSONFile(path.join(ROOT, 'snapshots.json')), { snapshots: [] });
await dbHistory.read(); dbHistory.data ||= { jobs: [] };
await dbChars.read(); dbChars.data ||= { characters: {} };
await dbSnapshots.read(); dbSnapshots.data ||= { snapshots: [] };

async function upsertJob(id, patch) {
  const arr = dbHistory.data.jobs || [];
  const i = arr.findIndex(j => j.id === id);
  if (i >= 0) arr[i] = { ...arr[i], ...patch };
  else arr.push({ id, ...patch });
  dbHistory.data.jobs = arr;
  await dbHistory.write();
}
const DONE = new Set(['completed', 'succeeded', 'ready']);

// =====================
// Helpers
// =====================
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
const normSeconds = v => (ALLOWED_SECONDS.includes(String(v || '').trim()) ? String(v).trim() : '4');
const normSize = v => (/^\d+x\d+$/.test(String(v || ''))) ? String(v) : DEFAULT_SIZE;
const parseSize = v => {
  const m = String(v || '').trim().match(/^(\d+)x(\d+)$/);
  if (!m) return { w: 1280, h: 720 };
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
};
async function processImageBufferToSize(inputBuffer, desiredSize, fitMode = 'cover') {
  const { w, h } = parseSize(desiredSize);
  let quality = 85;
  let out = await sharp(inputBuffer)
    .resize(w, h, { fit: fitMode === 'contain' ? 'contain' : 'cover', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  if (out.length > 15 * 1024 * 1024) {
    quality = 70;
    out = await sharp(inputBuffer)
      .resize(w, h, { fit: fitMode === 'contain' ? 'contain' : 'cover', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
  }
  return { buffer: out, mime: 'image/jpeg', filename: `reference_${w}x${h}.jpg` };
}

// =====================
// Express
// =====================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp))$/i.test(file.mimetype || '');
    cb(ok ? null : new Error('Only JPG/PNG/WEBP images are allowed.'), ok);
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, default_model: DEFAULT_MODEL, has_key: !!OPENAI_API_KEY }));

// =====================
// UI (four tabs)
// =====================
app.get('/', (_req, res) => {
  const sizeOptions = UI_SIZES.map(s => `<option>${s}</option>`).join('');
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sora 2 — Prompt → Video</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:1100px;margin:24px}
  textarea,input,select,button{width:100%;padding:10px;margin:6px 0}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .muted{color:#666}.small{font-size:13px}
  .tabs{display:flex;gap:8px;margin:8px 0 16px}
  .tabs button{padding:8px 14px;border:1px solid #ddd;background:#fafafa;border-radius:999px;cursor:pointer}
  .tabs button.active{background:#111;color:#fff;border-color:#111}
  .card{border:1px solid #e5e5e5;border-radius:12px;padding:12px}
  video{width:100%;display:none}
  img.thumb{max-width:100%;border:1px solid #eee;border-radius:8px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
</style>

<h1>Sora 2 — Prompt to Video</h1>

<div class="tabs">
  <button id="tabGen" class="active">🎬 Generate</button>
  <button id="tabStory">🗂️ Story</button>
  <button id="tabChars">👤 Characters</button>
  <button id="tabSnaps">🎨 Snapshots</button>
</div>

<section id="gen">
  <form id="f">
    <label>Prompt</label>
    <textarea id="prompt" rows="6" placeholder="Describe subject, setting, camera, motion, lighting, vibe..."></textarea>

    <div class="row">
      <div>
        <label>Seconds</label>
        <select id="seconds"><option>4</option><option>8</option><option>12</option></select>
        <div class="muted small">Your org supports 4, 8, 12s.</div>
      </div>
      <div>
        <label>Size (resolution)</label>
        <select id="size">${sizeOptions}</select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Model</label>
        <select id="model"><option value="sora-2">Sora 2</option><option value="sora-2-pro">Sora 2 Pro</option></select>
        <div class="muted small">If Pro isn't enabled, server can fall back to Sora 2.</div>
      </div>
      <div>
        <label>Image fit</label>
        <select id="fit"><option value="cover">cover (crop to fill)</option><option value="contain">contain (letterbox)</option></select>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Reference image (optional — JPG/PNG/WEBP)</label>
        <input id="ref" type="file" accept="image/jpeg,image/png,image/webp">
        <div class="muted small">We auto-resize to your selected Size.</div>
      </div>
      <div>
        <label>Character (optional)</label>
        <div class="row" style="grid-template-columns:2fr 1fr">
          <select id="character"></select>
          <label style="display:flex;gap:8px;align-items:center">
            <input id="useLock" type="checkbox"> <span class="small muted">Use Character Lock</span>
          </label>
        </div>
        <div class="row" style="grid-template-columns:1fr 1fr">
          <button id="btnCheckLock" type="button">Check lock</button>
          <button id="btnFromLast" type="button">Lock from last video</button>
        </div>
        <div class="row" style="grid-template-columns:1fr 1fr">
          <label style="display:inline-block">
            <input id="lockFile" type="file" accept="image/jpeg,image/png,image/webp" style="display:none">
            <span class="card" style="cursor:pointer;text-align:center">Upload lock image</span>
          </label>
          <button id="btnClearLock" type="button">Clear lock</button>
        </div>
        <div class="row" style="grid-template-columns:1fr 1fr">
          <button id="btnDownloadLock" type="button">Download lock</button>
          <div class="muted small" id="lockInfo">No lock.</div>
        </div>
        <img id="lockPreview" class="thumb" style="display:none;margin-top:6px"/>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Character Bible</label>
        <textarea id="bible" rows="7" placeholder="Stable character sheet: name, age, face, hair, outfit, accessories, style constraints, etc."></textarea>
        <div class="row" style="grid-template-columns:1fr 1fr">
          <button id="saveBible" type="button">Save Bible to character</button>
          <label style="display:flex;gap:6px;align-items:center">
            <input id="appendBible" type="checkbox"> <span class="small muted">Append Bible to prompt</span>
          </label>
        </div>
      </div>
      <div>
        <label>Snapshots</label>
        <div class="row" style="grid-template-columns:1fr 1fr">
          <button id="saveSnap" type="button">💾 Save Style Snapshot</button>
          <select id="snapSelect"></select>
        </div>
        <div class="row" style="grid-template-columns:1fr 1fr">
          <button id="loadSnap" type="button">Load Snapshot</button>
          <button id="delSnap" type="button">Delete Snapshot</button>
        </div>
      </div>
    </div>

    <button>Generate</button>
  </form>

  <p id="status" class="small muted"></p>
  <p id="err" class="small" style="color:#b00020"></p>
  <video id="vid" controls></video>
  <a id="dl" class="small" download="output.mp4" style="display:none">Download video</a>

  <hr>
  <div style="display:flex;justify-content:space-between;align-items:center">
    <h2 style="margin:0">Recent history</h2>
    <div>
      <button id="refresh" type="button">Refresh</button>
      <button id="clear" type="button">Clear List</button>
    </div>
  </div>
  <div id="hist" class="grid"></div>
</section>

<section id="story" style="display:none">
  <h2>Story Timeline</h2>
  <div class="row">
    <div>
      <label>Filter by character (optional)</label>
      <select id="storyChar"></select>
    </div>
    <div>
      <label>Filter by model</label>
      <select id="storyModel"><option value="">All</option><option>sora-2</option><option>sora-2-pro</option></select>
    </div>
  </div>
  <button id="loadStory" type="button">Load Timeline</button>
  <div id="timeline" class="grid" style="margin-top:12px"></div>
</section>

<section id="chars" style="display:none">
  <h2>Characters</h2>
  <div class="row">
    <div>
      <label>Characters</label>
      <select id="charList"></select>
    </div>
    <div>
      <label>&nbsp;</label>
      <div class="row" style="grid-template-columns:1fr 1fr">
        <button id="addChar" type="button">Add character</button>
        <button id="delChar" type="button">Delete character</button>
      </div>
    </div>
  </div>
  <div id="charInfo" class="muted small"></div>
</section>

<section id="snaps" style="display:none">
  <h2>Snapshots</h2>
  <div id="snapList" class="grid"></div>
</section>

<script>
const $ = id => document.getElementById(id);

// Tabs
function showTab(which){
  ['gen','story','chars','snaps'].forEach(id => document.getElementById(id).style.display = (id===which?'block':'none'));
  ['tabGen','tabStory','tabChars','tabSnaps'].forEach(id => document.getElementById(id).classList.remove('active'));
  ({gen:'tabGen',story:'tabStory',chars:'tabChars',snaps:'tabSnaps'})[which] && document.getElementById(({gen:'tabGen',story:'tabStory',chars:'tabChars',snaps:'tabSnaps'})[which]).classList.add('active');
}
tabGen.onclick=()=>showTab('gen'); tabStory.onclick=()=>showTab('story'); tabChars.onclick=()=>showTab('chars'); tabSnaps.onclick=()=>showTab('snaps');

async function getJSON(u, opts){ const r=await fetch(u,opts); const j=await r.json().catch(()=>({})); if(!r.ok) throw new Error(j.error||r.status); return j; }

async function loadCharacters() {
  const j = await getJSON('/api/characters');
  const names = j.map(x=>x.name);
  function fill(sel){ sel.innerHTML = names.map(n=>\`<option>\${n}</option>\`).join(''); }
  fill($('character')); fill($('charList'));
  $('storyChar').innerHTML = '<option value="">(all)</option>' + names.map(n=>\`<option>\${n}</option>\`).join('');
  if(!names.length){ $('character').innerHTML=''; $('charList').innerHTML=''; $('storyChar').innerHTML='<option value="">(none)</option>'; }
}
async function refreshLockUI(){
  const name = $('character').value; if(!name){ $('lockPreview').style.display='none'; $('lockInfo').textContent='No lock.'; return; }
  try {
    const j = await getJSON('/api/character/'+encodeURIComponent(name));
    if (j.locked) { $('lockPreview').src='/api/character/'+encodeURIComponent(name)+'/preview?ts='+Date.now(); $('lockPreview').style.display='block'; $('lockInfo').textContent='Locked ✓'; }
    else { $('lockPreview').style.display='none'; $('lockInfo').textContent='No lock.'; }
    $('bible').value = j.bible || '';
  } catch(e){ $('lockPreview').style.display='none'; $('lockInfo').textContent='Error: '+e.message; }
}
async function loadSnapshotsDrop(){
  const snaps = await getJSON('/api/snapshots');
  $('snapSelect').innerHTML = snaps.map(s=>\`<option value="\${s.id}">\${s.title}</option>\`).join('');
  const grid = $('snapList'); grid.innerHTML='';
  for (const s of snaps){
    const div = document.createElement('div'); div.className='card small';
    div.innerHTML = \`<b>\${s.title}</b><div class="muted">model:\${s.model} • size:\${s.size} • seconds:\${s.seconds} • fit:\${s.fit} • char:\${s.character||'(none)'}<br>\${s.prompt.replaceAll('<','&lt;')}</div>\`;
    grid.appendChild(div);
  }
}

// Characters tab actions
$('addChar').onclick = async () => {
  const name = prompt('Character name (unique):'); if(!name) return;
  try { await getJSON('/api/character', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) }); await loadCharacters(); alert('Added'); }
  catch(e){ alert('Error: '+e.message); }
};
$('delChar').onclick = async () => {
  const name = $('charList').value; if(!name) return alert('Pick a character');
  if(!confirm('Delete '+name+'?')) return;
  try { await getJSON('/api/character/'+encodeURIComponent(name), { method:'DELETE' }); await loadCharacters(); $('charInfo').textContent='Deleted.'; }
  catch(e){ alert('Error: '+e.message); }
};
$('charList').onchange = async () => {
  const name = $('charList').value; if(!name){ $('charInfo').textContent=''; return; }
  const j = await getJSON('/api/character/'+encodeURIComponent(name));
  $('charInfo').textContent = 'Bible: '+(j.bible ? (j.bible.slice(0,120)+'…') : '(empty)') + ' • Lock: ' + (j.locked?'yes':'no');
};

// Generate tab character lock actions
$('character').onchange = refreshLockUI;
$('btnCheckLock').onclick = refreshLockUI;
$('btnClearLock').onclick = async () => {
  const name = $('character').value; if(!name) return alert('Pick a character');
  try { await getJSON('/api/character/'+encodeURIComponent(name)+'/lock', { method:'DELETE' }); await refreshLockUI(); }
  catch(e){ alert('Error: '+e.message); }
};
$('lockFile').addEventListener('change', async ()=>{
  const name = $('character').value; if(!name) return alert('Pick a character');
  const f = $('lockFile').files[0]; if(!f) return;
  const fd = new FormData(); fd.append('lock', f);
  try { await getJSON('/api/character/'+encodeURIComponent(name)+'/lock', { method:'POST', body: fd }); await refreshLockUI(); }
  catch(e){ alert('Error: '+e.message); }
  $('lockFile').value='';
});
$('btnDownloadLock').onclick = () => {
  const name = $('character').value; if(!name) return alert('Pick a character');
  window.open('/api/character/'+encodeURIComponent(name)+'/lock/download','_blank');
};
$('btnFromLast').onclick = async () => {
  const name = $('character').value; if(!name) return alert('Pick a character');
  try { await getJSON('/api/character/'+encodeURIComponent(name)+'/lock/from-last', { method:'POST' }); await refreshLockUI(); }
  catch(e){ alert('Error: '+e.message); }
};
$('saveBible').onclick = async () => {
  const name = $('character').value; if(!name) return alert('Pick a character');
  try {
    await getJSON('/api/character/'+encodeURIComponent(name)+'/bible', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: $('bible').value }) });
    alert('Bible saved');
  } catch(e){ alert('Error: '+e.message); }
};

// Snapshots actions
$('saveSnap').onclick = async () => {
  const title = prompt('Snapshot title:'); if(!title) return;
  const body = {
    title,
    prompt: $('prompt').value,
    seconds: $('seconds').value,
    size: $('size').value,
    model: $('model').value,
    fit: $('fit').value,
    character: $('character').value || ''
  };
  try { await getJSON('/api/snapshot', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }); await loadSnapshotsDrop(); alert('Saved'); }
  catch(e){ alert('Error: '+e.message); }
};
$('loadSnap').onclick = async () => {
  const id = $('snapSelect').value; if(!id) return;
  const s = await getJSON('/api/snapshot/'+encodeURIComponent(id));
  $('prompt').value = s.prompt; $('seconds').value = s.seconds; $('size').value = s.size; $('model').value = s.model; $('fit').value=s.fit;
  if (s.character) $('character').value = s.character;
  await refreshLockUI();
};
$('delSnap').onclick = async () => {
  const id = $('snapSelect').value; if(!id) return;
  if(!confirm('Delete this snapshot?')) return;
  await getJSON('/api/snapshot/'+encodeURIComponent(id), { method:'DELETE' });
  await loadSnapshotsDrop();
};

// Generate submit
$('appendBible').checked = localStorage.getItem('appendBible') === '1';
$('appendBible').onchange = () => localStorage.setItem('appendBible', $('appendBible').checked?'1':'0');

$('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status=$('status'), err=$('err'), vid=$('vid'), dl=$('dl');
  err.textContent=''; status.textContent='Submitting…'; vid.style.display='none'; vid.removeAttribute('src'); dl.style.display='none';

  let p = $('prompt').value.trim();
  if ($('appendBible').checked && $('bible').value.trim()){
    p = \`CHARACTER BIBLE:\\n\${$('bible').value.trim()}\\n\\nSCENE PROMPT:\\n\${p}\`;
  }

  const fd = new FormData();
  fd.append('prompt', p);
  fd.append('seconds', $('seconds').value);
  fd.append('size', $('size').value);
  fd.append('fit', $('fit').value);
  fd.append('model', $('model').value);
  fd.append('useLock', $('useLock').checked ? '1' : '0');
  if ($('character').value) fd.append('character', $('character').value);
  if ($('ref').files[0]) fd.append('ref', $('ref').files[0]);

  const r = await fetch('/api/render', { method:'POST', body: fd });
  const j = await r.json().catch(()=>({error:'bad json'}));
  if(!r.ok || j.error){ err.textContent = 'Create error: ' + (j.error || r.status); status.textContent=''; return; }

  let done=false, started=Date.now();
  while(!done){
    await new Promise(r=>setTimeout(r,2000));
    const sResp = await fetch('/api/status/'+j.id);
    let s; try { s=await sResp.json(); } catch { s={error:'bad json'} }
    if(!sResp.ok || s.error){
      const msg=(s&&s.error&&(s.error.message||s.error))||JSON.stringify(s)||('HTTP '+sResp.status);
      err.textContent='Status error: '+msg; status.textContent=''; return;
    }
    const prog=s.progress??''; status.textContent='Status: '+s.status+(prog!==''?' · '+prog:'');
    const final=['completed','succeeded','ready'].includes(String(s.status).toLowerCase());
    if(final){
      const streamUrl='/api/content/'+j.id+'?type=video';
      vid.src=streamUrl; vid.style.display='block';
      dl.href=streamUrl; dl.style.display='inline-block';
      status.textContent='Done ✅'; await refreshHistory(); done=true;
    }else if(String(s.status).toLowerCase()==='in_progress' && Number(prog)===100){
      const head=await fetch('/api/ping-content/'+j.id+'?type=video');
      if(head.ok){ const url='/api/content/'+j.id+'?type=video'; vid.src=url; vid.style.display='block'; dl.href=url; dl.style.display='inline-block'; status.textContent='Ready ✅'; await refreshHistory(); done=true; }
      else if(Date.now()-started>10*60*1000){ err.textContent='Took too long after 100% — try again.'; status.textContent=''; done=true; }
    } else if (Date.now()-started>15*60*1000){ err.textContent='Timed out — try again.'; status.textContent=''; done=true; }
  }
});

async function refreshHistory(){
  const r = await fetch('/api/history'); const data = await r.json().catch(()=>[]);
  const box = $('hist'); box.innerHTML='';
  if(!Array.isArray(data) || !data.length){ box.innerHTML='<p class="muted">No history yet.</p>'; return; }
  for(const j of data){
    const div=document.createElement('div'); div.className='card small';
    div.innerHTML=\`
      <div style="display:flex;justify-content:space-between;gap:8px">
        <div class="muted mono">#\${j.id.slice(0,8)}…</div>
        <div>\${j.status||'unknown'}</div>
      </div>
      <div class="muted small">\${j.character?('char: '+j.character+' · '):''}model:\${j.model} · size:\${j.size} · s:\${j.seconds}</div>
      <div style="margin-top:6px">\${(j.prompt||'').replaceAll('<','&lt;')}</div>
      <div style="margin-top:8px">
        <a href="/api/content/\${j.id}?type=video" target="_blank">Open</a> ·
        <a href="/api/content/\${j.id}?type=video" download="sora2-\${j.id}.mp4">Download</a>
      </div>\`;
    box.appendChild(div);
  }
}

$('loadStory').onclick = async ()=>{
  const q = new URLSearchParams();
  if ($('storyChar').value) q.set('character',$('storyChar').value);
  if ($('storyModel').value) q.set('model',$('storyModel').value);
  const j = await getJSON('/api/story?'+q.toString());
  const box=$('timeline'); box.innerHTML='';
  for(const it of j){
    const d=document.createElement('div'); d.className='card small';
    d.innerHTML=\`
      <div style="display:flex;justify-content:space-between">
        <b>\${it.createdAt?.slice(0,19).replace('T',' ')||''}</b>
        <span class="muted">\${it.model}</span>
      </div>
      <div class="muted small">\${it.character?('char: '+it.character+' · '):''}size:\${it.size} · s:\${it.seconds}</div>
      <div style="margin-top:6px">\${(it.prompt||'').replaceAll('<','&lt;')}</div>
      <div style="margin-top:8px">
        <a href="/api/content/\${it.id}?type=video" target="_blank">Open</a> ·
        <a href="/api/content/\${it.id}?type=video" download>Download</a> ·
        <a href="/api/content/\${it.id}?type=thumbnail" target="_blank">Thumbnail</a>
      </div>\`;
    box.appendChild(d);
  }
};

(async function init(){
  await loadCharacters();
  await refreshLockUI();
  await loadSnapshotsDrop();
  await refreshHistory();
})();
</script>`);
});

// =====================
// Character helpers
// =====================
function charFile(name){ return path.join(LOCKS_DIR, `${name}.jpg`); }
function safeName(n){ return String(n||'').trim().replace(/[^\w\-\.\s]/g,'').slice(0,60); }

// Characters API
app.get('/api/characters', async (_req,res) => {
  await dbChars.read();
  const out = Object.keys(dbChars.data.characters)
    .sort()
    .map(name => {
      const c = dbChars.data.characters[name] || {};
      const locked = fs.existsSync(charFile(name));
      return { name, locked, bible: c.bible || '' };
    });
  res.json(out);
});
app.post('/api/character', async (req,res) => {
  const name = safeName(req.body?.name);
  if(!name) return res.status(400).json({ error:'Missing name' });
  await dbChars.read();
  dbChars.data.characters[name] ||= { bible:'', createdAt:new Date().toISOString() };
  dbChars.data.characters[name].updatedAt = new Date().toISOString();
  await dbChars.write();
  res.json({ ok:true, name });
});
app.get('/api/character/:name', async (req,res) => {
  const name = safeName(req.params.name);
  await dbChars.read();
  const c = dbChars.data.characters[name] || { bible:'' };
  res.json({ name, bible: c.bible || '', locked: fs.existsSync(charFile(name)) });
});
app.delete('/api/character/:name', async (req,res) => {
  const name = safeName(req.params.name);
  await dbChars.read();
  delete dbChars.data.characters[name];
  await dbChars.write();
  try { if (fs.existsSync(charFile(name))) fs.unlinkSync(charFile(name)); } catch {}
  res.json({ ok:true });
});

// Lock image endpoints
app.post('/api/character/:name/lock', uploadImage.single('lock'), async (req,res) => {
  const name = safeName(req.params.name);
  if(!req.file) return res.status(400).json({ error:'No file' });
  const out = await sharp(req.file.buffer).jpeg({ quality:90, mozjpeg:true }).toBuffer();
  fs.writeFileSync(charFile(name), out);
  res.json({ ok:true, size: (out.length/1024).toFixed(1)+' KB' });
});
app.delete('/api/character/:name/lock', async (req,res) => {
  const name = safeName(req.params.name);
  try { if(fs.existsSync(charFile(name))) fs.unlinkSync(charFile(name)); } catch {}
  res.json({ ok:true });
});
app.get('/api/character/:name/preview', (req,res) => {
  const name = safeName(req.params.name);
  if(!fs.existsSync(charFile(name))) return res.status(404).send('No lock');
  res.setHeader('Content-Type','image/jpeg');
  res.setHeader('Cache-Control','no-store');
  fs.createReadStream(charFile(name)).pipe(res);
});
app.get('/api/character/:name/lock/download', (req,res) => {
  const name = safeName(req.params.name);
  if(!fs.existsSync(charFile(name))) return res.status(404).send('No lock');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-lock.jpg"`);
  fs.createReadStream(charFile(name)).pipe(res);
});
app.post('/api/character/:name/lock/from-last', async (req,res) => {
  const name = safeName(req.params.name);
  await dbHistory.read();
  const last = (dbHistory.data.jobs||[]).slice().reverse().find(j => DONE.has(String(j.status).toLowerCase()));
  if(!last) return res.status(404).json({ error:'No completed job found' });
  const url = `https://api.openai.com/v1/videos/${encodeURIComponent(last.id)}/content?type=thumbnail`;
  const r = await fetchWithTimeout(url, { headers: apiHeaders() });
  if(!r.ok){ const t=await r.text(); return res.status(400).json({ error:`Fetch thumb failed (${r.status}): ${t}` }); }
  const buf = Buffer.from(await r.arrayBuffer());
  const out = await sharp(buf).jpeg({ quality:90, mozjpeg:true }).toBuffer();
  fs.writeFileSync(charFile(name), out);
  res.json({ ok:true, size: (out.length/1024).toFixed(1)+' KB' });
});

// Bible
app.get('/api/character/:name/bible', async (req,res)=>{
  const name = safeName(req.params.name);
  await dbChars.read();
  res.json({ bible: (dbChars.data.characters[name]||{}).bible || '' });
});
app.post('/api/character/:name/bible', async (req,res)=>{
  const name = safeName(req.params.name);
  const text = String(req.body?.text || '');
  await dbChars.read();
  dbChars.data.characters[name] ||= {};
  dbChars.data.characters[name].bible = text;
  dbChars.data.characters[name].updatedAt = new Date().toISOString();
  await dbChars.write();
  res.json({ ok:true });
});

// =====================
// Snapshots
// =====================
function makeId(){ return 'snap_'+Math.random().toString(36).slice(2,10); }
app.get('/api/snapshots', async (_req,res) => {
  await dbSnapshots.read();
  res.json(dbSnapshots.data.snapshots || []);
});
app.get('/api/snapshot/:id', async (req,res) => {
  await dbSnapshots.read();
  const it = (dbSnapshots.data.snapshots||[]).find(s=>s.id===req.params.id);
  if(!it) return res.status(404).json({ error:'Not found' });
  res.json(it);
});
app.post('/api/snapshot', async (req,res) => {
  const { title, prompt, seconds, size, model, fit, character } = req.body || {};
  if (!title) return res.status(400).json({ error:'Missing title' });
  await dbSnapshots.read();
  const id = makeId();
  const it = { id, title, prompt:String(prompt||''), seconds:String(seconds||'4'), size:String(size||DEFAULT_SIZE), model:String(model||DEFAULT_MODEL), fit:(fit==='contain'?'contain':'cover'), character:String(character||'') };
  dbSnapshots.data.snapshots.push(it);
  await dbSnapshots.write();
  res.json(it);
});
app.delete('/api/snapshot/:id', async (req,res) => {
  await dbSnapshots.read();
  dbSnapshots.data.snapshots = (dbSnapshots.data.snapshots||[]).filter(s=>s.id!==req.params.id);
  await dbSnapshots.write();
  res.json({ ok:true });
});

// =====================
// Render / Status / Content / List / Story
// =====================
app.post('/api/render', uploadImage.single('ref'), async (req,res) => {
  const hadRef = !!req.file;
  const useLock = req.body?.useLock === '1';
  const charName = (req.body?.character || '').trim();

  try {
    if (!OPENAI_API_KEY) throw new Error('Server missing OPENAI_API_KEY.');
    let prompt = (req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error:'Empty prompt' });

    const seconds = normSeconds(req.body?.seconds);
    const size = normSize(req.body?.size);
    const fit = (req.body?.fit === 'contain') ? 'contain' : 'cover';
    const requestedModel = String(req.body?.model || DEFAULT_MODEL);
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : DEFAULT_MODEL;

    async function buildForm(includeAdhocRef, includeLock, modelName){
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('seconds', seconds);
      form.append('size', size);
      form.append('model', modelName);

      if (includeAdhocRef && req.file) {
        const { buffer, mime, filename } = await processImageBufferToSize(req.file.buffer, size, fit);
        form.append('input_reference', new Blob([buffer], { type: mime }), filename);
      } else if (includeLock && useLock && charName && fs.existsSync(charFile(charName))) {
        const raw = fs.readFileSync(charFile(charName));
        const { buffer, mime, filename } = await processImageBufferToSize(raw, size, fit);
        form.append('input_reference', new Blob([buffer], { type: mime }), filename);
      }
      return form;
    }

    try {
      const form1 = await buildForm(true, true, model);
      const job1 = await fetchJSON('https://api.openai.com/v1/videos', { method:'POST', headers: apiHeaders(), body: form1 });
      await upsertJob(job1.id, {
        prompt, seconds, size, model, status: job1.status || 'queued',
        character: charName || '', createdAt: new Date().toISOString(),
        usedLock: !!(useLock && charName && fs.existsSync(charFile(charName)))
      });
      return res.json({ id: job1.id });
    } catch (err1) {
      const m = String(err1?.message || '');
      const isModeration = /moderation/i.test(m);
      const hasAccessIssue = /forbidden|not\s+authorized|access|permission/i.test(m) || m.startsWith('403:');
      const hadAnyRef = hadRef || (useLock && charName && fs.existsSync(charFile(charName)));

      // fallback model if access issue
      if (hasAccessIssue && FALLBACK_MODEL && FALLBACK_MODEL !== model && ALLOWED_MODELS.has(FALLBACK_MODEL)) {
        try {
          const formFb = await buildForm(true, true, FALLBACK_MODEL);
          const jobFb = await fetchJSON('https://api.openai.com/v1/videos', { method:'POST', headers: apiHeaders(), body: formFb });
          await upsertJob(jobFb.id, {
            prompt, seconds, size, model: FALLBACK_MODEL,
            status: jobFb.status || 'queued', createdAt: new Date().toISOString(),
            character: charName || '',
            usedLock: !!(useLock && charName && fs.existsSync(charFile(charName))),
            note: `model fallback from ${model} -> ${FALLBACK_MODEL}`
          });
          return res.json({ id: jobFb.id, note: `Model fallback to ${FALLBACK_MODEL}` });
        } catch (errFb) { err1 = errFb; }
      }

      // moderation fallback without ref
      if (hadAnyRef && isModeration && FALLBACK_WITHOUT_REF) {
        const form2 = await buildForm(false, false, model);
        const job2 = await fetchJSON('https://api.openai.com/v1/videos', { method:'POST', headers: apiHeaders(), body: form2 });
        await upsertJob(job2.id, {
          prompt, seconds, size, model, status: job2.status || 'queued',
          character: charName || '', createdAt: new Date().toISOString(),
          note: 'reference removed due to moderation'
        });
        return res.json({ id: job2.id, note:'Reference removed due to moderation' });
      }

      throw err1;
    }
  } catch (e) {
    res.status(400).json({ error: 'OpenAI create failed: ' + (e?.message || String(e)) });
  }
});

app.get('/api/status/:id', async (req,res) => {
  try {
    const id = req.params.id;
    const resp = await fetchWithTimeout(
      `https://api.openai.com/v1/videos/${encodeURIComponent(id)}`,
      { headers: apiHeaders() }
    );
    const txt = await resp.text();
    if (!resp.ok) throw new Error(`${resp.status}: ${txt}`);
    const out = JSON.parse(txt);

    let status = String(out.status||'').toLowerCase();
    if (status==='in_progress' && Number(out.progress)===100) {
      const head = await fetch(
        `https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=video`,
        { method:'HEAD', headers: apiHeaders() }
      );
      if (head.ok) { status='ready'; out.status='ready'; }
    }

    const patch = { status: out.status, progress: out.progress ?? null, updatedAt: new Date().toISOString() };
    if (['completed','succeeded','ready'].includes(status)) patch.completedAt = new Date().toISOString();
    await upsertJob(out.id, patch);

    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'OpenAI retrieve failed: ' + (e?.message || String(e)) });
  }
});

app.get('/api/ping-content/:id', async (req,res)=>{
  try {
    const id = req.params.id;
    const t = (req.query.type||'video').toString();
    const r = await fetch(`https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=${encodeURIComponent(t)}`, { method:'HEAD', headers: apiHeaders() });
    return res.status(r.ok?200:r.status).send(r.ok?'ok':'not ready');
  } catch { return res.status(500).send('error'); }
});
app.get('/api/content/:id', async (req,res)=>{
  try {
    const id = req.params.id;
    const t = (req.query.type||'video').toString();
    const url = `https://api.openai.com/v1/videos/${encodeURIComponent(id)}/content?type=${encodeURIComponent(t)}`;
    await streamFromOpenAI(url, apiHeaders(), res);
  } catch(e){ res.status(500).send('Content proxy error: '+(e?.message||String(e))); }
});
app.get('/api/list', async (req,res)=>{
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const data = await fetchJSON(`https://api.openai.com/v1/videos?limit=${limit}`, { headers: apiHeaders() });
    res.json(data);
  } catch (e) { res.status(400).json({ error: 'OpenAI list failed: ' + (e?.message || String(e)) }); }
});

app.get('/api/story', async (req,res)=>{
  await dbHistory.read();
  let arr = (dbHistory.data.jobs||[]).filter(j => DONE.has(String(j.status).toLowerCase()));
  const { character='', model='' } = req.query || {};
  if (character) arr = arr.filter(j=>String(j.character||'')===String(character));
  if (model)     arr = arr.filter(j=>String(j.model||'')===String(model));
  arr = arr.slice().sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||''));
  res.json(arr);
});

app.get('/api/history', async (_req,res)=>{
  await dbHistory.read();
  const jobs = (dbHistory.data.jobs||[]).slice().sort((a,b) => (b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,50);
  res.json(jobs);
});
app.get('/api/job/:id', async (req,res)=>{
  await dbHistory.read();
  const j = (dbHistory.data.jobs||[]).find(x=>x.id===req.params.id);
  if (!j) return res.status(404).json({ error:'Not found' });
  res.json(j);
});
// last middleware: catch uncaught errors and show JSON
app.use((err, _req, res, _next) => {
  console.error('[UNCAUGHT]', err?.stack || err);
  res.status(500).json({ error: 'Server error', detail: err?.message || String(err) });
});

// Start
app.listen(PORT, ()=>console.log('Open http://localhost:'+PORT));
