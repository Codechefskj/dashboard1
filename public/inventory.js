(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value || 0));
  const ACTIVE = ['GENERATING', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'NEEDS_ATTENTION', 'BLOCKED'];
  let inventory = null, active = false, loading = false, hasScanned = false, selectedBatchId = null, refreshTimer = null;

  const token = () => { try { return localStorage.getItem('vs.token') || ''; } catch { return ''; } };
  function notice(message, bad = false) {
    const item = document.createElement('div'); item.className = `toast${bad ? ' bad' : ''}`; item.textContent = message;
    $('toasts').appendChild(item); setTimeout(() => item.remove(), 4200);
  }
  async function request(path, options = {}) {
    const response = await fetch(`/api${path}`, { ...options, headers: { 'x-dashboard-token': token(), ...(options.headers || {}) } });
    let body = null; try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
    return body;
  }
  const media = id => `/api/media/${encodeURIComponent(id)}?token=${encodeURIComponent(token())}`;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const productFor = id => inventory?.products.find(product => product.id === id);
  const offerText = campaign => campaign.offerLabel || `${campaign.discountPercent}% off`;
  const statusLabel = status => ({ GENERATING: 'Designing your campaign', READY: 'Ready for your approval', PUBLISHING: 'Publishing now', PUBLISHED: 'Published', FAILED: 'Generation failed', NEEDS_ATTENTION: 'Needs attention', BLOCKED: 'Safety blocked' })[status] || status;
  const statusClass = status => status === 'PUBLISHED' ? 'ok' : ['FAILED', 'NEEDS_ATTENTION', 'BLOCKED'].includes(status) ? 'bad' : ['GENERATING', 'PUBLISHING'].includes(status) ? 'pending' : 'warn';
  const assistant = content => `<section class="inv-turn"><div class="inv-avatar">✦</div><div class="inv-content">${content}</div></section>`;
  const user = content => `<section class="inv-turn user"><div class="inv-user-bubble">${content}</div></section>`;
  const currentCampaign = () => inventory?.campaigns.find(campaign => ACTIVE.includes(campaign.status)) || null;
  const selectedCandidate = () => inventory?.candidates.find(({ batch }) => batch.id === selectedBatchId) || null;
  function bestCandidate() {
    const busy = new Set(inventory.campaigns.filter(campaign => ACTIVE.includes(campaign.status)).map(campaign => campaign.batchId));
    return inventory.candidates.find(({ batch }) => batch.recommendation.eligible && batch.recommendation.tier !== 'MONITOR' && !busy.has(batch.id)) || null;
  }

  function scanTurn() {
    if (loading) return assistant(`<div class="scan-line"><span class="scan-spinner"></span>Scanning every product and expiry batch…</div><div class="scan-meta">Checking stock, safety, margin and expiry urgency</div>`);
    const when = inventory?.lastScanAt ? new Date(inventory.lastScanAt).toLocaleString() : 'No scan completed yet';
    return assistant(`<div class="scan-line">Inventory scanner is ready</div><p>Run a scan for a fresh recommendation. Nothing is generated or published until you choose the product and approve the design.</p><button class="btn btn-primary" id="runInventoryScan">Scan inventory</button><div class="scan-meta">Last scan: ${esc(when)}</div>`);
  }
  function statsTurn() {
    const summary = inventory.summary;
    const stats = [['Products', summary.products], ['Units in stock', summary.units], ['Eligible offers', summary.expiringSoon], ['Safety blocks', summary.blocked], ['Campaigns', summary.campaigns]];
    return assistant(`<p><strong>Inventory scan complete.</strong> Here is the current inventory report.</p><div class="scan-stats">${stats.map(([label, value]) => `<div class="scan-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('')}</div>`);
  }
  function recommendationTurn({ product, batch }) {
    const rec = batch.recommendation;
    return assistant(`<p>I checked <strong>${esc(inventory.summary.products)} products</strong> and found ${esc(inventory.summary.expiringSoon)} eligible opportunities. This is the single best candidate right now.</p><article class="recommendation-card"><div class="recommendation-head"><div><h3>${esc(product.name)}</h3><div class="reason">Highest urgency with safe stock and a valid promotional margin.</div></div><span class="tier ${esc(rec.tier)}">${esc(rec.tier)}</span></div><div class="inv-meta"><span>Batch <code>${esc(batch.batchNumber)}</code></span><span>${esc(batch.quantity)} units</span><span>Expires ${esc(batch.expiryDate)}</span><span>${esc(rec.daysRemaining)} days left</span><span>${esc(rec.discountPercent)}% suggested</span></div><div class="recommendation-actions"><button class="btn btn-primary" data-select-product="${esc(batch.id)}">Use this product</button><button class="btn btn-ghost" id="rescanInventory">Scan again</button></div></article>`);
  }
  function offerTurn({ product, batch }) {
    const rec = batch.recommendation;
    const endDate = new Date(new Date(`${batch.expiryDate}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    return user(`Use <strong>${esc(product.name)}</strong> for the campaign.`) + assistant(`<p>Good choice. Pick the offer you want, then I’ll send the brief to the design pipeline.</p><form class="offer-card" id="chatOfferForm"><input name="batchId" type="hidden" value="${esc(batch.id)}"><h3>Choose the offer</h3><p class="offer-help">Suggested ${esc(rec.discountPercent)}% off · ${esc(batch.quantity)} units · minimum unit price ${money(product.minimumPrice)}</p><div class="offer-grid"><label class="wide">Offer type<select name="offerType" id="chatOfferType"><option value="PERCENT_OFF">Percentage discount</option><option value="FIXED_PRICE">Special fixed price</option><option value="BUY_X_GET_Y">Buy X, get Y free</option><option value="MULTIBUY">Multi-buy bundle</option></select></label><label data-chat-offer="PERCENT_OFF">Discount (%)<input name="discountPercent" type="number" min="1" max="90" step="1" value="${esc(rec.discountPercent)}"></label><label data-chat-offer="FIXED_PRICE" class="field-hidden">Special price (₹)<input name="promotionalPrice" type="number" min="0.01" step="0.01" value="${esc(rec.promotionalPrice)}"></label><label data-chat-offer="BUY_X_GET_Y" class="field-hidden">Customer buys<input name="buyQuantity" type="number" min="1" step="1" value="2"></label><label data-chat-offer="BUY_X_GET_Y" class="field-hidden">Customer gets free<input name="freeQuantity" type="number" min="1" step="1" value="1"></label><label data-chat-offer="MULTIBUY" class="field-hidden">Number of units<input name="bundleQuantity" type="number" min="2" step="1" value="2"></label><label data-chat-offer="MULTIBUY" class="field-hidden">Total bundle price (₹)<input name="bundlePrice" type="number" min="0.01" step="0.01"></label><label>Coupon code<input name="couponCode" maxlength="30" placeholder="Generate automatically"></label><label>Maximum redemptions<input name="maxRedemptions" type="number" min="1" step="1" placeholder="No limit"></label><label>Offer starts<input name="offerStartsAt" type="date" required value="${esc(today())}"></label><label>Offer ends<input name="offerEndsAt" type="date" required value="${esc(endDate)}"></label><div class="wide"><span class="offer-help">Publish to</span><div style="display:flex;gap:18px"><label class="check-row"><input name="instagram" type="checkbox" checked> Instagram</label><label class="check-row"><input name="facebook" type="checkbox" checked> Facebook</label></div></div><p class="wide offer-help">Price, stock and expiry are checked now and again before publishing.</p></div><div class="offer-submit"><button class="btn btn-primary" type="submit">Generate campaign design</button></div></form>`);
  }
  function campaignTurn(campaign) {
    const product = productFor(campaign.productId), channels = campaign.targetChannels?.length ? campaign.targetChannels.join(' + ') : 'export only';
    const chosen = user(`Create a <strong>${esc(offerText(campaign))}</strong> campaign for <strong>${esc(product?.name || 'this product')}</strong>.`);
    if (campaign.status === 'GENERATING') return chosen + assistant(`<div class="scan-line"><span class="scan-spinner"></span>The design pipeline is creating your advertisement…</div><div class="scan-meta">The preview and approval controls will appear right here.</div>`);
    if (campaign.status === 'PUBLISHING') return chosen + assistant(`<div class="scan-line"><span class="scan-spinner"></span>Your approved campaign is being published…</div><div class="scan-meta">Destinations: ${esc(channels)}</div>`);
    const preview = campaign.design?.mediaId ? `<img src="${media(campaign.design.mediaId)}" alt="Generated campaign preview for ${esc(product?.name || 'product')}">` : '';
    const approval = campaign.status === 'READY' ? `<div class="campaign-actions"><button class="btn btn-approve" data-approve="${esc(campaign.id)}">Approve & publish</button></div><div class="revision-box"><textarea id="revisionFeedback" placeholder="Or describe what you want changed…"></textarea><button class="btn btn-ghost" data-revise="${esc(campaign.id)}">Request changes</button></div>` : '';
    const published = campaign.status === 'PUBLISHED' ? `<div class="campaign-actions"><button class="btn btn-ghost" data-sale="${esc(campaign.id)}">Record sale</button><button class="btn btn-ghost" data-end="${esc(campaign.id)}">End campaign</button></div>` : '';
    const close = ['FAILED', 'NEEDS_ATTENTION', 'BLOCKED'].includes(campaign.status) ? `<div class="campaign-actions"><button class="btn btn-ghost" data-end="${esc(campaign.id)}">Close this campaign</button></div>` : '';
    const delivery = campaign.publishResult ? `<div class="inv-meta" style="margin-top:12px"><span>Delivered: ${esc(campaign.publishResult.delivered?.join(', ') || 'none')}</span>${campaign.publishResult.failed?.length ? `<span>Failed: ${esc(campaign.publishResult.failed.join(', '))}</span>` : ''}</div>` : '';
    return chosen + assistant(`<p>${campaign.status === 'READY' ? 'Your design is ready. Review it, then approve it or request a revision.' : 'Here is the latest campaign status.'}</p><article class="campaign-card">${preview}<div class="campaign-body"><div class="campaign-head"><h3>${esc(product?.name || 'Product campaign')}</h3><span class="chip ${statusClass(campaign.status)}">${esc(statusLabel(campaign.status))}</span></div><div class="campaign-copy"><strong>${esc(offerText(campaign))}</strong> · effective ${money(campaign.promotionalPrice)}/unit · coupon <strong>${esc(campaign.couponCode)}</strong><br>${esc(campaign.offerStartsAt || '')} to ${esc(campaign.offerEndsAt)} · ${esc(channels)}</div>${campaign.error ? `<div class="blocked-note">${esc(campaign.error)}</div>` : ''}${approval}${published}${close}${delivery}</div></article>`);
  }
  function render() {
    const thread = $('inventoryThread'); if (!thread) return;
    if (!inventory) { thread.innerHTML = scanTurn(); bind(); return; }
    const campaign = currentCampaign(); let html = scanTurn();
    if (hasScanned) html += statsTurn();
    if (campaign) html += campaignTurn(campaign);
    else if (hasScanned) {
      const selected = selectedCandidate(), best = bestCandidate();
      if (selected) html += recommendationTurn(selected) + offerTurn(selected);
      else if (best) html += recommendationTurn(best);
      else html += assistant(`<div class="empty-inv"><strong>No safe campaign candidate found.</strong><br>Expired, recalled, blocked and insufficient-stock products were excluded.</div>`);
    }
    thread.innerHTML = html; bind();
  }
  function bind() {
    $('runInventoryScan')?.addEventListener('click', runScan); $('rescanInventory')?.addEventListener('click', runScan);
    document.querySelectorAll('[data-select-product]').forEach(button => button.addEventListener('click', () => { selectedBatchId = button.dataset.selectProduct; render(); scrollBottom(); }));
    $('chatOfferType')?.addEventListener('change', event => document.querySelectorAll('[data-chat-offer]').forEach(field => field.classList.toggle('field-hidden', field.dataset.chatOffer !== event.target.value)));
    $('chatOfferForm')?.addEventListener('submit', submitOffer);
    document.querySelectorAll('[data-approve]').forEach(button => button.addEventListener('click', () => approveCampaign(button.dataset.approve)));
    document.querySelectorAll('[data-revise]').forEach(button => button.addEventListener('click', () => reviseCampaign(button.dataset.revise)));
    document.querySelectorAll('[data-sale]').forEach(button => button.addEventListener('click', () => recordSale(button.dataset.sale)));
    document.querySelectorAll('[data-end]').forEach(button => button.addEventListener('click', () => endCampaign(button.dataset.end)));
  }
  const scrollBottom = () => setTimeout(() => $('inventoryPage')?.scrollTo({ top: $('inventoryPage').scrollHeight, behavior: 'smooth' }), 30);
  async function runScan() {
    loading = true; selectedBatchId = null; render();
    try { inventory = await request('/inventory/scan', { method: 'POST' }); hasScanned = true; } catch (error) { notice(error.message, true); }
    finally { loading = false; render(); scrollBottom(); }
  }
  async function submitOffer(event) {
    event.preventDefault(); const form = event.currentTarget, button = event.submitter, data = Object.fromEntries(new FormData(form));
    const batchId = data.batchId; delete data.batchId;
    data.targetChannels = ['instagram', 'facebook'].filter(channel => form.elements[channel].checked); delete data.instagram; delete data.facebook;
    for (const key of ['discountPercent', 'promotionalPrice', 'buyQuantity', 'freeQuantity', 'bundleQuantity', 'bundlePrice', 'maxRedemptions']) { if (data[key] === '') delete data[key]; else if (data[key] != null) data[key] = Number(data[key]); }
    if (!data.targetChannels.length && !confirm('Generate this as an export-only campaign?')) return;
    button.disabled = true;
    try { await request(`/inventory/batches/${encodeURIComponent(batchId)}/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); selectedBatchId = null; notice('Campaign design started.'); await refresh(true); startPolling(); scrollBottom(); }
    catch (error) { notice(error.message, true); button.disabled = false; }
  }
  async function approveCampaign(id) {
    if (!confirm('Approve this exact image and publish it to the selected destinations?')) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }); notice('Publishing started.'); await refresh(true); startPolling(); scrollBottom(); } catch (error) { notice(error.message, true); }
  }
  async function reviseCampaign(id) {
    const feedback = $('revisionFeedback')?.value.trim(); if (!feedback) { notice('Describe the design change first.', true); return; }
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }) }); notice('Revision requested.'); await refresh(true); startPolling(); } catch (error) { notice(error.message, true); }
  }
  async function recordSale(id) {
    const units = prompt('How many units were sold?', '1'); if (units == null) return; const redemptions = prompt('How many offer redemptions?', '1'); if (redemptions == null) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: Number(units), redemptions: Number(redemptions) }) }); notice('Sale and stock recorded.'); await refresh(true); } catch (error) { notice(error.message, true); }
  }
  async function endCampaign(id) {
    if (!confirm('Close this campaign?')) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Ended by merchant.' }) }); hasScanned = false; notice('Campaign closed.'); await refresh(true); } catch (error) { notice(error.message, true); }
  }
  async function refresh(showError = false) { try { inventory = await request('/inventory'); render(); } catch (error) { if (showError) notice(error.message, true); } }
  function startPolling() {
    clearTimeout(refreshTimer);
    if (!active) return;
    const busy = inventory?.campaigns.some(campaign => ['GENERATING', 'PUBLISHING'].includes(campaign.status));
    if (!busy) return;
    refreshTimer = setTimeout(async () => { await refresh(); startPolling(); }, 1400);
  }
  function setMode(mode) {
    active = mode === 'inventory'; $('main').classList.toggle('hidden', active); $('inventoryPage').classList.toggle('hidden', !active); $('modeVoice').classList.toggle('active', !active); $('modeInventory').classList.toggle('active', active);
    for (const id of ['newBrief', 'voiceReplyBtn', 'replayBtn']) $(id)?.classList.toggle('hidden', active);
    if (active) refresh(true).then(startPolling); else clearTimeout(refreshTimer);
    try { localStorage.setItem('merchant.workspace', mode); } catch {}
  }
  $('modeVoice').onclick = () => setMode('voice'); $('modeInventory').onclick = () => setMode('inventory');
  window.addEventListener('merchant:authenticated', () => { if (active) refresh(true).then(startPolling); });
  let preferred = 'voice'; try { preferred = localStorage.getItem('merchant.workspace') || 'voice'; } catch {}
  if (preferred === 'inventory') setTimeout(() => setMode('inventory'), 0);
})();
