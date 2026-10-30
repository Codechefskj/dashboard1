const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await check()) return; } catch {}
    await sleep(80);
  }
  throw new Error('Timed out waiting for condition.');
}

test('keeps dashboard traffic separate and supports spoken approval confirmation', async t => {
  const agentPort = 33122;
  const dashboardPort = 33123;
  const token = 'integration-test-token';
  const dashboardToken = 'dashboard-test-token';
  const calls = [];
  const agent = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks) });
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('/feedback')) {
      res.end(JSON.stringify({ kind: 'approved', job: { handoffs: [{ type: 'PUBLISHING', deliveries: [{ channel: 'instagram', status: 'DELIVERED' }] }] } }));
    } else {
      res.statusCode = 201;
      res.end(JSON.stringify({ kind: 'design_ready', draft: { id: 'draft-test' }, job: { id: 'job-test' } }));
    }
  });
  await new Promise(resolve => agent.listen(agentPort, '127.0.0.1', resolve));
  t.after(() => agent.close());

  const dataDir = mkdtempSync(join(tmpdir(), 'voice-studio-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, PORT: String(dashboardPort), AGENTIC_API_URL: `http://127.0.0.1:${agentPort}`, INTERNAL_SERVICE_TOKEN: token, DASHBOARD_TOKEN: dashboardToken, DASHBOARD_MERCHANT_ID: 'dashboard', DATA_DIR: dataDir, DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => { child.kill(); rmSync(dataDir, { recursive: true, force: true }); });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${dashboardPort}/health`)).ok);

  const brief = new FormData();
  brief.append('text', 'Blue running shoes, launch offer');
  brief.append('targetChannels', JSON.stringify(['instagram']));
  const accepted = await fetch(`http://127.0.0.1:${dashboardPort}/api/messages`, { method: 'POST', headers: { 'x-dashboard-token': dashboardToken }, body: brief });
  assert.equal(accepted.status, 200);
  await waitFor(() => calls.some(call => call.url === '/api/integrations/dashboard/messages'));
  assert.equal(calls.some(call => call.url.includes('/api/integrations/whatsapp/')), false);
  assert.equal(calls[0].authorization, `Bearer ${token}`);

  const preview = new FormData();
  preview.append('metadata', JSON.stringify({ event: 'design.preview_ready', merchantId: 'dashboard', conversationId: 'dashboard:dashboard', designJobId: 'job-test', revisionId: 'revision-test', revisionNumber: 1, designs: [{ designId: 'design-1', filePart: 'preview_1' }] }));
  preview.append('preview_1', new Blob([Buffer.from('preview')], { type: 'image/png' }), 'preview.png');
  const previewResponse = await fetch(`http://127.0.0.1:${dashboardPort}/integrations/agentic/previews`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: preview });
  assert.equal(previewResponse.status, 200);

  const voiceApprove = new FormData();
  voiceApprove.append('text', 'approve and publish');
  voiceApprove.append('targetChannels', JSON.stringify(['instagram']));
  const confirmation = await fetch(`http://127.0.0.1:${dashboardPort}/api/voice-command`, { method: 'POST', headers: { 'x-dashboard-token': dashboardToken }, body: voiceApprove }).then(response => response.json());
  assert.equal(confirmation.kind, 'confirmation_required');
  assert.equal(calls.some(call => call.url.includes('/feedback')), false);

  const voiceConfirm = new FormData();
  voiceConfirm.append('text', 'confirm publish');
  voiceConfirm.append('targetChannels', JSON.stringify(['instagram']));
  const publishing = await fetch(`http://127.0.0.1:${dashboardPort}/api/voice-command`, { method: 'POST', headers: { 'x-dashboard-token': dashboardToken }, body: voiceConfirm }).then(response => response.json());
  assert.equal(publishing.kind, 'approval_started');
  await waitFor(() => calls.some(call => call.url === '/api/integrations/dashboard/jobs/job-test/feedback'));
});
