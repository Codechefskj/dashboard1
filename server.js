/**
 * Design Studio (voice dashboard)
 *
 * Does what the WhatsApp bot does, but the merchant talks to the browser instead of WhatsApp:
 *
 *   browser speech -> transcript -> POST  {AGENTIC}/api/integrations/whatsapp/messages
 *   Agentic asks a question  -> shown in the chat (answer it by voice or tap an option)
 *   Agentic preview handoff  -> POST /integrations/agentic/previews (this server)  -> shown for review
 *   Approve / Request changes
 *                            -> POST  {AGENTIC}/api/integrations/whatsapp/jobs/:id/feedback
 *                               (APPROVE_ALL | EDIT_SELECTED), same as the bot
 *
 * Secrets stay on this server; the browser only talks to /api/*.
 */
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { randomUUID, timingSafeEqual } = require('crypto');

/* ------------------------------------------------------------------ config */
const cfg = {
  port: Number(process.env.PORT || 3002),
  agenticUrl: (process.env.AGENTIC_API_URL || '').replace(/\/$/, ''),
  serviceToken: process.env.INTERNAL_SERVICE_TOKEN || '',
  dashboardToken: process.env.DASHBOARD_TOKEN || '',
  merchantId: process.env.DASHBOARD_MERCHANT_ID || 'dashboard',
  timeoutMs: Number(process.env.AGENTIC_REQUEST_TIMEOUT_MS || 120000),
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: String(process.env.DATABASE_SSL || 'true').toLowerCase() !== 'false',
};
if (!cfg.agenticUrl || !cfg.serviceToken) {
  console.error('❌ Set AGENTIC_API_URL and INTERNAL_SERVICE_TOKEN in .env (copy .env.example).');
  process.exit(1);
}

/* ------------------------------------------------------------------- state */
const MEDIA_DIR = path.join(cfg.dataDir, 'media');
const STATE_FILE = path.join(cfg.dataDir, 'state.json');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const blank = () => ({
  seq: 1, dseq: 1, messages: [], designs: [], jobs: [], media: {},
  session: { status: 'COLLECTING', productDraftId: null, pendingQuestionId: null, designJobId: null, voicePendingAction: null },
});
let state = blank();
try { state = { ...blank(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
const pool = cfg.databaseUrl ? new Pool({ connectionString: cfg.databaseUrl, ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : false }) : null;

function normalizeLoadedState(value) {
  state = { ...blank(), ...(value || {}) };
  state.session = { ...blank().session, ...(state.session || {}) };
  state.dseq = Math.max(state.dseq || 1, ...state.designs.map(d => d.id + 1), 1);
  state.jobs.forEach(j => { if (['PENDING', 'PROCESSING', 'RETRY'].includes(j.status)) { j.status = 'FAILED'; j.lastError = 'Server restarted before this finished. Send it again.'; } });
}

async function initPersistence() {
  if (!pool) return normalizeLoadedState(state);
  await pool.query('CREATE TABLE IF NOT EXISTS dashboard_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS dashboard_media (id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, filename TEXT NOT NULL, bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const result = await pool.query("SELECT payload FROM dashboard_state WHERE id = 'main'");
  normalizeLoadedState(result.rows[0]?.payload || state);
  console.log(JSON.stringify({ event: 'dashboard.persistence.ready', provider: 'postgres' }));
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (pool) {
        await pool.query("INSERT INTO dashboard_state (id, payload, updated_at) VALUES ('main', $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()", [JSON.stringify(state)]);
      } else {
        fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
        fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
      }
    } catch (e) { console.error('⚠️ Could not save state:', e.message); }
  }, 200);
}
const nid = () => state.seq++;
const now = () => new Date().toISOString();
const logEvent = (event, details = {}) => console.log(JSON.stringify({ event, at: now(), ...details }));

function addMessage(role, text, extra = {}) {
  const m = { id: nid(), role, text, createdAt: now(), ...extra };
  state.messages.push(m);
  if (state.messages.length > 500) state.messages.splice(0, state.messages.length - 500);
  save();
  return m;
}
async function saveMedia(buffer, mimeType, filename) {
  const id = String(nid());
  if (pool) await pool.query('INSERT INTO dashboard_media (id, mime_type, filename, bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [id, mimeType, filename, buffer]);
  else fs.writeFileSync(path.join(MEDIA_DIR, id), buffer);
  state.media[id] = { mimeType, filename };
  save();
  return id;
}
async function readMedia(id) {
  const meta = state.media[id];
  if (!meta) throw Object.assign(new Error('Media not found'), { status: 404 });
  if (pool) {
    const result = await pool.query('SELECT bytes FROM dashboard_media WHERE id = $1', [String(id)]);
    if (!result.rows[0]) throw Object.assign(new Error('Media not found'), { status: 404 });
    return { buffer: result.rows[0].bytes, ...meta };
  }
  return { buffer: fs.readFileSync(path.join(MEDIA_DIR, String(id))), ...meta };
}

/* --------------------------------------------------------- Agentic client */
// Same two calls as src/services/agentic.service.ts in the WhatsApp bot.
const authHeader = { Authorization: `Bearer ${cfg.serviceToken}` };

async function agenticProcessMessage({ messageId, text, productDraftId, questionId, file, targetChannels }) {
  const form = new FormData();
  form.append('metadata', JSON.stringify({
    merchantId: cfg.merchantId,
    conversationId: `dashboard:${cfg.merchantId}`,
    sourceChannel: 'dashboard',
    targetChannels: Array.isArray(targetChannels) ? targetChannels : ['instagram', 'facebook'],
    messageId,
    productDraftId: productDraftId || undefined,
    questionId: questionId || undefined,
    mediaRoles: file ? { media: 'PRIMARY_PRODUCT' } : undefined,
  }));
  if (text) form.append('text', text);
  if (file) form.append('media', file.buffer, { filename: file.filename, contentType: file.mimeType });
  const res = await axios.post(`${cfg.agenticUrl}/api/integrations/dashboard/messages`, form, {
    headers: { ...authHeader, ...form.getHeaders(), 'idempotency-key': messageId },
    timeout: cfg.timeoutMs,
    maxBodyLength: 20 * 1024 * 1024,
  });
  return res.data;
}

async function agenticFeedback({ externalRef, action, feedback, messageId }) {
  const res = await axios.post(
    `${cfg.agenticUrl}/api/integrations/dashboard/jobs/${encodeURIComponent(externalRef)}/feedback`,
    { action, feedback, messageId },
    { headers: { ...authHeader, 'Content-Type': 'application/json', 'idempotency-key': messageId }, timeout: cfg.timeoutMs },
  );
  return res.data;
}

/* -------------------------------------------------- durable-ish job queue */
// One job at a time, retried with backoff — mirrors integration-worker.ts.
const queue = [];
let pumping = false;
const MAX_ATTEMPTS = 6;

function addJob(meta, run) {
  const job = { id: nid(), status: 'PENDING', attempts: 0, lastError: null, createdAt: now(), updatedAt: now(), ...meta };
  state.jobs.unshift(job);
  if (state.jobs.length > 120) state.jobs.length = 120;
  queue.push({ job, run, after: 0 });
  save();
  pump();
  return job;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const i = queue.findIndex(q => q.after <= Date.now());
      if (i < 0) { setTimeout(pump, 500); break; }
      const item = queue.splice(i, 1)[0];
      await runItem(item);
    }
  } finally { pumping = false; }
}

async function runItem(item) {
  const { job } = item;
  job.status = 'PROCESSING'; job.attempts += 1; job.lastError = null; job.updatedAt = now();
  logEvent('dashboard.job.processing', { jobId: job.id, kind: job.kind, action: job.action || null, attempt: job.attempts });
  try {
    await item.run(job);
    job.status = 'COMPLETED';
    logEvent('dashboard.job.completed', { jobId: job.id, kind: job.kind, action: job.action || null, attempts: job.attempts });
  } catch (e) {
    const code = e.response?.status;
    const permanent = code && code >= 400 && code < 500 && ![408, 425, 429].includes(code);
    job.lastError = String(e.response?.data?.error || e.response?.data?.message || e.message || e).slice(0, 600);
    if (permanent || job.attempts >= MAX_ATTEMPTS) {
      job.status = 'FAILED';
      addMessage('agent', 'I could not finish that automatically. Check the error in the status bar, then send it again.', { error: true });
      onJobFailed(job);
    } else {
      job.status = 'RETRY';
      item.after = Date.now() + Math.min(30_000, 2 ** job.attempts * 1000);
      queue.push(item);
    }
    console.error(`❌ job ${job.id} (${job.kind}${job.action ? '/' + job.action : ''}) ${job.status}:`, job.lastError);
    logEvent('dashboard.job.failed', { jobId: job.id, kind: job.kind, action: job.action || null, status: job.status, attempt: job.attempts, error: job.lastError });
  }
  job.updatedAt = now();
  save();
}

// A failed approval/edit puts the design back so the user can try again.
function onJobFailed(job) {
  const d = state.designs.find(x => x.id === job.designId);
  if (!d) return;
  if (job.action === 'APPROVE_ALL' && d.status === 'APPROVED') { d.status = 'PENDING'; d.respondedAt = null; }
  if (job.action === 'EDIT_SELECTED' && d.status === 'REJECTED') { d.status = 'PENDING'; d.respondedAt = null; }
}

/* -------------------------------------------- conversation (== bot worker) */
async function processInbound(p) {
  const s = state.session;
  const file = p.mediaId ? await readMedia(p.mediaId) : undefined;

    const clarifying = s.status === 'AWAITING_CLARIFICATION';
  const r = await agenticProcessMessage({
    messageId: p.messageId, text: p.text,
    productDraftId: clarifying ? s.productDraftId : null,
    questionId: clarifying ? s.pendingQuestionId : null,
    file, targetChannels: p.targetChannels,
  });

  if (r.kind === 'clarification_required' && r.draft && r.question) {
    s.productDraftId = r.draft.id; s.pendingQuestionId = r.question.id; s.status = 'AWAITING_CLARIFICATION';
    addMessage('agent', r.question.prompt, { options: r.question.options || [] });
  } else if (r.kind === 'design_ready' && r.job) {
    s.productDraftId = r.draft?.id || s.productDraftId; s.pendingQuestionId = null;
    s.designJobId = r.job.id; s.status = 'AWAITING_APPROVAL';
    addMessage('agent', 'Got it. Designing now, the preview will show up on the right in a moment.');
  } else {
    console.log('ℹ️ Agentic replied with:', JSON.stringify(r).slice(0, 300));
  }
}

async function sendUserMessage({ text, file, targetChannels }) {
  text = (text || '').trim();
  if (!text && !file) throw Object.assign(new Error('Say or type something, or attach a product photo.'), { status: 400 });
  const messageId = `dash:${randomUUID()}`;
  const mediaId = file ? await saveMedia(file.buffer, file.mimeType, file.filename) : null;
  const m = addMessage('user', text, { image: mediaId });
  addJob({ kind: 'INBOUND_MESSAGE', label: 'Thinking' }, () =>
    processInbound({ messageId, text, mediaId, targetChannels }));
  return m;
}

/* ----------------------------------------------------- design actions */
function getDesign(id) {
  const d = state.designs.find(x => x.id === Number(id));
  if (!d) throw Object.assign(new Error('Design not found'), { status: 404 });
  return d;
}
const conflict = msg => Object.assign(new Error(msg), { status: 409 });

function approve(id) {
  const d = getDesign(id);
  if (d.status !== 'PENDING') throw conflict('This design was already answered.');
  d.status = 'APPROVED'; d.respondedAt = now();
  addMessage('agent', '✅ Approval received. Final exports and publishing are now being prepared.');
  const messageId = `dash-approve:${d.id}:${randomUUID()}`;
  addJob({ kind: 'AGENTIC_FEEDBACK', action: 'APPROVE_ALL', designId: d.id, label: 'Publishing' }, async () => {
    const r = await agenticFeedback({ externalRef: d.externalRef, action: 'APPROVE_ALL', messageId });
    state.session.designJobId = d.externalRef;
    state.session.status = r.kind === 'approved' ? 'COMPLETE' : 'AWAITING_APPROVAL';
    d.publishResult = r;
    if (r.kind === 'approved') {
      const publishing = [...(r.job?.handoffs || [])].reverse().find(item => item.type === 'PUBLISHING');
      const deliveries = publishing?.deliveries || [];
      const delivered = deliveries.filter(item => item.status === 'DELIVERED').map(item => item.channel);
      const failed = deliveries.filter(item => item.status === 'FAILED').map(item => item.channel);
      const detail = delivered.length ? ` Published successfully to ${delivered.join(' and ')}.` : ' The image was approved and exported.';
      const failure = failed.length ? ` Publishing failed for ${failed.join(' and ')}; check the status details.` : '';
      addMessage('agent', `🎉 Approved.${detail}${failure}`);
    }
  });
  save();
}

function requestChanges(id, feedback) {
  const d = getDesign(id);
  feedback = (feedback || '').trim();
  if (!feedback) throw Object.assign(new Error('Tell the agent what to change first.'), { status: 400 });
  if (d.status !== 'PENDING') throw conflict('This design was already answered.');
  d.status = 'REJECTED'; d.feedback = feedback; d.respondedAt = now();
  addMessage('user', feedback, { note: `Changes for #${d.id}` });
  addMessage('agent', '📝 Thanks for the feedback! Working on a new version now.');
  const messageId = `dash-edit:${d.id}:${randomUUID()}`;
  addJob({ kind: 'AGENTIC_FEEDBACK', action: 'EDIT_SELECTED', designId: d.id, label: 'Revising' }, async () => {
    const r = await agenticFeedback({ externalRef: d.externalRef, action: 'EDIT_SELECTED', feedback, messageId });
    state.session.designJobId = d.externalRef;
    state.session.status = 'AWAITING_APPROVAL';
  });
  save();
}

function resetSession() {
  state.session = { status: 'COLLECTING', productDraftId: null, pendingQuestionId: null, designJobId: null, voicePendingAction: null };
  addMessage('system', 'New brief');
}

async function handleVoiceCommand({ text, file, targetChannels }) {
  text = String(text || '').trim();
  const pending = state.designs.find(item => item.status === 'PENDING');
  const session = state.session;
  if (session.status === 'AWAITING_APPROVAL' && pending) {
    if (/^(cancel|stop|do not publish|don't publish)$/i.test(text)) {
      session.voicePendingAction = null;
      addMessage('agent', 'Publishing confirmation cancelled. You can request changes or approve when ready.');
      save();
      return { kind: 'cancelled' };
    }
    if (session.voicePendingAction?.type === 'APPROVE_ALL' && /^(confirm|confirm publish|yes confirm|publish now)$/i.test(text)) {
      session.voicePendingAction = null;
      approve(pending.id);
      save();
      return { kind: 'approval_started', designId: pending.id };
    }
    if (/^(approve|approve it|approve and publish|publish|looks good|yes approve)(\s+it)?$/i.test(text)) {
      session.voicePendingAction = { type: 'APPROVE_ALL', designId: pending.id, createdAt: now() };
      addMessage('agent', 'Please say “confirm publish” to approve this design and publish it, or say “cancel”.');
      save();
      return { kind: 'confirmation_required', designId: pending.id };
    }
    const feedback = text.replace(/^(change|edit|revise|please change|please edit)\s*/i, '').trim();
    if (feedback) {
      session.voicePendingAction = null;
      requestChanges(pending.id, feedback);
      return { kind: 'revision_started', designId: pending.id };
    }
  }
  return { kind: 'message_started', message: await sendUserMessage({ text, file, targetChannels }) };
}

/* ------------------------------------------------------------------ server */
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/* --- preview handoff from Agentic (same contract as the WhatsApp bot) --- */
const handlePreview = async (req, res) => {
  if (!safeEq(req.header('authorization') || '', `Bearer ${cfg.serviceToken}`)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const meta = JSON.parse(String(req.body.metadata || '{}'));
    if (meta.event !== 'design.preview_ready') {
      return res.status(400).json({ error: 'Only image design previews are accepted by this endpoint.' });
    }
    if (String(meta.merchantId || '') !== cfg.merchantId) {
      return res.status(404).json({ error: `merchantId "${meta.merchantId}" is not this dashboard (expected "${cfg.merchantId}").` });
    }
    const part = meta.designs?.[0]?.filePart || 'preview_1';
    const file = (req.files || []).find(f => f.fieldname === part);
    if (!meta.designJobId || !file) return res.status(400).json({ error: 'metadata.designJobId and preview_1 are required.' });
    if (!['image/png', 'image/jpeg'].includes(file.mimetype)) return res.status(400).json({ error: 'Preview must be PNG or JPEG.' });

    const handoffKey = req.header('idempotency-key') || `preview:${meta.designJobId}:${meta.revisionId}`;
    let design = state.designs.find(d => d.handoffKey === handoffKey);
    if (!design) {
      design = {
        id: state.dseq++, handoffKey, externalRef: meta.designJobId, status: 'PENDING',
        mimeType: file.mimetype, mediaId: await saveMedia(file.buffer, file.mimetype, file.originalname || 'preview'),
        revision: meta.revisionNumber || 1, feedback: null, createdAt: now(), respondedAt: null,
        caption: meta.revisionNumber > 1
          ? `Your revised design (version ${meta.revisionNumber}) is ready. Do you approve it?`
          : 'Your design is ready. Do you approve it?',
      };
      state.designs.unshift(design);
      state.session.designJobId = meta.designJobId;
      state.session.status = 'AWAITING_APPROVAL';
      save();
      logEvent('dashboard.preview.received', { designJobId: meta.designJobId, revision: meta.revisionNumber || 1, bytes: file.size });
    }
    res.json({ success: true, designId: design.id, status: design.status, handoffKey });
  } catch (e) {
    console.error('❌ Preview handoff error:', e.message);
    res.status(400).json({ error: e.message });
  }
};
app.post('/integrations/agentic/previews', upload.any(), handlePreview);

app.use(express.json());

/* --- dashboard API --- */
const api = express.Router();
api.get('/config', (_req, res) => res.json({ authRequired: !!cfg.dashboardToken, merchantId: cfg.merchantId }));
api.use((req, res, next) => {
  if (!cfg.dashboardToken) return next();
  if (safeEq(req.header('x-dashboard-token') || req.query.token || '', cfg.dashboardToken)) return next();
  res.status(401).json({ error: 'Unauthorized' });
});
const wrap = fn => (req, res) => {
  Promise.resolve().then(() => fn(req, res)).catch(e => {
    console.error('❌', e.message);
    res.status(e.status || 400).json({ error: e.message || 'Something went wrong' });
  });
};

api.get('/state', (_req, res) => {
  res.json({
    merchantId: cfg.merchantId,
    session: state.session,
    messages: state.messages.slice(-200),
    designs: state.designs.slice(0, 60).map(({ publishResult, handoffKey, ...d }) => d),
    jobs: state.jobs.slice(0, 40),
  });
});
api.post('/messages', upload.single('image'), wrap(async (req, res) => {
  const f = req.file;
  if (f && !['image/png', 'image/jpeg', 'image/webp'].includes(f.mimetype)) throw new Error('Product photo must be PNG, JPEG or WebP.');
  const targetChannels = JSON.parse(req.body.targetChannels || '["instagram","facebook"]');
  const m = await sendUserMessage({ text: req.body.text, targetChannels, file: f && { buffer: f.buffer, mimeType: f.mimetype, filename: f.originalname || 'product.jpg' } });
  logEvent('dashboard.message.accepted', { messageId: m.id, hasImage: !!f, targetChannels });
  res.json({ success: true, id: m.id });
}));
api.post('/voice-command', upload.single('image'), wrap(async (req, res) => {
  const f = req.file;
  if (f && !['image/png', 'image/jpeg', 'image/webp'].includes(f.mimetype)) throw new Error('Product photo must be PNG, JPEG or WebP.');
  const targetChannels = JSON.parse(req.body.targetChannels || '["instagram","facebook"]');
  logEvent('dashboard.voice.transcript', { textLength: String(req.body.text || '').length, hasImage: !!f, targetChannels });
  const result = await handleVoiceCommand({ text: req.body.text, targetChannels, file: f && { buffer: f.buffer, mimeType: f.mimetype, filename: f.originalname || 'product.jpg' } });
  res.json({ success: true, ...result });
}));
api.post('/designs/:id/approve', wrap((req, res) => { approve(req.params.id); res.json({ success: true }); }));
api.post('/designs/:id/changes', wrap((req, res) => { requestChanges(req.params.id, req.body?.feedback); res.json({ success: true }); }));
api.post('/reset', wrap((_req, res) => { resetSession(); res.json({ success: true }); }));
api.get('/media/:id', wrap(async (req, res) => {
  const mediaFile = await readMedia(req.params.id);
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="${String(mediaFile.filename).replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(mediaFile.mimeType);
  res.send(mediaFile.buffer);
}));
app.use('/api', api);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.send('OK'));

// With no DASHBOARD_TOKEN the server only listens on this computer.
const host = cfg.dashboardToken ? '0.0.0.0' : '127.0.0.1';
async function start() {
  await initPersistence();
  app.listen(cfg.port, host, () => {
    console.log(`🎙️  Design Studio running:  http://localhost:${cfg.port}`);
    console.log(`🔗 Agentic: ${cfg.agenticUrl}   merchantId: "${cfg.merchantId}"`);
    console.log(`📥 Agentic dashboard handoff: <this server's public URL>/integrations/agentic/previews`);
    console.log(`💾 Persistence: ${pool ? 'PostgreSQL' : cfg.dataDir}`);
    if (!cfg.dashboardToken) console.log('🔒 No DASHBOARD_TOKEN set: listening on 127.0.0.1 only.');
  });
}
start().catch(error => { console.error('❌ Dashboard startup failed:', error); process.exit(1); });
