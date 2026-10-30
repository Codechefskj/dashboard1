(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value || 0));
  let inventory = null;
  let active = false;
  let refreshTimer = null;

  const token = () => { try { return localStorage.getItem('vs.token') || ''; } catch { return ''; } };
  function notice(message, bad = false) {
    const item = document.createElement('div');
    item.className = `toast${bad ? ' bad' : ''}`; item.textContent = message;
    $('toasts').appendChild(item); setTimeout(() => item.remove(), 4200);
  }
  async function request(path, options = {}) {
    const response = await fetch(`/api${path}`, { ...options, headers: { 'x-dashboard-token': token(), ...(options.headers || {}) } });
    let body = null; try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
    return body;
  }
  function media(id) { return `/api/media/${encodeURIComponent(id)}?token=${encodeURIComponent(token())}`; }
  function productFor(id) { return inventory?.products.find(product => product.id === id); }
  function today() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }
  function offerText(campaign) { return campaign.offerLabel || `${campaign.discountPercent}% off`; }
  function statusLabel(status) {
    return ({ GENERATING: 'Designing', READY: 'Ready for review', PUBLISHING: 'Publishing', PUBLISHED: 'Published', FAILED: 'Failed', NEEDS_ATTENTION: 'Needs details', BLOCKED: 'Safety blocked', ENDED: 'Campaign ended' })[status] || status;
  }
  function statusClass(status) {
    if (status === 'PUBLISHED') return 'ok';
    if (['FAILED', 'NEEDS_ATTENTION', 'BLOCKED'].includes(status)) return 'bad';
    if (['GENERATING', 'PUBLISHING'].includes(status)) return 'pending';
    return 'warn';
  }

  function setMode(mode) {
    active = mode === 'inventory';
    $('main').classList.toggle('hidden', active);
    $('inventoryPage').classList.toggle('hidden', !active);
    $('modeVoice').classList.toggle('active', !active);
    $('modeInventory').classList.toggle('active', active);
    for (const id of ['newBrief', 'voiceReplyBtn', 'replayBtn']) $(id)?.classList.toggle('hidden', active);
    if (active) { refresh(true); startPolling(); }
    else clearTimeout(refreshTimer);
    try { localStorage.setItem('merchant.workspace', mode); } catch {}
  }
  $('modeVoice').onclick = () => setMode('voice');
  $('modeInventory').onclick = () => setMode('inventory');
  window.addEventListener('merchant:authenticated', () => { if (active) { refresh(true); startPolling(); } });

  function renderStats() {
    const summary = inventory.summary;
    const items = [
      ['Products', summary.products], ['Units in stock', summary.units], ['Promotion candidates', summary.expiringSoon],
      ['Safety blocks', summary.blocked], ['Campaigns', summary.campaigns],
    ];
    $('inventoryStats').innerHTML = items.map(([label, value]) => `<div class="inv-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join('');
    $('scanTime').textContent = inventory.lastScanAt ? `Last scan ${new Date(inventory.lastScanAt).toLocaleString()}` : 'Calculated live · scan not recorded yet';
  }
  function renderCandidates() {
    if (!inventory.candidates.length) {
      $('candidateList').innerHTML = '<div class="empty-inv">No batches are inside the promotion window.</div>'; return;
    }
    $('candidateList').innerHTML = inventory.candidates.map(({ product, batch }) => {
      const recommendation = batch.recommendation;
      const blocked = recommendation.blockedReasons.length > 0;
      return `<article class="candidate">
        <div><h4>${esc(product.name)} <span class="tier ${esc(recommendation.tier)}">${esc(recommendation.tier)}</span></h4>
          <div class="inv-meta"><span>Batch <code>${esc(batch.batchNumber)}</code></span><span>${esc(batch.quantity)} units</span><span>Expires ${esc(batch.expiryDate)}</span><span>${esc(recommendation.daysRemaining)} days left</span><span>${esc(recommendation.discountPercent)}% suggested</span></div>
          ${blocked ? `<div class="blocked-note">Blocked: ${esc(recommendation.blockedReasons.join(' · '))}</div>` : ''}
        </div>
        <button class="btn ${blocked ? 'btn-ghost' : 'btn-primary'}" data-campaign="${esc(batch.id)}" ${blocked || recommendation.tier === 'MONITOR' ? 'disabled' : ''}>Create campaign</button>
      </article>`;
    }).join('');
    $('candidateList').querySelectorAll('[data-campaign]').forEach(button => button.onclick = () => createCampaign(button.dataset.campaign));
  }
  function renderCampaigns() {
    if (!inventory.campaigns.length) {
      $('campaignList').innerHTML = '<div class="empty-inv">Campaign previews will appear here.</div>'; return;
    }
    $('campaignList').innerHTML = inventory.campaigns.map(campaign => {
      const product = productFor(campaign.productId);
      const channels = campaign.targetChannels.length ? campaign.targetChannels.join(' + ') : 'export only';
      return `<article class="campaign">
        ${campaign.design?.mediaId ? `<img src="${media(campaign.design.mediaId)}" alt="Campaign preview for ${esc(product?.name)}">` : ''}
        <div class="campaign-body"><div class="campaign-top"><h4>${esc(product?.name || 'Product campaign')}</h4><span class="chip ${statusClass(campaign.status)}">${esc(statusLabel(campaign.status))}</span></div>
          <p><b>${esc(offerText(campaign))}</b> · effective ${money(campaign.promotionalPrice)}/unit · coupon <b>${esc(campaign.couponCode)}</b><br>${esc(campaign.offerStartsAt || '')} to ${esc(campaign.offerEndsAt)} · ${esc(channels)}${campaign.maxRedemptions ? `<br>${esc(campaign.redemptions || 0)} / ${esc(campaign.maxRedemptions)} redemptions` : ''}${campaign.unitsSold ? ` · ${esc(campaign.unitsSold)} units sold` : ''}${campaign.error ? `<br><span class="blocked-note">${esc(campaign.error)}</span>` : ''}</p>
          ${campaign.status === 'READY' ? `<div class="campaign-buttons"><button class="btn btn-approve" data-approve="${esc(campaign.id)}">Approve & publish</button><button class="btn btn-ghost" data-revise="${esc(campaign.id)}">Request changes</button></div>` : ''}
          ${campaign.status === 'PUBLISHED' ? `<div class="campaign-buttons"><button class="btn btn-ghost" data-sale="${esc(campaign.id)}">Record sale</button><button class="btn btn-ghost" data-end="${esc(campaign.id)}">End campaign</button></div>` : ''}
          ${['GENERATING','READY','BLOCKED','NEEDS_ATTENTION','FAILED'].includes(campaign.status) ? `<div class="campaign-buttons"><button class="btn btn-ghost" data-end="${esc(campaign.id)}">End campaign</button></div>` : ''}
          ${campaign.publishResult ? `<div class="inv-meta"><span>Delivered: ${esc(campaign.publishResult.delivered.join(', ') || 'none')}</span>${campaign.publishResult.failed.length ? `<span>Failed: ${esc(campaign.publishResult.failed.join(', '))}</span>` : ''}</div>` : ''}
        </div>
      </article>`;
    }).join('');
    $('campaignList').querySelectorAll('[data-approve]').forEach(button => button.onclick = () => approveCampaign(button.dataset.approve));
    $('campaignList').querySelectorAll('[data-revise]').forEach(button => button.onclick = () => reviseCampaign(button.dataset.revise));
    $('campaignList').querySelectorAll('[data-sale]').forEach(button => button.onclick = () => recordSale(button.dataset.sale));
    $('campaignList').querySelectorAll('[data-end]').forEach(button => button.onclick = () => endCampaign(button.dataset.end));
  }
  function renderProducts() {
    if (!inventory.products.length) {
      $('productList').innerHTML = '<div class="empty-inv">Add a product manually or import a CSV to begin.</div>'; return;
    }
    $('productList').innerHTML = inventory.products.map(product => `<article class="product-row">
      <div><h4>${esc(product.name)}${product.active ? '' : ' · Inactive'}</h4><div class="inv-meta"><span>${esc(product.brand || 'No brand')}</span><code>${esc(product.sku || 'No SKU')}</code><span>${money(product.price)}</span></div><button class="btn btn-ghost" data-active="${esc(product.id)}" data-value="${product.active ? 'false' : 'true'}">${product.active ? 'Deactivate' : 'Activate'}</button></div>
      <div>${product.batches.map(batch => `<div class="inv-meta" style="margin:4px 0"><code>${esc(batch.batchNumber)}</code><span>${esc(batch.quantity)} units</span><span>Expiry ${esc(batch.expiryDate)}</span><span class="tier ${esc(batch.recommendation.tier)}">${esc(batch.recommendation.tier)}</span>${batch.recalled ? '<span class="blocked-note">Recalled</span>' : batch.blocked ? '<span class="blocked-note">Blocked</span>' : ''}</div>`).join('') || '<span class="inv-meta">No batches</span>'}</div>
      <div class="stock-edit">${product.batches.map(batch => `<button class="btn btn-ghost" data-edit-batch="${esc(batch.id)}">Edit batch</button><button class="btn btn-ghost" data-stock="${esc(batch.id)}" data-current="${esc(batch.quantity)}">Adjust stock</button><button class="btn btn-ghost" data-block="${esc(batch.id)}" data-value="${batch.blocked ? 'false' : 'true'}">${batch.blocked ? 'Unblock' : 'Block'}</button>`).join('')}</div>
    </article>`).join('');
    $('productList').querySelectorAll('[data-stock]').forEach(button => button.onclick = () => adjustStock(button.dataset.stock, button.dataset.current));
    $('productList').querySelectorAll('[data-block]').forEach(button => button.onclick = () => updateBatch(button.dataset.block, { blocked: button.dataset.value === 'true' }));
    $('productList').querySelectorAll('[data-edit-batch]').forEach(button => button.onclick = () => openBatchDialog(button.dataset.editBatch));
    $('productList').querySelectorAll('[data-active]').forEach(button => button.onclick = () => updateProduct(button.dataset.active, { active: button.dataset.value === 'true' }));
  }
  function render() { if (!inventory) return; renderStats(); renderCandidates(); renderCampaigns(); renderProducts(); }
  async function refresh(showError = false) {
    try { inventory = await request('/inventory'); render(); }
    catch (error) { if (showError) notice(error.message, true); }
  }
  function startPolling() {
    clearTimeout(refreshTimer);
    if (!active) return;
    refreshTimer = setTimeout(async () => { await refresh(); startPolling(); }, inventory?.campaigns.some(item => ['GENERATING', 'PUBLISHING'].includes(item.status)) ? 1400 : 5000);
  }

  $('inventoryAdd').onclick = () => { $('productForm').reset(); $('productDialog').showModal(); };
  $('inventoryAddBatch').onclick = () => openBatchDialog();
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
  $('productForm').onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      await request('/inventory/products', { method: 'POST', body: new FormData(event.currentTarget) });
      $('productDialog').close(); notice('Product and expiry batch saved.'); await refresh(true);
    } catch (error) { notice(error.message, true); } finally { button.disabled = false; }
  };
  $('inventoryImport').onclick = () => $('inventoryCsv').click();
  $('inventoryCsv').onchange = async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    const data = new FormData(); data.append('csv', file);
    try { const result = await request('/inventory/import', { method: 'POST', body: data }); notice(`${result.imported} products imported.`); await refresh(true); }
    catch (error) { notice(error.message, true); }
  };
  $('inventoryScan').onclick = async () => {
    try { inventory = await request('/inventory/scan', { method: 'POST' }); render(); notice('Expiry scan completed.'); }
    catch (error) { notice(error.message, true); }
  };
  $('inventoryRules').onclick = () => {
    if (!inventory) return;
    for (const [key, value] of Object.entries(inventory.rules)) if ($('rulesForm').elements[key]) $('rulesForm').elements[key].value = value;
    $('rulesDialog').showModal();
  };
  $('rulesForm').onsubmit = async event => {
    event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget));
    for (const key of Object.keys(body)) body[key] = Number(body[key]);
    try { await request('/inventory/rules', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); $('rulesDialog').close(); notice('Promotion rules updated.'); await refresh(true); }
    catch (error) { notice(error.message, true); }
  };
  async function createCampaign(batchId) {
    const item = inventory.candidates.find(candidate => candidate.batch.id === batchId);
    if (!item) return;
    const form = $('offerForm'); form.reset(); form.elements.batchId.value = batchId;
    form.elements.discountPercent.value = item.batch.recommendation.discountPercent;
    form.elements.offerStartsAt.value = today();
    form.elements.offerEndsAt.value = new Date(new Date(`${item.batch.expiryDate}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
    form.elements.instagram.checked = true; form.elements.facebook.checked = true;
    $('offerProductName').textContent = item.product.name;
    $('offerSuggestion').textContent = `${item.batch.recommendation.discountPercent}% suggested · ${item.batch.quantity} units · minimum unit price ${money(item.product.minimumPrice)}`;
    updateOfferFields(); $('offerDialog').showModal();
  }
  function updateOfferFields() {
    const type = $('offerType').value;
    document.querySelectorAll('[data-offer-field]').forEach(field => field.classList.toggle('field-hidden', field.dataset.offerField !== type));
  }
  $('offerType').onchange = updateOfferFields;
  $('offerForm').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const data = Object.fromEntries(new FormData(form));
    const batchId = data.batchId; delete data.batchId;
    data.targetChannels = ['instagram', 'facebook'].filter(channel => form.elements[channel].checked);
    delete data.instagram; delete data.facebook;
    for (const key of ['discountPercent','promotionalPrice','buyQuantity','freeQuantity','bundleQuantity','bundlePrice','maxRedemptions']) {
      if (data[key] === '') delete data[key]; else if (data[key] != null) data[key] = Number(data[key]);
    }
    if (!data.targetChannels.length && !confirm('No social channel is selected. Generate an export-only campaign?')) return;
    const button = event.submitter; button.disabled = true;
    try {
      await request(`/inventory/batches/${encodeURIComponent(batchId)}/campaigns`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      $('offerDialog').close(); notice('Campaign generation started.'); await refresh(true); startPolling();
    } catch (error) { notice(error.message, true); } finally { button.disabled = false; }
  };
  async function approveCampaign(id) {
    if (!confirm('Publish this approved image to its selected Instagram/Facebook destinations? Stock and expiry will be checked again.')) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) }); notice('Publishing started.'); await refresh(true); startPolling(); }
    catch (error) { notice(error.message, true); }
  }
  async function reviseCampaign(id) {
    const feedback = prompt('What should the design agent change?'); if (!feedback?.trim()) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }) }); notice('Revision requested.'); await refresh(true); startPolling(); }
    catch (error) { notice(error.message, true); }
  }
  async function recordSale(id) {
    const units = prompt('How many units were sold?', '1'); if (units == null) return;
    const redemptions = prompt('How many offer redemptions?', '1'); if (redemptions == null) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/sales`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: Number(units), redemptions: Number(redemptions) }) }); notice('Sale and stock recorded.'); await refresh(true); }
    catch (error) { notice(error.message, true); }
  }
  async function endCampaign(id) {
    if (!confirm('End this campaign? It will no longer be treated as active.')) return;
    try { await request(`/inventory/campaigns/${encodeURIComponent(id)}/end`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Ended by merchant.' }) }); notice('Campaign ended.'); await refresh(true); }
    catch (error) { notice(error.message, true); }
  }
  function openBatchDialog(batchId = null) {
    if (!inventory?.products.length) { notice('Add a product first.', true); return; }
    const form = $('batchForm'); form.reset();
    form.elements.productId.innerHTML = inventory.products.map(product => `<option value="${esc(product.id)}">${esc(product.name)}</option>`).join('');
    form.elements.batchId.value = batchId || '';
    form.elements.productId.disabled = !!batchId;
    $('batchDialogTitle').textContent = batchId ? 'Edit batch and expiry' : 'Add batch';
    if (batchId) {
      const product = inventory.products.find(item => item.batches.some(batch => batch.id === batchId));
      const batch = product.batches.find(item => item.id === batchId);
      form.elements.productId.value = product.id;
      for (const key of ['batchNumber','quantity','expiryDate','manufacturingDate','supplier','location']) form.elements[key].value = batch[key] || '';
      form.elements.recalled.checked = batch.recalled; form.elements.blocked.checked = batch.blocked;
    }
    $('batchDialog').showModal();
  }
  $('batchForm').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const batchId = form.elements.batchId.value;
    const body = Object.fromEntries(new FormData(form)); delete body.batchId; delete body.productId;
    body.quantity = Number(body.quantity); body.recalled = form.elements.recalled.checked; body.blocked = form.elements.blocked.checked;
    const productId = form.elements.productId.value; const path = batchId ? `/inventory/batches/${encodeURIComponent(batchId)}` : `/inventory/products/${encodeURIComponent(productId)}/batches`;
    try { await request(path, { method: batchId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); $('batchDialog').close(); notice(batchId ? 'Batch and expiry updated.' : 'Batch added.'); await refresh(true); }
    catch (error) { notice(error.message, true); }
  };
  async function adjustStock(id, current) {
    const quantity = prompt('Current quantity', current); if (quantity == null) return;
    await updateBatch(id, { quantity: Number(quantity) });
  }
  async function updateBatch(id, body) {
    try { await request(`/inventory/batches/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); notice('Batch updated.'); await refresh(true); }
    catch (error) { notice(error.message, true); }
  }
  async function updateProduct(id, body) {
    try { await request(`/inventory/products/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); notice('Product updated.'); await refresh(true); }
    catch (error) { notice(error.message, true); }
  }

  let preferred = 'voice'; try { preferred = localStorage.getItem('merchant.workspace') || 'voice'; } catch {}
  if (preferred === 'inventory') setTimeout(() => setMode('inventory'), 0);
})();