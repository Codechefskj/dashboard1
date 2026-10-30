/**
 * Design Studio (voice dashboard)
 *
 * Does what the WhatsApp bot does, but the merchant talks to the browser instead of WhatsApp:
 *
 *   browser speech -> transcript -> POST  {AGENTIC}/api/integrations/dashboard/messages
 *   Agentic asks a question  -> shown in the chat (answer it by voice or tap an option)
 *   Agentic preview handoff  -> POST /integrations/agentic/previews (this server)  -> shown for review
 *   Approve / Request changes
 *                            -> POST  {AGENTIC}/api/integrations/dashboard/jobs/:id/feedback
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
  seedInventoryOnEmpty: String(process.env.SEED_INVENTORY_ON_EMPTY || 'true').toLowerCase() === 'true',
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
  inventory: {
    products: [], batches: [], movements: [], campaigns: [],
    rules: {
      scanDays: 45, smallDiscountDays: 30, strongDiscountDays: 14, urgentDays: 6,
      smallDiscountPercent: 10, strongDiscountPercent: 20, urgentDiscountPercent: 25,
      minimumStock: 1, requireApproval: true,
    },
    lastScanAt: null,
  },
});
let state = blank();
try { state = { ...blank(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch { /* first run */ }
let pool = cfg.databaseUrl ? new Pool({ connectionString: cfg.databaseUrl, ssl: cfg.databaseSsl ? { rejectUnauthorized: false } : false }) : null;

function normalizeLoadedState(value) {
  state = { ...blank(), ...(value || {}) };
  state.session = { ...blank().session, ...(state.session || {}) };
  state.inventory = { ...blank().inventory, ...(state.inventory || {}) };
  state.inventory.rules = { ...blank().inventory.rules, ...(state.inventory.rules || {}) };
  for (const key of ['products', 'batches', 'movements', 'campaigns']) {
    if (!Array.isArray(state.inventory[key])) state.inventory[key] = [];
  }
  state.dseq = Math.max(state.dseq || 1, ...state.designs.map(d => d.id + 1), 1);
  state.jobs.forEach(j => { if (['PENDING', 'PROCESSING', 'RETRY'].includes(j.status)) { j.status = 'FAILED'; j.lastError = 'Server restarted before this finished. Send it again.'; } });
}

async function initPersistence() {
  if (!pool) {
    normalizeLoadedState(state);
    console.log(JSON.stringify({ event: 'dashboard.persistence.ready', provider: 'filesystem', dataDir: cfg.dataDir }));
    return;
  }
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS dashboard_state (id TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pool.query('CREATE TABLE IF NOT EXISTS dashboard_media (id TEXT PRIMARY KEY, mime_type TEXT NOT NULL, filename TEXT NOT NULL, bytes BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const result = await pool.query("SELECT payload FROM dashboard_state WHERE id = 'main'");
    normalizeLoadedState(result.rows[0]?.payload || state);
    console.log(JSON.stringify({ event: 'dashboard.persistence.ready', provider: 'postgres' }));
  } catch (error) {
    const failedPool = pool;
    pool = null;
    await failedPool.end().catch(() => {});
    normalizeLoadedState(state);
    console.warn(JSON.stringify({
      event: 'dashboard.persistence.fallback',
      provider: 'filesystem',
      reason: error.code || error.message,
      message: 'PostgreSQL is unavailable; dashboard will run with temporary filesystem storage.',
      dataDir: cfg.dataDir,
    }));
  }
}

let saveTimer = null;
async function persistState() {
  if (pool) {
    await pool.query("INSERT INTO dashboard_state (id, payload, updated_at) VALUES ('main', $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()", [JSON.stringify(state)]);
  } else {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistState().catch(e => console.error('⚠️ Could not save state:', e.message)), 200);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await persistState();
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

async function agenticProcessMessage({ messageId, text, productDraftId, questionId, file, targetChannels, conversationId, briefMetadata = {} }) {
  const form = new FormData();
  form.append('metadata', JSON.stringify({
    ...briefMetadata,
    merchantId: cfg.merchantId,
    conversationId: conversationId || `dashboard:${cfg.merchantId}`,
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
  const campaign = job.campaignId ? state.inventory.campaigns.find(item => item.id === job.campaignId) : null;
  if (campaign) {
    campaign.status = job.kind === 'INVENTORY_CAMPAIGN' ? 'FAILED' : 'READY';
    campaign.error = job.lastError;
    campaign.updatedAt = now();
  }
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
  const campaign = d.campaignId ? state.inventory.campaigns.find(item => item.id === d.campaignId) : null;
  if (d.status !== 'PENDING') throw conflict('This design was already answered.');
  d.status = 'APPROVED'; d.respondedAt = now();
  if (!campaign) addMessage('agent', '✅ Approval received. Final exports and publishing are now being prepared.');
  const messageId = `dash-approve:${d.id}:${randomUUID()}`;
  addJob({ kind: 'AGENTIC_FEEDBACK', action: 'APPROVE_ALL', designId: d.id, campaignId: d.campaignId || null, label: 'Publishing' }, async () => {
    const r = await agenticFeedback({ externalRef: d.externalRef, action: 'APPROVE_ALL', messageId });
    if (!campaign) {
      state.session.designJobId = d.externalRef;
      state.session.status = r.kind === 'approved' ? 'COMPLETE' : 'AWAITING_APPROVAL';
    }
    d.publishResult = r;
    if (r.kind === 'approved') {
      const publishing = [...(r.job?.handoffs || [])].reverse().find(item => item.type === 'PUBLISHING');
      const deliveries = publishing?.deliveries || [];
      const delivered = deliveries.filter(item => item.status === 'DELIVERED').map(item => item.channel);
      const failed = deliveries.filter(item => item.status === 'FAILED').map(item => item.channel);
      const detail = delivered.length ? ` Published successfully to ${delivered.join(' and ')}.` : ' The image was approved and exported.';
      const failure = failed.length ? ` Publishing failed for ${failed.join(' and ')}; check the status details.` : '';
      if (!campaign) addMessage('agent', `🎉 Approved.${detail}${failure}`);
      if (campaign) {
        campaign.status = failed.length && !delivered.length ? 'FAILED' : 'PUBLISHED';
        campaign.publishResult = { delivered, failed, at: now() };
        campaign.updatedAt = now();
      }
    } else if (campaign) {
      campaign.status = 'READY';
      campaign.error = 'The design service did not confirm approval.';
      campaign.updatedAt = now();
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
  // Inventory campaigns have their own approval screen and safety checks. Never let
  // the general voice flow approve or revise one by accidentally finding it here.
  const pending = state.designs.find(item => item.status === 'PENDING' && !item.campaignId);
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

/* ---------------------------------------------------------- inventory */
const cleanText = (value, max = 200) => String(value ?? '').trim().slice(0, max);
const finiteNumber = (value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) => {
  if (optional && (value === '' || value == null)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw Object.assign(new Error(`${label} must be between ${min} and ${max}.`), { status: 400 });
  }
  return number;
};
const dateOnly = value => {
  const result = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T00:00:00Z`))) {
    throw Object.assign(new Error('Expiry date must be a valid YYYY-MM-DD date.'), { status: 400 });
  }
  return result;
};
function indiaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dayNumber(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}
const daysUntil = value => dayNumber(value) - dayNumber(indiaToday());
function shiftDate(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
const inventoryId = prefix => `${prefix}_${randomUUID()}`;
const getProduct = id => {
  const product = state.inventory.products.find(item => item.id === id);
  if (!product) throw Object.assign(new Error('Product not found.'), { status: 404 });
  return product;
};
const getBatch = id => {
  const batch = state.inventory.batches.find(item => item.id === id);
  if (!batch) throw Object.assign(new Error('Inventory batch not found.'), { status: 404 });
  return batch;
};
const getCampaign = id => {
  const campaign = state.inventory.campaigns.find(item => item.id === id);
  if (!campaign) throw Object.assign(new Error('Campaign not found.'), { status: 404 });
  return campaign;
};
function recommendationFor(batch, product) {
  const days = daysUntil(batch.expiryDate);
  const rules = state.inventory.rules;
  let tier = 'SAFE', discountPercent = 0, priority = 0;
  if (days <= 0) tier = 'EXPIRED';
  else if (days <= rules.urgentDays) { tier = 'URGENT'; discountPercent = rules.urgentDiscountPercent; priority = 100 - days; }
  else if (days <= rules.strongDiscountDays) { tier = 'STRONG'; discountPercent = rules.strongDiscountPercent; priority = 75 - days; }
  else if (days <= rules.smallDiscountDays) { tier = 'SMALL'; discountPercent = rules.smallDiscountPercent; priority = 50 - days; }
  else if (days <= rules.scanDays) { tier = 'MONITOR'; priority = 20 - days / 10; }
  const price = Number(product.price || 0);
  const minimumPrice = Number(product.minimumPrice || 0);
  let promotionalPrice = price ? price * (1 - discountPercent / 100) : 0;
  if (minimumPrice && promotionalPrice < minimumPrice) promotionalPrice = minimumPrice;
  const effectiveDiscountPercent = price ? Math.max(0, Math.round((1 - promotionalPrice / price) * 100)) : discountPercent;
  const blockedReasons = [];
  if (!product.active) blockedReasons.push('Product is inactive');
  if (batch.blocked) blockedReasons.push('Batch is blocked');
  if (batch.recalled) blockedReasons.push('Batch is recalled');
  if (Number(batch.quantity) < Number(rules.minimumStock)) blockedReasons.push('Stock is below the promotion minimum');
  if (days <= 0) blockedReasons.push('Product is expired');
  return {
    daysRemaining: days, tier, priority: Math.round(priority), discountPercent: effectiveDiscountPercent,
    promotionalPrice: Number(promotionalPrice.toFixed(2)), eligible: !blockedReasons.length && days <= rules.scanDays,
    blockedReasons,
  };
}
function publicInventory() {
  const products = state.inventory.products.map(product => {
    const batches = state.inventory.batches.filter(batch => batch.productId === product.id)
      .map(batch => ({ ...batch, recommendation: recommendationFor(batch, product) }))
      .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
    return { ...product, batches, totalQuantity: batches.reduce((sum, batch) => sum + Number(batch.quantity || 0), 0) };
  });
  const candidates = products.flatMap(product => product.batches
    .filter(batch => batch.recommendation.tier !== 'SAFE')
    .map(batch => ({ product, batch })))
    .sort((a, b) => b.batch.recommendation.priority - a.batch.recommendation.priority);
  return {
    products,
    candidates,
    campaigns: state.inventory.campaigns.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(campaign => {
      const design = campaign.designId ? state.designs.find(item => item.id === campaign.designId) : null;
      return { ...campaign, design: design ? { id: design.id, mediaId: design.mediaId, revision: design.revision, status: design.status } : null };
    }),
    rules: state.inventory.rules,
    lastScanAt: state.inventory.lastScanAt,
    summary: {
      products: products.length,
      units: products.reduce((sum, product) => sum + product.totalQuantity, 0),
      expiringSoon: candidates.filter(item => item.batch.recommendation.eligible).length,
      blocked: candidates.filter(item => item.batch.recommendation.blockedReasons.length).length,
      campaigns: state.inventory.campaigns.length,
    },
  };
}
function reconcileCampaignSafety() {
  for (const campaign of state.inventory.campaigns) {
    if (!['GENERATING', 'READY', 'PUBLISHED', 'BLOCKED'].includes(campaign.status)) continue;
    const batch = state.inventory.batches.find(item => item.id === campaign.batchId);
    const product = state.inventory.products.find(item => item.id === campaign.productId);
    if (!batch || !product) { campaign.status = 'BLOCKED'; campaign.error = 'Product or batch no longer exists.'; continue; }
    const check = recommendationFor(batch, product);
    const offerFinished = campaign.offerEndsAt && campaign.offerEndsAt < indiaToday();
    const redemptionFinished = campaign.maxRedemptions && Number(campaign.redemptions || 0) >= campaign.maxRedemptions;
    if (offerFinished || redemptionFinished) {
      campaign.status = 'ENDED';
      campaign.error = offerFinished ? 'Offer end date has passed.' : 'Maximum redemptions reached.';
      campaign.updatedAt = now();
    } else if (!check.eligible) {
      campaign.status = campaign.status === 'PUBLISHED' ? 'ENDED' : 'BLOCKED';
      campaign.error = check.blockedReasons.join('. ');
      campaign.updatedAt = now();
    } else if (campaign.status === 'GENERATING' && campaign.designId) {
      // Recover older/in-flight records where a preview was stored but the
      // campaign status update was interrupted. The merchant must see the
      // approval controls as soon as a safe design exists.
      campaign.status = 'READY';
      campaign.error = null;
      campaign.updatedAt = now();
    } else if (campaign.status === 'BLOCKED' && campaign.designId) {
      campaign.status = 'READY';
      campaign.error = null;
      campaign.updatedAt = now();
    }
  }
}
function recordInventoryScan() {
  reconcileCampaignSafety();
  state.inventory.lastScanAt = now();
  const snapshot = publicInventory();
  save();
  logEvent('inventory.scan.completed', { candidates: snapshot.summary.expiringSoon, blocked: snapshot.summary.blocked });
  return snapshot;
}
function addProduct(input, imageMediaId = null) {
  const name = cleanText(input.name);
  if (!name) throw Object.assign(new Error('Product name is required.'), { status: 400 });
  const sku = cleanText(input.sku, 80);
  if (sku && state.inventory.products.some(item => item.sku.toLowerCase() === sku.toLowerCase())) {
    throw Object.assign(new Error('A product with this SKU already exists.'), { status: 409 });
  }
  const price = finiteNumber(input.price, 'Selling price', { min: 0.01, max: 10000000 });
  const minimumPrice = finiteNumber(input.minimumPrice, 'Minimum price', { min: 0, max: price, optional: true }) || 0;
  const product = {
    id: inventoryId('product'), merchantId: cfg.merchantId, name, sku,
    brand: cleanText(input.brand), category: cleanText(input.category), description: cleanText(input.description, 1000),
    price, costPrice: finiteNumber(input.costPrice, 'Cost price', { min: 0, max: 10000000, optional: true }) || 0,
    minimumPrice, imageMediaId, active: input.active !== false && String(input.active) !== 'false',
    createdAt: now(), updatedAt: now(),
  };
  state.inventory.products.push(product);
  save();
  logEvent('inventory.product.created', { productId: product.id, sku: product.sku, hasImage: !!imageMediaId });
  return product;
}
function addBatch(productId, input) {
  getProduct(productId);
  const batch = {
    id: inventoryId('batch'), productId, batchNumber: cleanText(input.batchNumber, 100) || `BATCH-${Date.now()}`,
    quantity: finiteNumber(input.quantity, 'Quantity', { min: 0, max: 100000000 }),
    expiryDate: dateOnly(input.expiryDate), manufacturingDate: input.manufacturingDate ? dateOnly(input.manufacturingDate) : null,
    supplier: cleanText(input.supplier), location: cleanText(input.location),
    recalled: input.recalled === true || String(input.recalled) === 'true',
    blocked: input.blocked === true || String(input.blocked) === 'true',
    createdAt: now(), updatedAt: now(),
  };
  if (batch.manufacturingDate && batch.manufacturingDate > batch.expiryDate) {
    throw Object.assign(new Error('Manufacturing date cannot be after expiry date.'), { status: 400 });
  }
  state.inventory.batches.push(batch);
  state.inventory.movements.unshift({ id: inventoryId('movement'), productId, batchId: batch.id, type: 'RECEIPT', quantity: batch.quantity, at: now() });
  save();
  logEvent('inventory.batch.created', { productId, batchId: batch.id, quantity: batch.quantity, expiryDate: batch.expiryDate });
  return batch;
}
function parseCsv(text) {
  const rows = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (rows.length < 2) throw Object.assign(new Error('CSV must contain a header and at least one product row.'), { status: 400 });
  const split = line => {
    const values = []; let value = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { values.push(value.trim()); value = ''; }
      else value += char;
    }
    values.push(value.trim()); return values;
  };
  const headers = split(rows.shift()).map(item => item.toLowerCase().replace(/[\s_-]+/g, ''));
  return rows.map(line => Object.fromEntries(split(line).map((value, index) => [headers[index], value])));
}
function importInventoryCsvText(text) {
  const snapshot = JSON.parse(JSON.stringify(state.inventory));
  let imported = 0;
  try {
    for (const row of parseCsv(text)) {
      const product = addProduct({
        name: row.name || row.productname, sku: row.sku || row.barcode, brand: row.brand,
        category: row.category, description: row.description, price: row.price,
        costPrice: row.costprice, minimumPrice: row.minimumprice,
      });
      addBatch(product.id, {
        batchNumber: row.batchnumber, quantity: row.quantity, expiryDate: row.expirydate,
        manufacturingDate: row.manufacturingdate, supplier: row.supplier, location: row.location,
      });
      imported++;
    }
  } catch (error) {
    state.inventory = snapshot;
    throw new Error(`CSV import stopped at row ${imported + 2}: ${error.message}`);
  }
  save();
  return imported;
}
async function seedInventoryIfEmpty() {
  if (!cfg.seedInventoryOnEmpty || state.inventory.products.length) return 0;
  const seedPath = path.join(__dirname, 'public', 'inventory-seed-250.csv');
  if (!fs.existsSync(seedPath)) throw new Error(`Inventory seed file is missing: ${seedPath}`);
  const imported = importInventoryCsvText(fs.readFileSync(seedPath, 'utf8'));
  await flushSave();
  logEvent('inventory.seed.completed', { imported, provider: pool ? 'postgres' : 'filesystem' });
  return imported;
}
const OFFER_TYPES = ['PERCENT_OFF', 'FIXED_PRICE', 'BUY_X_GET_Y', 'MULTIBUY'];
function normalizeOffer(input, product, batch, recommendation) {
  const type = OFFER_TYPES.includes(input.offerType) ? input.offerType : 'PERCENT_OFF';
  const offer = { type };
  let promotionalPrice;
  let discountPercent;
  let stockRequired = 1;

  if (type === 'PERCENT_OFF') {
    const requested = finiteNumber(input.discountPercent ?? recommendation.discountPercent, 'Discount', { min: 1, max: 90 });
    promotionalPrice = product.price * (1 - requested / 100);
    offer.discountPercent = requested;
  } else if (type === 'FIXED_PRICE') {
    promotionalPrice = finiteNumber(input.promotionalPrice, 'Offer price', { min: 0.01, max: product.price });
    offer.promotionalPrice = Number(promotionalPrice.toFixed(2));
  } else if (type === 'BUY_X_GET_Y') {
    offer.buyQuantity = finiteNumber(input.buyQuantity ?? 1, 'Buy quantity', { min: 1, max: 100 });
    offer.freeQuantity = finiteNumber(input.freeQuantity ?? 1, 'Free quantity', { min: 1, max: 100 });
    stockRequired = offer.buyQuantity + offer.freeQuantity;
    promotionalPrice = product.price * offer.buyQuantity / stockRequired;
  } else {
    offer.bundleQuantity = finiteNumber(input.bundleQuantity ?? 2, 'Bundle quantity', { min: 2, max: 100 });
    offer.bundlePrice = finiteNumber(input.bundlePrice, 'Bundle price', { min: 0.01, max: product.price * offer.bundleQuantity });
    stockRequired = offer.bundleQuantity;
    promotionalPrice = offer.bundlePrice / offer.bundleQuantity;
  }

  if (promotionalPrice < Number(product.minimumPrice || 0)) {
    throw Object.assign(new Error(`This offer goes below the minimum promotional price of ₹${Number(product.minimumPrice).toFixed(2)} per unit.`), { status: 409 });
  }
  if (Number(batch.quantity) < stockRequired) {
    throw Object.assign(new Error(`This offer needs at least ${stockRequired} units in stock.`), { status: 409 });
  }
  discountPercent = Math.max(0, Math.round((1 - promotionalPrice / product.price) * 100));
  offer.effectiveUnitPrice = Number(promotionalPrice.toFixed(2));
  offer.discountPercent = discountPercent;
  return { offer, promotionalPrice: offer.effectiveUnitPrice, discountPercent, stockRequired };
}
function offerLabel(campaign) {
  const offer = campaign.offer || { type: 'PERCENT_OFF', discountPercent: campaign.discountPercent };
  if (offer.type === 'FIXED_PRICE') return `Special price ₹${Number(campaign.promotionalPrice).toFixed(2)}`;
  if (offer.type === 'BUY_X_GET_Y') return `Buy ${offer.buyQuantity}, get ${offer.freeQuantity} free`;
  if (offer.type === 'MULTIBUY') return `${offer.bundleQuantity} for ₹${Number(offer.bundlePrice).toFixed(2)}`;
  return `${campaign.discountPercent}% off`;
}
async function createInventoryCampaign(batchId, input = {}) {
  const batch = getBatch(batchId);
  const product = getProduct(batch.productId);
  const recommendation = recommendationFor(batch, product);
  if (!recommendation.eligible) throw Object.assign(new Error(recommendation.blockedReasons.join('. ') || 'This batch is not currently eligible for promotion.'), { status: 409 });
  if (state.inventory.campaigns.some(item => item.batchId === batch.id && ['GENERATING', 'READY', 'PUBLISHING', 'PUBLISHED'].includes(item.status))) {
    throw Object.assign(new Error('This batch already has an active campaign.'), { status: 409 });
  }
  const normalized = normalizeOffer(input, product, batch, recommendation);
  const couponCode = cleanText(input.couponCode, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, '') || `${product.name.replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase()}${normalized.discountPercent}`;
  if (state.inventory.campaigns.some(item => item.couponCode === couponCode && ['GENERATING', 'READY', 'PUBLISHING', 'PUBLISHED'].includes(item.status))) {
    throw Object.assign(new Error('This coupon code is already used by an active campaign.'), { status: 409 });
  }
  const targetChannels = Array.isArray(input.targetChannels) ? input.targetChannels.filter(item => ['instagram', 'facebook'].includes(item)) : ['instagram', 'facebook'];
  const latestEnd = shiftDate(batch.expiryDate, -1);
  const offerStartsAt = input.offerStartsAt ? dateOnly(input.offerStartsAt) : indiaToday();
  const offerEndsAt = input.offerEndsAt ? dateOnly(input.offerEndsAt) : latestEnd;
  if (offerStartsAt > offerEndsAt) throw Object.assign(new Error('Offer start date cannot be after its end date.'), { status: 400 });
  if (offerEndsAt > latestEnd) throw Object.assign(new Error(`Offer must end on or before ${latestEnd}, one day before expiry.`), { status: 409 });
  const maxRedemptions = finiteNumber(input.maxRedemptions, 'Maximum redemptions', { min: 1, max: 100000000, optional: true });
  const campaign = {
    id: inventoryId('campaign'), productId: product.id, batchId: batch.id, status: 'GENERATING',
    offer: normalized.offer, offerLabel: null, discountPercent: normalized.discountPercent, promotionalPrice: normalized.promotionalPrice, couponCode,
    targetChannels, offerStartsAt, offerEndsAt, maxRedemptions, redemptions: 0, unitsSold: 0,
    agenticJobId: null, designId: null, error: null,
    createdAt: now(), updatedAt: now(), approvedAt: null, publishResult: null,
  };
  campaign.offerLabel = offerLabel(campaign);
  state.inventory.campaigns.push(campaign);
  const messageId = `inventory:${campaign.id}`;
  addJob({ kind: 'INVENTORY_CAMPAIGN', campaignId: campaign.id, label: `Designing ${product.name}` }, async () => {
    const file = product.imageMediaId ? await readMedia(product.imageMediaId) : null;
    const text = [
      `Create a retail promotion image for ${product.brand ? product.brand + ' ' : ''}${product.name}.`,
      product.description ? `Product details: ${product.description}.` : '',
      `Offer: ${campaign.offerLabel}. Normal unit price: ₹${product.price.toFixed(2)}. Effective promotional unit price: ₹${campaign.promotionalPrice.toFixed(2)}.`,
      `Coupon code: ${campaign.couponCode}. Offer valid through ${campaign.offerEndsAt}.`,
      `Use customer-friendly urgency such as "Limited stock" and "Offer ends soon". Do not mention the product expiry date or claim the product is expired.`,
      `This is an image advertisement for ${campaign.targetChannels.join(' and ') || 'export only'}.`,
    ].filter(Boolean).join(' ');
    const response = await agenticProcessMessage({
      messageId, text, file, targetChannels: campaign.targetChannels,
      conversationId: `dashboard:${cfg.merchantId}:inventory:${campaign.id}`,
      briefMetadata: {
        productName: product.name, brand: product.brand, category: product.category, sku: product.sku,
        price: campaign.promotionalPrice, creativeDirection: 'clear retail promotion with strong product focus and trustworthy urgency',
        callToAction: `Use coupon ${campaign.couponCode} before ${campaign.offerEndsAt}`,
        features: [campaign.offerLabel, `coupon ${campaign.couponCode}`, `limited stock`],
      },
    });
    if (response.kind === 'design_ready' && response.job) {
      campaign.agenticJobId = response.job.id; campaign.status = 'GENERATING'; campaign.updatedAt = now();
    } else if (response.kind === 'clarification_required') {
      campaign.status = 'NEEDS_ATTENTION'; campaign.error = response.question?.prompt || 'The design agent needs more product information.';
    } else {
      throw new Error('The design service did not start an inventory campaign.');
    }
    save();
  });
  save();
  logEvent('inventory.campaign.started', { campaignId: campaign.id, productId: product.id, batchId, targetChannels });
  return campaign;
}
function assertCampaignPublishable(campaign) {
  const batch = getBatch(campaign.batchId);
  const product = getProduct(campaign.productId);
  const eligibility = recommendationFor(batch, product);
  if (!eligibility.eligible) throw Object.assign(new Error(`Publishing blocked: ${eligibility.blockedReasons.join('. ')}`), { status: 409 });
  const required = campaign.offer?.type === 'BUY_X_GET_Y' ? campaign.offer.buyQuantity + campaign.offer.freeQuantity
    : campaign.offer?.type === 'MULTIBUY' ? campaign.offer.bundleQuantity : 1;
  if (Number(batch.quantity) < required) throw Object.assign(new Error(`Publishing blocked: this offer needs at least ${required} units in stock.`), { status: 409 });
  if (campaign.offerEndsAt < indiaToday()) throw Object.assign(new Error('Publishing blocked: the offer has ended.'), { status: 409 });
  if (campaign.maxRedemptions && campaign.redemptions >= campaign.maxRedemptions) throw Object.assign(new Error('Publishing blocked: the redemption limit was reached.'), { status: 409 });
  if (!campaign.designId) throw Object.assign(new Error('The campaign preview is not ready.'), { status: 409 });
  return getDesign(campaign.designId);
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
      const campaign = state.inventory.campaigns.find(item =>
        item.agenticJobId === meta.designJobId || String(meta.conversationId || '').endsWith(`:inventory:${item.id}`));
      design = {
        id: state.dseq++, handoffKey, externalRef: meta.designJobId, status: 'PENDING',
        mimeType: file.mimetype, mediaId: await saveMedia(file.buffer, file.mimetype, file.originalname || 'preview'),
        revision: meta.revisionNumber || 1, feedback: null, createdAt: now(), respondedAt: null,
        campaignId: campaign?.id || null,
        caption: meta.revisionNumber > 1
          ? `Your revised design (version ${meta.revisionNumber}) is ready. Do you approve it?`
          : 'Your design is ready. Do you approve it?',
      };
      state.designs.unshift(design);
      if (campaign) {
        campaign.agenticJobId = meta.designJobId;
        campaign.designId = design.id;
        const batch = state.inventory.batches.find(item => item.id === campaign.batchId);
        const product = state.inventory.products.find(item => item.id === campaign.productId);
        const check = batch && product ? recommendationFor(batch, product) : { eligible: false, blockedReasons: ['Product or batch no longer exists'] };
        campaign.status = check.eligible ? 'READY' : 'BLOCKED';
        campaign.error = check.eligible ? null : check.blockedReasons.join('. ');
        campaign.updatedAt = now();
      } else {
        state.session.designJobId = meta.designJobId;
        state.session.status = 'AWAITING_APPROVAL';
      }
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
    designs: state.designs.filter(item => !item.campaignId).slice(0, 60).map(({ publishResult, handoffKey, ...d }) => d),
    jobs: state.jobs.slice(0, 40),
  });
});
api.get('/inventory', (_req, res) => { reconcileCampaignSafety(); res.json(publicInventory()); });
api.post('/inventory/products', upload.single('image'), wrap(async (req, res) => {
  const file = req.file;
  if (file && !['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) throw new Error('Product photo must be PNG, JPEG or WebP.');
  const mediaId = file ? await saveMedia(file.buffer, file.mimetype, file.originalname || 'product.jpg') : null;
  const product = addProduct(req.body || {}, mediaId);
  const batch = req.body?.expiryDate ? addBatch(product.id, req.body) : null;
  res.status(201).json({ product, batch });
}));
api.patch('/inventory/products/:id', wrap((req, res) => {
  const product = getProduct(req.params.id);
  const nextPrice = req.body.price != null ? finiteNumber(req.body.price, 'Selling price', { min: 0.01, max: 10000000 }) : product.price;
  const nextMinimumPrice = req.body.minimumPrice != null ? finiteNumber(req.body.minimumPrice, 'Minimum price', { min: 0, max: nextPrice }) : product.minimumPrice;
  if (nextMinimumPrice > nextPrice) throw new Error('Minimum promotional price cannot exceed the selling price.');
  if (req.body.name != null) product.name = cleanText(req.body.name) || product.name;
  if (req.body.brand != null) product.brand = cleanText(req.body.brand);
  if (req.body.category != null) product.category = cleanText(req.body.category);
  if (req.body.description != null) product.description = cleanText(req.body.description, 1000);
  if (req.body.costPrice != null) product.costPrice = finiteNumber(req.body.costPrice, 'Cost price', { min: 0, max: 10000000 });
  product.price = nextPrice;
  product.minimumPrice = nextMinimumPrice;
  if (req.body.active != null) product.active = req.body.active === true || String(req.body.active) === 'true';
  product.updatedAt = now(); save();
  res.json({ product });
}));
api.post('/inventory/products/:id/batches', wrap((req, res) => res.status(201).json({ batch: addBatch(req.params.id, req.body || {}) })));
api.patch('/inventory/batches/:id', wrap((req, res) => {
  const batch = getBatch(req.params.id);
  const before = Number(batch.quantity);
  if (req.body.quantity != null) batch.quantity = finiteNumber(req.body.quantity, 'Quantity', { min: 0, max: 100000000 });
  if (req.body.expiryDate != null) batch.expiryDate = dateOnly(req.body.expiryDate);
  if (req.body.manufacturingDate != null) batch.manufacturingDate = req.body.manufacturingDate ? dateOnly(req.body.manufacturingDate) : null;
  if (batch.manufacturingDate && batch.manufacturingDate > batch.expiryDate) throw Object.assign(new Error('Manufacturing date cannot be after expiry date.'), { status: 400 });
  if (req.body.batchNumber != null) batch.batchNumber = cleanText(req.body.batchNumber, 100) || batch.batchNumber;
  if (req.body.supplier != null) batch.supplier = cleanText(req.body.supplier);
  if (req.body.location != null) batch.location = cleanText(req.body.location);
  if (req.body.blocked != null) batch.blocked = req.body.blocked === true || String(req.body.blocked) === 'true';
  if (req.body.recalled != null) batch.recalled = req.body.recalled === true || String(req.body.recalled) === 'true';
  batch.updatedAt = now();
  if (Number(batch.quantity) !== before) state.inventory.movements.unshift({
    id: inventoryId('movement'), productId: batch.productId, batchId: batch.id,
    type: Number(batch.quantity) > before ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT', quantity: Number(batch.quantity) - before, at: now(),
  });
  reconcileCampaignSafety();
  save(); res.json({ batch, recommendation: recommendationFor(batch, getProduct(batch.productId)) });
}));
api.post('/inventory/import', upload.single('csv'), wrap(async (req, res) => {
  if (!req.file) throw Object.assign(new Error('Choose a CSV file.'), { status: 400 });
  if (req.file.size > 2 * 1024 * 1024) throw Object.assign(new Error('CSV file must be under 2 MB.'), { status: 400 });
  const imported = importInventoryCsvText(req.file.buffer.toString('utf8'));
  await flushSave();
  res.status(201).json({ imported });
}));
api.put('/inventory/rules', wrap((req, res) => {
  const current = state.inventory.rules;
  const next = {
    scanDays: finiteNumber(req.body.scanDays ?? current.scanDays, 'Scan window', { min: 1, max: 365 }),
    smallDiscountDays: finiteNumber(req.body.smallDiscountDays ?? current.smallDiscountDays, 'Small-discount window', { min: 1, max: 365 }),
    strongDiscountDays: finiteNumber(req.body.strongDiscountDays ?? current.strongDiscountDays, 'Strong-discount window', { min: 1, max: 365 }),
    urgentDays: finiteNumber(req.body.urgentDays ?? current.urgentDays, 'Urgent window', { min: 1, max: 365 }),
    smallDiscountPercent: finiteNumber(req.body.smallDiscountPercent ?? current.smallDiscountPercent, 'Small discount', { min: 0, max: 90 }),
    strongDiscountPercent: finiteNumber(req.body.strongDiscountPercent ?? current.strongDiscountPercent, 'Strong discount', { min: 0, max: 90 }),
    urgentDiscountPercent: finiteNumber(req.body.urgentDiscountPercent ?? current.urgentDiscountPercent, 'Urgent discount', { min: 0, max: 90 }),
    minimumStock: finiteNumber(req.body.minimumStock ?? current.minimumStock, 'Minimum stock', { min: 0, max: 100000000 }),
    requireApproval: true,
  };
  if (!(next.urgentDays < next.strongDiscountDays && next.strongDiscountDays < next.smallDiscountDays && next.smallDiscountDays < next.scanDays)) {
    throw new Error('Expiry windows must increase in this order: urgent, strong, small, scan.');
  }
  state.inventory.rules = next; save(); res.json({ rules: next });
}));
api.post('/inventory/scan', wrap((_req, res) => {
  res.json(recordInventoryScan());
}));
api.post('/inventory/batches/:id/campaigns', wrap(async (req, res) => {
  const campaign = await createInventoryCampaign(req.params.id, req.body || {});
  res.status(202).json({ campaign });
}));
api.post('/inventory/campaigns/:id/changes', wrap((req, res) => {
  const campaign = getCampaign(req.params.id);
  const design = assertCampaignPublishable(campaign);
  const feedback = cleanText(req.body.feedback, 1000);
  if (!feedback) throw new Error('Describe the changes you want.');
  if (design.status !== 'PENDING') throw conflict('This preview was already answered.');
  design.status = 'REJECTED'; design.feedback = feedback; design.respondedAt = now();
  campaign.status = 'GENERATING'; campaign.error = null; campaign.updatedAt = now();
  const messageId = `inventory-edit:${campaign.id}:${randomUUID()}`;
  addJob({ kind: 'INVENTORY_FEEDBACK', action: 'EDIT_SELECTED', designId: design.id, campaignId: campaign.id, label: `Revising campaign` }, async () => {
    await agenticFeedback({ externalRef: design.externalRef, action: 'EDIT_SELECTED', feedback, messageId });
  });
  save(); res.status(202).json({ campaign });
}));
api.post('/inventory/campaigns/:id/approve', wrap((req, res) => {
  if (req.body.confirm !== true) throw Object.assign(new Error('Explicit publish confirmation is required.'), { status: 400 });
  const campaign = getCampaign(req.params.id);
  if (campaign.status !== 'READY') throw conflict('This campaign is not ready for publishing.');
  const design = assertCampaignPublishable(campaign);
  campaign.status = 'PUBLISHING'; campaign.approvedAt = now(); campaign.updatedAt = now(); campaign.error = null;
  approve(design.id); save();
  logEvent('inventory.campaign.approved', { campaignId: campaign.id, targetChannels: campaign.targetChannels });
  res.status(202).json({ campaign });
}));
api.post('/inventory/campaigns/:id/sales', wrap((req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!['PUBLISHED', 'ENDED'].includes(campaign.status)) throw conflict('Sales can only be recorded for a published campaign.');
  const batch = getBatch(campaign.batchId);
  const units = finiteNumber(req.body.units, 'Units sold', { min: 1, max: Number(batch.quantity) });
  const redemptions = finiteNumber(req.body.redemptions ?? 1, 'Redemptions', { min: 1, max: 100000000 });
  if (campaign.maxRedemptions && Number(campaign.redemptions || 0) + redemptions > campaign.maxRedemptions) {
    throw conflict('This would exceed the campaign redemption limit.');
  }
  batch.quantity = Number(batch.quantity) - units;
  batch.updatedAt = now();
  campaign.unitsSold = Number(campaign.unitsSold || 0) + units;
  campaign.redemptions = Number(campaign.redemptions || 0) + redemptions;
  campaign.updatedAt = now();
  state.inventory.movements.unshift({ id: inventoryId('movement'), productId: batch.productId, batchId: batch.id, campaignId: campaign.id, type: 'CAMPAIGN_SALE', quantity: -units, at: now() });
  reconcileCampaignSafety(); save();
  res.json({ campaign, batch });
}));
api.post('/inventory/campaigns/:id/end', wrap((req, res) => {
  const campaign = getCampaign(req.params.id);
  if (!['GENERATING', 'READY', 'PUBLISHED', 'BLOCKED', 'NEEDS_ATTENTION', 'FAILED'].includes(campaign.status)) throw conflict('This campaign is already closed or being published.');
  campaign.status = 'ENDED'; campaign.error = cleanText(req.body?.reason, 200) || 'Ended by merchant.'; campaign.endedAt = now(); campaign.updatedAt = now();
  save(); res.json({ campaign });
}));
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
api.post('/designs/:id/approve', wrap((req, res) => {
  const design = getDesign(req.params.id);
  if (design.campaignId) throw conflict('Inventory campaigns must be approved from Inventory so stock and expiry can be checked.');
  approve(design.id); res.json({ success: true });
}));
api.post('/designs/:id/changes', wrap((req, res) => {
  const design = getDesign(req.params.id);
  if (design.campaignId) throw conflict('Inventory campaign changes must be requested from Inventory.');
  requestChanges(design.id, req.body?.feedback); res.json({ success: true });
}));
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
  await seedInventoryIfEmpty();
  app.listen(cfg.port, host, () => {
    console.log(`🎙️  Design Studio running:  http://localhost:${cfg.port}`);
    console.log(`🔗 Agentic: ${cfg.agenticUrl}   merchantId: "${cfg.merchantId}"`);
    console.log(`📥 Agentic dashboard handoff: <this server's public URL>/integrations/agentic/previews`);
    console.log(`💾 Persistence: ${pool ? 'PostgreSQL' : cfg.dataDir}`);
    if (!cfg.dashboardToken) console.log('🔒 No DASHBOARD_TOKEN set: listening on 127.0.0.1 only.');
  });
}
start().catch(error => { console.error('❌ Dashboard startup failed:', error); process.exit(1); });