'use strict';
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const OWNER = process.env.GITHUB_OWNER;
const PUBLIC_REPO = process.env.PUBLIC_REPO || '10BArchive';
const PENDING_REPO = process.env.PENDING_REPO || '10BArchive-Pending';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const TOKEN = process.env.GITHUB_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const MAX_MB = Math.min(25, Math.max(1, Number(process.env.MAX_UPLOAD_MB || 25)));
const MAX_BYTES = MAX_MB * 1024 * 1024;
const API = 'https://api.github.com';
const ALLOWED_EXT = new Set(['.pdf','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.jpg','.jpeg','.png']);

if (!OWNER || !TOKEN || !ADMIN_PASSWORD) {
  console.warn('WARNING: Set GITHUB_OWNER, GITHUB_TOKEN, and ADMIN_PASSWORD in the Render environment.');
}
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
const origins = (process.env.FRONTEND_ORIGIN || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) {
  if (!origin || origins.length === 0 || origins.includes(origin)) return cb(null, true);
  return cb(new Error('This website origin is not allowed by the backend CORS policy.'));
}, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','x-admin-password'] }));
app.use(express.json({ limit: '100kb' }));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

function apiPath(repo, path='') { return `${API}/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`; }
async function gh(url, options={}) {
  const res = await fetch(url, { ...options, headers: {
    'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28', ...(options.headers || {})
  }});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || `GitHub API returned ${res.status}`);
    err.status = res.status; throw err;
  }
  return body;
}
function cleanText(s, max=120) { return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0,max); }
function safeName(s) {
  const base = String(s || 'upload').normalize('NFKC').replace(/[\\/]/g,'_').replace(/[^\p{L}\p{N}._ ()-]/gu,'_').replace(/\.\./g,'_').trim().slice(0,140);
  return base && base !== '.' ? base : 'upload';
}
function validDestination(s) {
  const v = String(s || '').replace(/^\/+|\/+$/g, '');
  if (!v || v.length > 240 || v.split('/').some(p => !p || p === '.' || p === '..')) return false;
  return v.startsWith('Math/');
}
function requireAdmin(req,res,next) {
  const supplied = String(req.get('x-admin-password') || '');
  const a = Buffer.from(supplied); const b = Buffer.from(ADMIN_PASSWORD || 'missing-admin-password');
  if (a.length !== b.length || !crypto.timingSafeEqual(a,b) || !ADMIN_PASSWORD) return res.status(401).json({error:'Incorrect admin password.'});
  next();
}
async function putFile(repo, path, content, message) {
  return gh(apiPath(repo,path), {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message, content:Buffer.isBuffer(content)?content.toString('base64'):Buffer.from(String(content)).toString('base64'), branch:BRANCH})});
}
async function getContent(repo,path) { return gh(apiPath(repo,path)); }
async function getFileBytes(repo, contentRecord) {
  if (contentRecord.content && contentRecord.encoding === 'base64') return Buffer.from(contentRecord.content.replace(/\n/g,''),'base64');
  // Contents API omits file contents for files larger than 1 MB; the Git Blob API returns base64 content.
  const blob = await gh(`${API}/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(contentRecord.sha)}`);
  if (!blob.content || blob.encoding !== 'base64') throw new Error('GitHub did not return file contents.');
  return Buffer.from(blob.content.replace(/\n/g,''),'base64');
}
async function deleteFile(repo,path,sha,message) {
  return gh(apiPath(repo,path), {method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message,sha,branch:BRANCH})});
}
async function tree(repo) {
  const info = await gh(`${API}/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(BRANCH)}?recursive=1`);
  if (info.truncated) throw new Error('Repository tree is too large to list in one request.');
  return info.tree || [];
}
function isSafeRepoPath(path) { return typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..'); }

app.get('/api/health', (_req,res) => res.json({ok:true, service:'10BArchive backend'}));

// Student submissions are stored only in the private pending repository.
app.post('/api/submissions', upload.single('file'), async (req,res) => {
  try {
    if (!OWNER || !TOKEN) return res.status(503).json({error:'The submission service is not configured yet.'});
    if (!req.file) return res.status(400).json({error:'Choose a file to submit.'});
    const original = safeName(req.file.originalname);
    const ext = original.includes('.') ? original.slice(original.lastIndexOf('.')).toLowerCase() : '';
    if (!ALLOWED_EXT.has(ext)) return res.status(415).json({error:'This file type is not allowed.'});
    const destination = String(req.body.destination || '');
    if (!validDestination(destination)) return res.status(400).json({error:'Choose a valid Math archive destination.'});
    const id = crypto.randomUUID();
    const filePath = `pending/${id}/${original}`;
    const metadata = {
      id, originalName: original, storedPath: filePath, destination,
      studentName: cleanText(req.body.studentName,80), size: req.file.size,
      mimeType: req.file.mimetype, submittedAt: new Date().toISOString(), status:'pending'
    };
    await putFile(PENDING_REPO,filePath,req.file.buffer,`New private submission ${id}`);
    try {
      await putFile(PENDING_REPO,`pending/${id}/submission.json`,JSON.stringify(metadata,null,2),`Record private submission ${id}`);
    } catch (e) {
      try { const uploaded = await getContent(PENDING_REPO,filePath); await deleteFile(PENDING_REPO,filePath,uploaded.sha,`Remove incomplete submission ${id}`); } catch (_) {}
      throw e;
    }
    res.status(201).json({ok:true, id, message:'Submission is private and awaiting review.'});
  } catch (e) { console.error('submission error:',e.message); res.status(e.status || 502).json({error:'Could not save the submission privately. Please try again later.'}); }
});

// Public listing only reads from the public repository, never the pending repository.
app.get('/api/files', async (req,res) => {
  try {
    if (!OWNER || !TOKEN) return res.status(503).json({error:'File listing is not configured.'});
    const requested = String(req.query.path || '');
    if (requested && !validDestination(requested)) return res.status(400).json({error:'Invalid folder path.'});
    const entries = await tree(PUBLIC_REPO);
    const files = entries.filter(x => x.type === 'blob' && (!requested || x.path.startsWith(requested.replace(/\/$/,'') + '/')) && !x.path.startsWith('.github/'))
      .filter(x => !x.path.endsWith('/.gitkeep'))
      .map(x => ({id:x.path, name:x.path.split('/').pop(), destination:x.path.split('/').slice(0,-1).join('/'), size:x.size, downloadUrl:`https://raw.githubusercontent.com/${encodeURIComponent(OWNER)}/${encodeURIComponent(PUBLIC_REPO)}/${encodeURIComponent(BRANCH)}/${x.path.split('/').map(encodeURIComponent).join('/')}`}));
    res.json({files});
  } catch (e) { console.error('list error:',e.message); res.status(502).json({error:'Could not load public files.'}); }
});
app.get('/api/files/:id/preview', async (req,res) => {
  try {
    const path = decodeURIComponent(req.params.id);
    if (!isSafeRepoPath(path)) return res.status(400).json({error:'Invalid file path.'});
    const entries = await tree(PUBLIC_REPO); const entry = entries.find(x => x.type === 'blob' && x.path === path);
    if (!entry) return res.status(404).json({error:'File not found.'});
    const raw = `https://raw.githubusercontent.com/${encodeURIComponent(OWNER)}/${encodeURIComponent(PUBLIC_REPO)}/${encodeURIComponent(BRANCH)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    res.redirect(302,raw);
  } catch (e) { res.status(502).json({error:'Could not retrieve this file.'}); }
});

app.get('/api/files/:id/download', async (req,res) => {
  try {
    const path = decodeURIComponent(req.params.id);
    if (!isSafeRepoPath(path)) return res.status(400).json({error:'Invalid file path.'});
    const entries = await tree(PUBLIC_REPO); const entry = entries.find(x => x.type === 'blob' && x.path === path);
    if (!entry) return res.status(404).json({error:'File not found.'});
    const raw = `https://raw.githubusercontent.com/${encodeURIComponent(OWNER)}/${encodeURIComponent(PUBLIC_REPO)}/${encodeURIComponent(BRANCH)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    res.redirect(302,raw);
  } catch (e) { res.status(502).json({error:'Could not retrieve this file.'}); }
});

app.get('/api/admin/submissions', requireAdmin, async (_req,res) => {
  try {
    const entries = await tree(PENDING_REPO);
    const metadataPaths = entries.filter(x => x.type === 'blob' && /^pending\/[^/]+\/submission\.json$/.test(x.path));
    const records = [];
    for (const item of metadataPaths) {
      try { const content = await getContent(PENDING_REPO,item.path); const parsed = JSON.parse(Buffer.from(content.content.replace(/\n/g,''),'base64').toString('utf8')); records.push(parsed); } catch (e) { console.error('metadata read error:',item.path,e.message); }
    }
    records.sort((a,b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    res.json({submissions:records});
  } catch (e) { console.error('admin list error:',e.message); res.status(502).json({error:'Could not load pending submissions. Check the private repository and token permissions.'}); }
});
app.post('/api/admin/submissions/:id/approve', requireAdmin, async (req,res) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({error:'Invalid submission ID.'});
    const metaPath = `pending/${id}/submission.json`;
    const metaContent = await getContent(PENDING_REPO,metaPath);
    const meta = JSON.parse(Buffer.from(metaContent.content.replace(/\n/g,''),'base64').toString('utf8'));
    if (meta.id !== id || !isSafeRepoPath(meta.storedPath) || !validDestination(meta.destination)) return res.status(400).json({error:'Submission metadata is invalid.'});
    const source = await getContent(PENDING_REPO,meta.storedPath);
    const filename = safeName(meta.originalName);
    let targetPath = `${meta.destination}/${filename}`;
    // Avoid silently overwriting a file already in the public archive.
    try { await getContent(PUBLIC_REPO,targetPath); targetPath = `${meta.destination}/${id.slice(0,8)}-${filename}`; } catch (e) { if (e.status !== 404) throw e; }
    const bytes = await getFileBytes(PENDING_REPO,source);
    await putFile(PUBLIC_REPO,targetPath,bytes,`Approve 10BArchive submission ${id}`);
    // Publication succeeded. Then remove the pending copy and metadata.
    await deleteFile(PENDING_REPO,meta.storedPath,source.sha,`Remove approved submission ${id}`);
    await deleteFile(PENDING_REPO,metaPath,metaContent.sha,`Close approved submission ${id}`);
    res.json({ok:true,publishedPath:targetPath});
  } catch (e) { console.error('approve error:',e.message); res.status(e.status || 502).json({error:'Approval did not complete. Check repository permissions and try again.'}); }
});
app.post('/api/admin/submissions/:id/reject', requireAdmin, async (req,res) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({error:'Invalid submission ID.'});
    const metaPath = `pending/${id}/submission.json`;
    const metaContent = await getContent(PENDING_REPO,metaPath);
    const meta = JSON.parse(Buffer.from(metaContent.content.replace(/\n/g,''),'base64').toString('utf8'));
    const fileContent = await getContent(PENDING_REPO,meta.storedPath);
    await deleteFile(PENDING_REPO,meta.storedPath,fileContent.sha,`Reject submission ${id}`);
    await deleteFile(PENDING_REPO,metaPath,metaContent.sha,`Reject submission record ${id}`);
    res.json({ok:true});
  } catch (e) { console.error('reject error:',e.message); res.status(e.status || 502).json({error:'Could not reject this submission.'}); }
});

app.get('/admin', (_req,res) => res.type('html').sendFile(require('path').join(__dirname,'admin.html')));
app.use((err,req,res,next) => {
  if (err instanceof multer.MulterError) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({error:err.code === 'LIMIT_FILE_SIZE' ? `Files must be ${MAX_MB} MB or smaller.` : 'Upload was rejected.'});
  if (err) { console.error('request error:',err.message); return res.status(400).json({error:'Request could not be processed.'}); }
  next();
});
app.listen(PORT, () => console.log(`10BArchive backend listening on ${PORT}`));
