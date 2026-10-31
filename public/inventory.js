(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value || 0));
  const ACTIVE = ['GENERATING', 'READY', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'NEEDS_ATTENTION', 'BLOCKED'];
  let inventory = null, active = false, loading = false, hasScanned = false, selectedBatchId = null, refreshTimer = null, lastHtml = '';

  const token = () => { try { return localStorage.getItem('vs.token') || ''; } catch { return ''; } };
  function notice(message, bad = false) {
    const item = document.createElement('div'); item.className = `toast${bad ? ' bad' : ''}`; item.textContent = message;
    $('toasts').appendChild(item); setTimeout(() => item.classList.add('out'), 3800); setTimeout(() => item.remove(), 4200);
  }
  async function request(path, options = {}) {
    const response = await fetch(`/api${path}`, { ...options, headers: { 'x-dashboard-token': token(), ...(options.headers || {}) } });
    let body = null; try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
    return body;
  }

  /* ---------- Apple-style sheets (replace browser confirm/prompt) ---------- */
  function sheet({ title, message, fields = [], confirmLabel = 'Continue', cancelLabel = 'Cancel' }) {
    return new Promise(resolve => {
      const back = document.createElement('div'); back.className = 'sheet-backdrop';
      back.innerHTML = `<form class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h3>${esc(title)}</h3>${message ? `<p>${esc(message)}</p>` : ''}${fields.length ? `<div class="sheet-fields">${fields.map(f => `<label>${esc(f.label)}<input name="${esc(f.name)}" type="number" inputmode="numeric" min="${esc(f.min ?? 0)}" step="1" value="${esc(f.value ?? '')}" required></label>`).join('')}</div>` : ''}<div class="sheet-actions"><button class="btn btn-primary" type="submit">${esc(confirmLabel)}</button><button class="btn btn-ghost" type="button" data-cancel>${esc(cancelLabel)}</button></div></form>`;
      const previous = document.activeElement;
      const done = value => {
        document.removeEventListener('keydown', onKey); back.classList.add('out');
        setTimeout(() => { back.remove(); previous?.focus?.(); }, 280); resolve(value);
      };
      const onKey = event => { if (event.key === 'Escape') done(null); };
      back.addEventListener('mousedown', event => { if (event.target === back) done(null); });
      back.querySelector('[data-cancel]').addEventListener('click', () => done(null));
      back.querySelector('form').addEventListener('submit', event => { event.preventDefault(); done(Object.fromEntries(new FormData(event.currentTarget))); });
      document.addEventListener('keydown', onKey); document.body.appendChild(back);
      (back.querySelector('input') || back.querySelector('.btn-primary')).focus();
    });
  }
  const confirmSheet = (title, message, confirmLabel) => sheet({ title, message, confirmLabel }).then(Boolean);
  window.merchantConfirm = confirmSheet;

  /* ---------- helpers ---------- */
  const media = id => `/api/media/${encodeURIComponent(id)}?token=${encodeURIComponent(token())}`;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const productFor = id => inventory?.products.find(product => product.id === id);
  const offerText = campaign => campaign.offerLabel || `${campaign.discountPercent}% off`;
  const tierLabel = tier => String(tier || '').charAt(0) + String(tier || '').slice(1).toLowerCase();
  const shortDate = value => { const date = new Date(`${value}T00:00:00`); return Number.isNaN(date.getTime()) ? String(value ?? '') : date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const statusLabel = status => ({ GENERATING: 'Designing your campaign', READY: 'Ready for your approval', PUBLISHING: 'Publishing now', PUBLISHED: 'Published', FAILED: 'Generation failed', NEEDS_ATTENTION: 'Needs attention', BLOCKED: 'Safety blocked' })[status] || status;
  const statusClass = status => status === 'PUBLISHED' ? 'ok' : ['FAILED', 'NEEDS_ATTENTION', 'BLOCKED'].includes(status) ? 'bad' : ['GENERATING', 'PUBLISHING'].includes(status) ? 'pending' : 'warn';
  const assistant = content => `<section class="inv-turn"><div class="inv-content">${content}</div></section>`;
  const user = content => `<section class="inv-turn user"><div class="inv-user-bubble">${content}</div></section>`;
  const currentCampaign = () => inventory?.campaigns.find(campaign => ACTIVE.includes(campaign.status)) || null;
  const selectedCandidate = () => inventory?.candidates.find(({ batch }) => batch.id === selectedBatchId) || null;
  function bestCandidate() {
    const busy = new Set(inventory.campaigns.filter(campaign => ACTIVE.includes(campaign.status)).map(campaign => campaign.batchId));
    return inventory.candidates.find(({ batch }) => batch.recommendation.eligible && batch.recommendation.tier !== 'MONITOR' && !busy.has(batch.id)) || null;
  }

  /* ---------- turns ---------- */
  function scanTurn() {
    if (!loading && hasScanned) return '';
    if (loading) return assistant(`<div class="scan-line busy"><span class="scan-spinner"></span><span class="t">Scanning every product and expiry batch…</span></div><div class="scan-meta">Checking stock, safety, margin and expiry urgency</div>`);
    const when = inventory?.lastScanAt ? new Date(inventory.lastScanAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return assistant(`<div class="scan-line">Ready to scan your inventory</div><p>I’ll find the product most worth promoting right now.</p><button class="btn btn-primary" id="runInventoryScan">Scan inventory</button>${when ? `<div class="scan-meta">Last scan ${esc(when)}</div>` : ''}`);
  }
  function statsTurn() {
    const summary = inventory.summary;
    const stats = [['Products', summary.products], ['Units in stock', summary.units], ['Eligible offers', summary.expiringSoon], ['Safety blocks', summary.blocked], ['Campaigns', summary.campaigns]];
    return assistant(`<p><strong>Scan complete.</strong> Here’s where your inventory stands.</p><div class="scan-stats">${stats.map(([label, value]) => `<div class="scan-stat"><b data-count="${esc(Number(value) || 0)}">${esc(value)}</b><span>${esc(label)}</span></div>`).join('')}</div>`);
  }
  function recommendationTurn({ product, batch }) {
    const rec = batch.recommendation;
    const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;
    const facts = [[batch.batchNumber, 'Batch'], [plural(batch.quantity, 'unit'), 'In stock'], [shortDate(batch.expiryDate), 'Expires'], [plural(rec.daysRemaining, 'day'), 'Time left'], [`${rec.discountPercent}% off`, 'Suggested']];
    return assistant(`<p>I checked <strong>${esc(inventory.summary.products)} products</strong> and found ${esc(inventory.summary.expiringSoon)} eligible ${Number(inventory.summary.expiringSoon) === 1 ? 'opportunity' : 'opportunities'}. This is the best candidate right now.</p><article class="recommendation-card"><div class="recommendation-head"><div><h3>${esc(product.name)}</h3><div class="reason">Highest urgency, with safe stock and a healthy margin.</div></div><span class="tier ${esc(rec.tier)}">${esc(tierLabel(rec.tier))}</span></div><div class="facts">${facts.map(([value, label]) => `<div><b title="${esc(value)}">${esc(value)}</b><span>${esc(label)}</span></div>`).join('')}</div><div class="recommendation-actions"><button class="btn btn-primary" data-select-product="${esc(batch.id)}">Use this product</button><button class="btn btn-ghost" id="rescanInventory">Scan again</button></div></article>`);
  }
  function offerTurn({ product, batch }) {
    const rec = batch.recommendation;
    const endDate = new Date(new Date(`${batch.expiryDate}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    return user(`Use <strong>${esc(product.name)}</strong> for the campaign.`) + assistant(`<p>Good choice. Set the offer and I’ll send the brief to the design pipeline.</p><form class="offer-card" id="chatOfferForm"><input name="batchId" type="hidden" value="${esc(batch.id)}"><h3>Choose the offer</h3><p class="offer-help">Suggested ${esc(rec.discountPercent)}% off · ${esc(batch.quantity)} units · minimum price ${money(product.minimumPrice)}</p><div class="offer-grid"><label class="wide">Offer type<select name="offerType" id="chatOfferType"><option value="PERCENT_OFF">Percentage discount</option><option value="FIXED_PRICE">Special fixed price</option><option value="BUY_X_GET_Y">Buy X, get Y free</option><option value="MULTIBUY">Multi-buy bundle</option></select></label><label data-chat-offer="PERCENT_OFF">Discount (%)<input name="discountPercent" type="number" min="1" max="90" step="1" value="${esc(rec.discountPercent)}"></label><label data-chat-offer="FIXED_PRICE" class="field-hidden">Special price (₹)<input name="promotionalPrice" type="number" min="0.01" step="0.01" value="${esc(rec.promotionalPrice)}"></label><label data-chat-offer="BUY_X_GET_Y" class="field-hidden">Customer buys<input name="buyQuantity" type="number" min="1" step="1" value="2"></label><label data-chat-offer="BUY_X_GET_Y" class="field-hidden">Customer gets free<input name="freeQuantity" type="number" min="1" step="1" value="1"></label><label data-chat-offer="MULTIBUY" class="field-hidden">Number of units<input name="bundleQuantity" type="number" min="2" step="1" value="2"></label><label data-chat-offer="MULTIBUY" class="field-hidden">Total bundle price (₹)<input name="bundlePrice" type="number" min="0.01" step="0.01"></label><label>Coupon code<input name="couponCode" maxlength="30" placeholder="Generate automatically"></label><label>Maximum redemptions<input name="maxRedemptions" type="number" min="1" step="1" placeholder="No limit"></label><label>Offer starts<input name="offerStartsAt" type="date" required value="${esc(today())}"></label><label>Offer ends<input name="offerEndsAt" type="date" required value="${esc(endDate)}"></label><div class="wide publish-to"><label class="check-row">Instagram<input name="instagram" type="checkbox" checked></label><label class="check-row">Facebook<input name="facebook" type="checkbox" checked></label></div><p class="wide offer-help" style="margin:0">Price, stock and expiry are checked now and again before publishing.</p></div><div class="offer-submit"><button class="btn btn-primary" type="submit">Generate campaign design</button></div></form>`);
  }
  function campaignTurn(campaign) {
    const product = productFor(campaign.productId), channels = campaign.targetChannels?.length ? campaign.targetChannels.join(' + ') : 'export only';
    const chosen = user(`Create a <strong>${esc(offerText(campaign))}</strong> campaign for <strong>${esc(product?.name || 'this product')}</strong>.`);
    if (campaign.status === 'GENERATING') return chosen + assistant(`<div class="scan-line busy"><span class="scan-spinner"></span><span class="t">Designing your advertisement…</span></div><div class="scan-meta">The preview and approval controls will appear here.</div>`);
    if (campaign.status === 'PUBLISHING') return chosen + assistant(`<div class="scan-line busy"><span class="scan-spinner"></span><span class="t">Publishing your campaign…</span></div><div class="scan-meta">Destinations: ${esc(channels)}</div>`);
    const preview = campaign.design?.mediaId ? `<img src="${media(campaign.design.mediaId)}" alt="Generated campaign preview for ${esc(product?.name || 'product')}">` : '';
    const approval = campaign.status === 'READY' ? `<div class="campaign-actions"><button class="btn btn-approve" data-approve="${esc(campaign.id)}">Approve &amp; publish</button></div><div class="revision-box"><textarea id="revisionFeedback" aria-label="Requested changes" placeholder="Or describe what you’d like changed…"></textarea><button class="btn btn-ghost" data-revise="${esc(campaign.id)}">Request changes</button></div>` : '';
    const published = campaign.status === 'PUBLISHED' ? `<div class="campaign-actions"><button class="btn btn-ghost" data-sale="${esc(campaign.id)}">Record sale</button><button class="btn btn-ghost" data-end="${esc(campaign.id)}">End campaign</button></div>` : '';
    const close = ['FAILED', 'NEEDS_ATTENTION', 'BLOCKED'].includes(campaign.status) ? `<div class="campaign-actions"><button class="btn btn-ghost" data-end="${esc(campaign.id)}">Close this campaign</button></div>` : '';
    const delivery = campaign.publishResult ? `<div class="inv-meta" style="margin-top:14px"><span>Delivered: ${esc(campaign.publishResult.delivered?.join(', ') || 'none')}</span>${campaign.publishResult.failed?.length ? `<span>Failed: ${esc(campaign.publishResult.failed.join(', '))}</span>` : ''}</div>` : '';
    return chosen + assistant(`<p>${campaign.status === 'READY' ? 'Your design is ready. Approve it, or ask for a revision.' : 'Here’s the latest on your campaign.'}</p><article class="campaign-card">${preview}<div class="campaign-body"><div class="campaign-head"><h3>${esc(product?.name || 'Product campaign')}</h3><span class="chip ${statusClass(campaign.status)}">${esc(statusLabel(campaign.status))}</span></div><div class="campaign-copy"><strong>${esc(offerText(campaign))}</strong> · ${money(campaign.promotionalPrice)} per unit · coupon <strong>${esc(campaign.couponCode)}</strong><br>${esc(campaign.offerStartsAt ? shortDate(campaign.offerStartsAt) : '')} to ${esc(shortDate(campaign.offerEndsAt))} · ${esc(channels)}</div>${campaign.error ? `<div class="blocked-note">${esc(campaign.error)}</div>` : ''}${approval}${published}${close}${delivery}</div></article>`);
  }

  /* ---------- render (only new turns animate) ---------- */
  const seen = new Set();
  function paint(html) {
    const thread = $('inventoryThread');
    if (html === lastHtml) return false;
    const typed = $('revisionFeedback')?.value;
    thread.innerHTML = html; lastHtml = html;
    const next = new Set();
    thread.querySelectorAll('.inv-turn').forEach(el => { const key = el.outerHTML; next.add(key); if (seen.has(key)) el.classList.add('static'); });
    seen.clear(); next.forEach(key => seen.add(key));
    if (typed && $('revisionFeedback')) $('revisionFeedback').value = typed;
    countUp(thread); return true;
  }
  function countUp(root) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    root.querySelectorAll('.inv-turn:not(.static) [data-count]').forEach(el => {
      const target = Number(el.dataset.count) || 0, start = performance.now(), duration = 1100;
      const tick = now => {
        const t = Math.min(1, (now - start) / duration), eased = 1 - Math.pow(1 - t, 4);
        el.textContent = Math.round(target * eased).toLocaleString('en-IN');
        if (t < 1 && el.isConnected) requestAnimationFrame(tick); else el.textContent = target.toLocaleString('en-IN');
      };
      el.textContent = '0'; requestAnimationFrame(tick);
    });
  }
  function render() {
    const thread = $('inventoryThread'); if (!thread) return;
    if (!inventory) { if (paint(scanTurn())) bind(); return; }
    const campaign = currentCampaign(); let html = scanTurn();
    if (hasScanned) html += statsTurn();
    if (campaign) html += campaignTurn(campaign);
    else if (hasScanned) {
      const selected = selectedCandidate(), best = bestCandidate();
      if (selected) html += recommendationTurn(selected) + offerTurn(selected);
      else if (best) html += recommendationTurn(best);
      else html += assistant(`<div class="empty-inv"><strong>No safe campaign candidate found.</strong><br>Expired, recalled, blocked and low-stock products were left out.<div class="recommendation-actions"><button class="btn btn-ghost" id="rescanInventory">Scan again</button></div></div>`);
    }
    if (paint(html)) bind();
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
  const scrollBottom = () => setTimeout(() => $('inventoryPage')?.scrollTo({ top: $('inventoryPage').scrollHeight, behavior: 'smooth' }), 60);

  /* ---------- actions ---------- */
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
    if (!data.targetChannels.length && !await confirmSheet('Export only?', 'No channel is selected, so the design will be generated for export and not published.', 'Generate')) return;
    button.disabled = true;
    try { await request(`/inventory/batches/${encodeURIComponent(batchId)}/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); selectedBatchId = null; notice('Campaign design started.'); await refresh(true); startPolling(); scrollBottom(); }
    catch (error) { notice(error.message, true); button.disabled = false; }
  }
  async function approveCampaign(id) {
    if (!await confirmSheet('Publish this design?', 'This exact image will be published to the selected destinations.', 'Approve & publish')) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }); notice('Publishing started.'); await refresh(true); startPolling(); scrollBottom(); } catch (error) { notice(error.message, true); }
  }
  async function reviseCampaign(id) {
    const feedback = $('revisionFeedback')?.value.trim(); if (!feedback) { notice('Describe the design change first.', true); return; }
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }) }); notice('Revision requested.'); await refresh(true); startPolling(); } catch (error) { notice(error.message, true); }
  }
  async function recordSale(id) {
    const answer = await sheet({ title: 'Record a sale', message: 'Stock is updated when you save.', confirmLabel: 'Save', fields: [{ name: 'units', label: 'Units sold', value: 1, min: 0 }, { name: 'redemptions', label: 'Offer redemptions', value: 1, min: 0 }] });
    if (!answer) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: Number(answer.units), redemptions: Number(answer.redemptions) }) }); notice('Sale and stock recorded.'); await refresh(true); } catch (error) { notice(error.message, true); }
  }
  async function endCampaign(id) {
    if (!await confirmSheet('Close this campaign?', 'You can start a new scan afterwards.', 'Close campaign')) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Ended by merchant.' }) }); hasScanned = false; notice('Campaign closed.'); await refresh(true); } catch (error) { notice(error.message, true); }
  }
  async function refresh(showError = false) { try { const before = currentCampaign()?.status; inventory = await request('/inventory'); render(); if (before === 'GENERATING' && currentCampaign()?.status === 'READY') { notice('Your design is ready for review.'); scrollBottom(); } } catch (error) { if (showError) notice(error.message, true); } }
  function startPolling() {
    clearTimeout(refreshTimer);
    if (!active) return;
    const busy = inventory?.campaigns.some(campaign => ['GENERATING', 'PUBLISHING'].includes(campaign.status));
    if (!busy) return;
    refreshTimer = setTimeout(async () => { await refresh(); startPolling(); }, 1400);
  }
  function setMode(mode) {
    active = mode === 'inventory'; $('main').classList.toggle('hidden', active); $('inventoryPage').classList.toggle('hidden', !active); $('modeVoice').classList.toggle('active', !active); $('modeInventory').classList.toggle('active', active);
    for (const id of ['newBrief', 'voiceReplyBtn']) $(id)?.classList.toggle('hidden', active);
    if (active) { render(); refresh(true).then(startPolling); } else clearTimeout(refreshTimer);
    try { localStorage.setItem('merchant.workspace', mode); } catch {}
  }
  $('modeVoice').onclick = () => setMode('voice'); $('modeInventory').onclick = () => setMode('inventory');
  window.addEventListener('merchant:authenticated', () => { if (active) refresh(true).then(startPolling); });
  let preferred = 'voice'; try { preferred = localStorage.getItem('merchant.workspace') || 'voice'; } catch {}
  if (preferred === 'inventory') setTimeout(() => setMode('inventory'), 0);
})();