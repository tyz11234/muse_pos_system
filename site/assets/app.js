'use strict';
/* CNKH POS 2.0 — server-primary web client.
   Holds no business data: every screen reads/writes the server API,
   so phone, tablet and desktop always show the same truth. */

const $ = (id) => document.getElementById(id);
/* All API calls are relative to the page URL, so the same build works at
   a domain root (http://host:8091/) and under a sub-path
   (http://host/pos2/ via the port-80 proxy) without changes. */
const REL = (p) => p.replace(/^\//, '');
const BASE_PATH = location.pathname.endsWith('/')
  ? location.pathname
  : location.pathname.replace(/[^/]*$/, '');
const fmt = (c) => 'RM ' + (c / 100).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

let session = null;           // {token, user:{username,display_name,role}}
const isAdmin = () => !!session && session.user.role === 'ADMIN';
let settings = {};            // server settings cache
let categories = [];
let products = [];
let cart = new Map();         // productId -> {p, qty}
let activeCat = 0;
let payMethod = 'CASH';
let depositMethod = 'CASH';
let pendingSale = null;
let currentSaleId = null;

function toast(msg, ms = 2400) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (session) headers['Authorization'] = 'Bearer ' + session.token;
  const resp = await fetch(REL(path), { ...opts, headers });
  let data = null;
  try { data = await resp.json(); } catch (_) { /* empty body */ }
  if (resp.status === 401 && session) { logout(true); }
  if (!resp.ok) throw new Error((data && data.detail) || ('请求失败 ' + resp.status));
  return data;
}

/* ---------------- auth ---------------- */
let loginUser = null;

async function loadLoginUsers() {
  try {
    const d = await fetch(REL('/api/auth/users')).then((r) => r.json());
    const box = $('login-users');
    box.innerHTML = '';
    (d.users || []).forEach((u, i) => {
      const b = document.createElement('button');
      b.textContent = u.display_name || u.username;
      b.onclick = () => {
        loginUser = u.username;
        [...box.children].forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
        $('login-pin').focus();
      };
      if (i === 0) { loginUser = u.username; b.classList.add('sel'); }
      box.appendChild(b);
    });
  } catch (_) { /* server unreachable: login button will surface it */ }
}

async function doLogin() {
  primeSpeech();
  const pin = $('login-pin').value.trim();
  $('login-error').textContent = '';
  if (!loginUser) { $('login-error').textContent = '请选择账号'; return; }
  if (!pin) { $('login-error').textContent = '请输入 PIN'; return; }
  try {
    const resp = await fetch(REL('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUser, pin }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || '登录失败');
    session = { token: data.token, user: data.user };
    localStorage.setItem('pos2_session', JSON.stringify(session));
    $('login-pin').value = '';
    enterApp();
  } catch (e) {
    $('login-error').textContent = e.message;
  }
}

function logout(expired) {
  stopAuto();
  if (session && session.token) {
    fetch(REL('/api/auth/logout'), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + session.token },
    }).catch(() => { /* best effort revoke */ });
  }
  session = null;
  if (ws) { try { ws.close(); } catch (_) { /* already closed */ } ws = null; }
  cart.clear();
  localStorage.removeItem('pos2_cart');
  localStorage.removeItem('pos2_session');
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
  $('pay-banner').classList.add('hidden');
  $('cart-discount').value = '0';
  $('view-app').classList.add('hidden');
  $('view-login').classList.remove('hidden');
  if (expired) $('login-error').textContent = '登录已过期，请重新登录';
  loadLoginUsers();
}

async function enterApp() {
  $('view-login').classList.add('hidden');
  $('view-app').classList.remove('hidden');
  const u = session.user;
  $('top-user').textContent =
    (u.display_name || u.username) + (u.role === 'ADMIN' ? '（管理员）' : '');
  try {
    await refreshSettings();
    await loadCatalog();
  } catch (e) {
    toast('初始化失败：' + e.message);
    logout(false);
    return;
  }
  restoreCart();
  renderPos();
  switchTab('pos');
  applyRoleUi();
  connectWs();
  loadHeldCount();
}

/* Role-based UI: staff get a working till, admins get the back office.
   The server enforces the same rules; hiding here is only for clarity. */
function applyRoleUi() {
  const admin = isAdmin();
  const hubBtn = $('tabbtn-hub');
  if (hubBtn) hubBtn.classList.toggle('hidden', !admin);
  ['prod-add', 'cat-add', 'pur-add', 'sup-add', 'closing-btn'].forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', !admin);
  });
}

async function refreshSettings() {
  try {
    const d = await api('/api/settings');
    settings = d.settings || {};
    $('top-store').textContent = settings.store_name || '';
    $('login-store-name').textContent = settings.store_name || '收银系统 2.0';
    $('train-badge').classList.toggle('hidden', settings.training_mode !== '1');
  } catch (_) { /* keep last */ }
}

/* ---------------- tabs ---------------- */
const MAIN_TABS = ['pos', 'today', 'hub', 'settings'];
const HUB_PAGES = ['dashboard', 'products', 'categories', 'barcode', 'sales',
  'payments', 'customers', 'purchases', 'suppliers', 'stocktake', 'reports', 'closings',
  'users', 'maintenance', 'audit', 'draft', 'aliases'];
const SETTINGS_SUB = ['training', 'einvoice'];
function switchTab(name) {
  MAIN_TABS.concat(HUB_PAGES, SETTINGS_SUB).forEach((n) => {
    const el = $('tab-' + n);
    if (el) el.classList.toggle('hidden', n !== name);
  });
  const hl = HUB_PAGES.includes(name) ? 'hub' : name;
  document.querySelectorAll('.tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.tab === hl));
  if (name === 'today') loadToday();
  if (name === 'dashboard') loadDashboard();
  if (name === 'products') renderProducts();
  if (name === 'categories') renderCategoriesPage();
  if (name === 'barcode') loadBarcodeQueue();
  if (name === 'sales') loadSales();
  if (name === 'payments') loadPayments();
  if (name === 'reports') loadMonthly();
  if (name === 'customers') loadCustomersPage();
  if (name === 'purchases') loadPurchasesPage();
  if (name === 'suppliers') loadSuppliers();
  if (name === 'stocktake') renderStocktake();
  if (name === 'reports') loadReport();
  if (name === 'users') loadUsers();
  if (name === 'maintenance') renderWipeCats();
  if (name === 'audit') loadAudit();
  if (name === 'einvoice') loadEinvoice();
  if (name === 'aliases') loadAliasesPage();
  if (name === 'settings') renderSettings();
}

/* ---------------- POS ---------------- */
async function loadCatalog() {
  const [cats, prods] = await Promise.all([
    api('/api/categories'), api('/api/products'),
  ]);
  categories = cats.items || [];
  products = prods.items || [];
}

function renderPos() {
  const chips = $('pos-cats');
  chips.innerHTML = '';
  const all = document.createElement('button');
  all.textContent = '全部';
  all.className = activeCat === 0 ? 'sel' : '';
  all.onclick = () => { activeCat = 0; renderPos(); };
  chips.appendChild(all);
  categories.forEach((c) => {
    const b = document.createElement('button');
    b.textContent = c.name;
    b.className = activeCat === c.id ? 'sel' : '';
    b.onclick = () => { activeCat = c.id; renderPos(); };
    chips.appendChild(b);
  });
  const q = $('pos-search').value.trim().toLowerCase();
  const grid = $('pos-grid');
  grid.innerHTML = '';
  products
    .filter((p) => (!activeCat || p.category_id === activeCat) &&
      (!q || p.name.toLowerCase().includes(q) ||
        (p.barcode || '').includes(q) || (p.sku || '').toLowerCase().includes(q)))
    .forEach((p) => {
      const card = document.createElement('button');
      card.className = 'pcard' + (p.stock_qty <= 0 ? ' out' : '');
      card.innerHTML =
        (p.has_image ? '<img class="pth" src="' + productImageUrl(p.id) + '" alt="">' : '') +
        '<span class="pname">' + esc(p.name) + '</span>' +
        '<span class="pprice">' + fmt(p.price_cents) + '</span>' +
        '<span class="pstock' + (p.low_stock ? ' low' : '') + '">库存 ' +
        p.stock_qty + (p.low_stock ? ' · 快没了' : '') + '</span>';
      card.onclick = () => addToCart(p);
      grid.appendChild(card);
    });
  if (!grid.children.length)
    grid.innerHTML = '<div class="cart-empty">没有商品</div>';
  renderCart();
}

function addToCart(p) {
  const line = cart.get(p.id) || { p, qty: 0, disc: 0 };
  const want = line.qty + 1;
  if (!p._snap && typeof p.stock_qty === 'number' && want > p.stock_qty) {
    if ((settings.stock_policy || 'warn') === 'block') {
      toast('库存不足 / Insufficient stock（有 ' + p.stock_qty + '）：' + p.name);
      return;
    }
    if (!confirm(p.name + '\n需要 ' + want + ' · 库存 ' + p.stock_qty + '\n仍要加购？')) return;
  }
  line.qty = want;
  cart.set(p.id, line);
  renderCart();
}

function round5js(cents) {
  const r = cents % 10;
  if (r === 0 || r === 5) return cents;
  return r < 5 ? cents - r : cents + (10 - r);
}
function postAudit(body) {
  api('/api/audit', { method: 'POST', body: JSON.stringify(body) })
    .catch(() => { /* audit is best-effort from the till */ });
}
function editLineDiscount(entry) {
  const { p } = entry;
  const gross = Math.round(p.price_cents * entry.qty);
  const cur = Math.min(Math.max(0, entry.disc || 0), gross);
  const ans = prompt(
    '行折扣：输入金额（如 2.50）或百分比（如 10%）；输入 0 清除。\n' +
    p.name + ' 当前行折扣 ' + fmt(cur), '');
  if (ans === null) return;
  const t = ans.trim();
  let nd = 0;
  let mode = 'rm';
  if (t.endsWith('%')) {
    mode = 'percent';
    const pct = parseFloat(t);
    if (!isFinite(pct) || pct < 0) { toast('百分比无效'); return; }
    nd = Math.round(gross * pct / 100);
  } else {
    const rm = parseFloat(t);
    if (!isFinite(rm) || rm < 0) { toast('金额无效'); return; }
    nd = Math.round(rm * 100);
  }
  nd = Math.min(nd, gross);
  entry.disc = nd;
  cart.set(p.id, entry);
  postAudit({ action: 'line_discount', product_id: p.id,
    product_name: p.name, old_value: String(cur), new_value: String(nd),
    reason: mode });
  renderCart();
}

function cartTotals() {
  let gross = 0;
  let lineDisc = 0;
  cart.forEach(({ p, qty, disc }) => {
    const g = Math.round(p.price_cents * qty);
    gross += g;
    lineDisc += Math.min(Math.max(0, disc || 0), g);
  });
  const net = gross - lineDisc;
  let orderDisc = Math.round(parseFloat($('cart-discount').value || '0') * 100);
  if (!isFinite(orderDisc) || orderDisc < 0) orderDisc = 0;
  if (orderDisc > net) orderDisc = net;
  const raw = net - orderDisc;
  const total = round5js(raw);
  return { subtotal: gross, gross, lineDiscounts: lineDisc,
    discount: orderDisc, raw, total, rounding: total - raw };
}

function saveCart() {
  try {
    if (!cart.size) { localStorage.removeItem('pos2_cart'); return; }
    const items = [];
    cart.forEach(({ p, qty, disc }) => items.push({
      product_id: p.id, name: p.name, price_cents: p.price_cents,
      qty, disc: disc || 0, snap: !!p._snap,
    }));
    localStorage.setItem('pos2_cart', JSON.stringify({
      items, discount: $('cart-discount').value || '0',
    }));
  } catch (_) { /* storage unavailable */ }
}

function restoreCart() {
  try {
    const raw = localStorage.getItem('pos2_cart');
    if (!raw) return;
    const saved = JSON.parse(raw);
    (saved.items || []).forEach((it) => {
      const live = products.find((x) => x.id === it.product_id);
      if (live && !it.snap) {
        cart.set(it.product_id, { p: live, qty: it.qty, disc: it.disc || 0 });
      } else {
        cart.set(it.product_id, {
          p: { id: it.product_id, name: it.name,
               price_cents: it.price_cents, _snap: !!it.snap },
          qty: it.qty, disc: it.disc || 0,
        });
      }
    });
    if (saved.discount) $('cart-discount').value = saved.discount;
  } catch (_) { /* corrupted snapshot: start fresh */ }
}

function renderCart() {
  saveCart();
  const box = $('cart-items');
  box.innerHTML = '';
  if (!cart.size) box.innerHTML = '<div class="cart-empty">点左边商品加入购物车</div>';
  cart.forEach((entry) => {
    const { p, qty } = entry;
    const g = Math.round(p.price_cents * qty);
    const disc = Math.min(Math.max(0, entry.disc || 0), g);
    const row = document.createElement('div');
    row.className = 'citem';
    row.innerHTML =
      '<span class="cname">' + esc(p.name) + '<br><small>' + fmt(p.price_cents) +
      (disc ? ' → ' + fmt(g - disc) + '（−' + fmt(disc) + '）' : '') +
      '</small></span>' +
      '<button class="qtybtn">−</button><span>' + qty + '</span>' +
      '<button class="qtybtn">+</button>' +
      '<button class="qtybtn discbtn" title="行折扣">折</button>' +
      '<span class="cprice">' + fmt(g - disc) + '</span>';
    const [minus, plus] = row.querySelectorAll('.qtybtn');
    minus.onclick = () => {
      entry.qty -= 1;
      if (entry.qty <= 0) cart.delete(p.id); else cart.set(p.id, entry);
      renderCart();
    };
    plus.onclick = () => { entry.qty += 1; cart.set(p.id, entry); renderCart(); };
    row.querySelector('.discbtn').onclick = () => editLineDiscount(entry);
    box.appendChild(row);
  });
  const t = cartTotals();
  $('cart-count').textContent = cart.size ? '· ' + cart.size + ' 项' : '';
  $('cart-subtotal').textContent = fmt(t.subtotal);
  $('cart-linedisc-row').classList.toggle('hidden', !t.lineDiscounts);
  $('cart-linedisc').textContent = '−' + fmt(t.lineDiscounts);
  $('cart-round-row').classList.toggle('hidden', !t.rounding);
  $('cart-rounding').textContent =
    (t.rounding > 0 ? '+' : '−') + fmt(Math.abs(t.rounding));
  $('cart-total').textContent = fmt(t.total);
  $('checkout-btn').disabled = !cart.size;
}

/* ---------------- checkout ---------------- */
function openCheckout() {
  $('credit-deposit').value = '';
  depositMethod = 'CASH';
  document.querySelectorAll('.dmbtn').forEach((b) =>
    b.classList.toggle('active', b.dataset.dm === 'CASH'));
  payMethod = 'CASH';
  document.querySelectorAll('.pm').forEach((b) =>
    b.classList.toggle('active', b.dataset.method === 'CASH'));
  fillCustomerSelect();
  showPayPane();
  $('checkout-modal').classList.remove('hidden');
}

function showPayPane() {
  const t = cartTotals();
  const { total } = t;
  document.querySelectorAll('.pay-due').forEach((el) => { el.textContent = fmt(total); });
  $('credit-total').textContent = fmt(t.raw);
  $('cash-round-note').textContent = t.rounding
    ? '舍入 / Rounding: ' + (t.rounding > 0 ? '+' : '−') + fmt(Math.abs(t.rounding)) +
      '（原价 ' + fmt(t.raw) + '）'
    : '';
  $('pay-cash').classList.toggle('hidden', payMethod !== 'CASH');
  $('pay-qr').classList.toggle('hidden', payMethod !== 'DUITNOW');
  $('pay-card').classList.toggle('hidden', payMethod !== 'CARD');
  $('pay-credit').classList.toggle('hidden', payMethod !== 'CREDIT');
  if (payMethod === 'CREDIT') {
    updateCreditDue();
  }
  if (payMethod === 'CASH') {
    $('pay-paid').value = (total / 100).toFixed(2);
    updateChange();
  }
  if (payMethod === 'DUITNOW') {
    $('pay-qr-name').textContent = settings.store_name || '';
    const box = $('pay-qr-box');
    const payload = (settings.duitnow_qr_payload || '').trim();
    if (total <= 0) {
      box.innerHTML = '';
      $('pay-qr-note').textContent = '应付为 0，无需扫码，直接点确认收款。';
    } else if (payload && emvIsValid(payload)) {
      box.innerHTML = qrSvgSafe(emvBuildDynamic(payload, total), 5);
      $('pay-qr-note').textContent = '金额已锁定，请顾客扫码付款，付款后点确认收款。';
    } else if (payload) {
      box.innerHTML = qrSvgSafe(payload, 5);
      $('pay-qr-note').textContent = '静态收款码（未识别出动态载荷），请顾客自行输入金额。';
    } else {
      box.innerHTML = '';
      $('pay-qr-note').textContent = '还没导入收款码：请管理员到「设置 → DuitNow 收款码」导入，或让顾客扫店里的立牌码。';
    }
  }
}

function updateChange() {
  const { total } = cartTotals();
  const paid = Math.round(parseFloat($('pay-paid').value || '0') * 100);
  $('pay-change').textContent = fmt(Math.max(0, paid - total));
}

async function confirmSale(bankRef) {
  stopAuto();
  const t = cartTotals();
  const { total } = t;
  let paid;
  const customerId = $('co-customer').value
    ? parseInt($('co-customer').value) : null;
  const phone = $('co-phone').value.trim();
  if (payMethod === 'CASH') {
    paid = Math.round(parseFloat($('pay-paid').value || '0') * 100);
    if (!isFinite(paid) || paid < total) { toast('收款金额不足'); return; }
  } else if (payMethod === 'CREDIT') {
    if (!customerId) { toast('赊账必须先选择客户 / Credit requires a customer'); return; }
    paid = creditDepositCents();
    if (paid > t.raw) { toast('定金不能超过应付 / Deposit exceeds total'); return; }
  } else {
    paid = total;
  }
  // checkout-time stock re-check mirrors the till guard (warn policy asks)
  if ((settings.stock_policy || 'warn') !== 'block') {
    for (const { p, qty } of cart.values()) {
      if (!p._snap && typeof p.stock_qty === 'number' && qty > p.stock_qty) {
        if (!confirm('库存不足：' + p.name + '（有 ' + p.stock_qty + '）\n仍结账？')) return;
      }
    }
  }
  const items = [];
  cart.forEach(({ p, qty, disc }) => {
    const line = { product_id: p.id, qty };
    if (disc) line.discount_cents = Math.min(disc, Math.round(p.price_cents * qty));
    items.push(line);
  });
  const soldItems = items.slice();
  $('pay-confirm').disabled = true;
  try {
    const d = await api('/api/sales', {
      method: 'POST',
      body: JSON.stringify({
        items, method: payMethod,
        discount_cents: t.discount, paid_cents: paid,
        bank_ref: bankRef || '', customer_id: customerId,
        customer_phone: phone || undefined,
        deposit_method: payMethod === 'CREDIT' ? depositMethod : undefined,
      }),
    });
    pendingSale = Object.assign({}, d, { method: payMethod, paid_cents: paid });
    cart.clear();
    $('cart-discount').value = '0';
    $('checkout-modal').classList.add('hidden');
    renderCart();
    await loadCatalog();
    renderPos();
    // low-stock heads-up for what was just sold
    const lowNames = [];
    soldItems.forEach((it) => {
      const p = products.find((x) => x.id === it.product_id);
      if (!p) return;
      const thr = p.reorder_level > 0 ? p.reorder_level
        : (parseFloat(settings.low_stock_threshold || '10') || 10);
      if (p.stock_qty <= thr) lowNames.push(p.name + '（库存 ' + p.stock_qty + '）');
    });
    if (lowNames.length) toast('缺货提醒 / Low stock: ' + lowNames.join('、'), 4200);
    if (payMethod === 'CASH' && d.change_cents > 0) {
      $('change-lines').textContent =
        '收取 / Tendered ' + fmt(pendingSale.paid_cents) + '\n应付 / Due ' + fmt(d.total_cents);
      $('change-amt').textContent = fmt(d.change_cents);
      $('change-modal').classList.remove('hidden');
    } else {
      showSuccess();
    }
  } catch (e) {
    toast('结账失败：' + e.message);
  } finally {
    $('pay-confirm').disabled = false;
  }
}
function showSuccess() {
  if (!pendingSale) return;
  $('success-info').textContent = pendingSale.receipt_no + ' · ' +
    fmt(pendingSale.total_cents) + ' · ' +
    (METHOD_LABEL[pendingSale.method] || pendingSale.method || '');
  $('success-modal').classList.remove('hidden');
}

/* ---------------- products ---------------- */
function renderProducts() {
  const q = $('prod-search').value.trim().toLowerCase();
  const box = $('prod-list');
  box.innerHTML = '';
  products
    .filter((p) => !q || p.name.toLowerCase().includes(q) ||
      (p.barcode || '').includes(q))
    .forEach((p) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML =
        '<span class="grow"><span class="t">' + esc(p.name) + '</span>' +
        '<span class="s">' + esc(p.category_name || '未分类') +
        (p.barcode ? ' · ' + esc(p.barcode) : '') + '</span></span>' +
        (p.low_stock ? '<span class="badge low">低库存</span>' : '') +
        '<span class="s">库存 ' + p.stock_qty + '</span>' +
        '<span class="amt">' + fmt(p.price_cents) + '</span>';
      const eb = document.createElement('button');
      eb.className = 'replay'; eb.textContent = '编辑';
      eb.onclick = (ev) => { ev.stopPropagation(); openProduct(p); };
      row.appendChild(eb);
      row.onclick = () => openProduct(p);
      box.appendChild(row);
    });
  if (!box.children.length) box.innerHTML = '<div class="cart-empty">没有商品</div>';
}

function fillCatSelect(sel, value) {
  sel.innerHTML = '<option value="">未分类</option>';
  categories.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    if (value === c.id) o.selected = true;
    sel.appendChild(o);
  });
  if (value != null) sel.value = value;
}

let pendingProdImage = undefined; // undefined = unchanged, '' = delete, else base64

function productImageUrl(id) {
  return REL('/api/products/' + id + '/image') + '?token=' +
    encodeURIComponent(session ? session.token : '');
}

function openProduct(p) {
  pendingProdImage = undefined;
  const prev = $('prod-img-preview');
  if (p && p.has_image) {
    prev.src = productImageUrl(p.id);
    prev.classList.remove('hidden');
    $('prod-img-del').classList.remove('hidden');
  } else {
    prev.classList.add('hidden');
    $('prod-img-del').classList.add('hidden');
  }
  $('prod-modal-title').textContent = p ? '编辑商品' : '新增商品';
  $('prod-id').value = p ? p.id : '';
  $('prod-name').value = p ? p.name : '';
  $('prod-name-en').value = p ? (p.name_en || '') : '';
  fillCatSelect($('prod-cat'), p ? p.category_id : null);
  $('prod-price').value = p ? (p.price_cents / 100).toFixed(2) : '';
  $('prod-cost').value = p ? (p.cost_cents / 100).toFixed(2) : '';
  $('prod-barcode').value = p ? (p.barcode || '') : '';
  $('prod-sku').value = p ? (p.sku || '') : '';
  $('prod-stock').value = '';
  $('prod-stock').placeholder = p ? ('当前库存 ' + p.stock_qty + '，不填 = 不改') : '0';
  $('prod-reorder').value = p ? (p.reorder_level || 0) : 0;
  $('prod-active').checked = p ? !!p.is_active : true;
  const ro = !isAdmin();
  ['prod-name', 'prod-cat', 'prod-price', 'prod-cost', 'prod-barcode',
   'prod-sku', 'prod-stock', 'prod-active'].forEach((id) => { $(id).disabled = ro; });
  $('prod-save').classList.toggle('hidden', ro);
  const pdEl = $('prod-del');
  if (pdEl) pdEl.classList.toggle('hidden', !(p && isAdmin()));
  $('prod-img-btn').classList.toggle('hidden', ro);
  $('prod-label').classList.toggle('hidden', ro);
  if (ro) $('prod-img-del').classList.add('hidden');
  $('product-modal').classList.remove('hidden');
}

async function saveProduct() {
  const id = $('prod-id').value;
  const body = {
    name: $('prod-name').value.trim(),
    name_en: $('prod-name-en').value.trim(),
    reorder_level: parseFloat($('prod-reorder').value || '0') || 0,
    category_id: $('prod-cat').value ? parseInt($('prod-cat').value) : null,
    price_cents: Math.round(parseFloat($('prod-price').value || '0') * 100),
    cost_cents: Math.round(parseFloat($('prod-cost').value || '0') * 100),
    barcode: $('prod-barcode').value.trim(),
    sku: $('prod-sku').value.trim(),
    is_active: $('prod-active').checked,
  };
  if (!body.name) { toast('请填商品名称'); return; }
  if (body.price_cents < 0 || body.cost_cents < 0) {
    toast('售价和成本不能为负数'); return;
  }
  if (id) {
    body.id = parseInt(id);
    if ($('prod-stock').value !== '') body.stocktake = parseFloat($('prod-stock').value);
  } else {
    body.stock_qty = parseFloat($('prod-stock').value || '0');
  }
  try {
    const res = await api('/api/products', { method: 'POST', body: JSON.stringify(body) });
    if (pendingProdImage !== undefined) {
      await api('/api/products/' + (body.id || res.id) + '/image', {
        method: 'POST', body: JSON.stringify({ image_base64: pendingProdImage }),
      });
      pendingProdImage = undefined;
    }
    $('product-modal').classList.add('hidden');
    toast('已保存');
    await loadCatalog();
    renderProducts();
    renderPos();
  } catch (e) { toast('保存失败：' + e.message); }
}

/* ---------------- sales ---------------- */
function saleRowEl(s) {
  const row = document.createElement('div');
  row.className = 'li' + (s.is_void ? ' voided' : '');
  row.innerHTML =
    '<span class="grow"><span class="t">' + esc(s.receipt_no) + ' · ' +
    esc(s.method) + '</span>' +
    '<span class="s">' + esc((s.created_at || '').replace('T', ' ').slice(0, 19)) +
    ' · ' + esc(s.cashier || '') +
    (s.customer_name ? ' · ' + esc(s.customer_name) : '') +
    ((s.method === 'CREDIT' && !s.is_void && s.total_cents > s.paid_cents)
      ? ' · 欠 ' + fmt(s.total_cents - s.paid_cents) : '') +
    '</span></span>' +
    (s.is_void ? '<span class="badge void">已作废' +
      (s.void_note ? '：' + esc(s.void_note) : '') + '</span>' : '') +
    (s.is_training ? '<span class="badge train">训练</span>' : '') +
    '<span class="amt">' + fmt(s.total_cents) + '</span>';
  row.onclick = () => openSale(s.id);
  return row;
}

let salesPageNo = 0;
async function loadSales() {
  const q = encodeURIComponent($('sales-q').value.trim());
  const from = $('sales-from').value;
  const to = $('sales-to').value;
  let url = '/api/sales?limit=50&offset=' + (salesPageNo * 50);
  if (q) url += '&q=' + q;
  if (from) url += '&date_from=' + from;
  if (to) url += '&date_to=' + to;
  try {
    const d = await api(url);
    const box = $('sales-list');
    box.innerHTML = '';
    (d.items || []).forEach((s) => box.appendChild(saleRowEl(s)));
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">没有符合条件的销售</div>';
    $('sales-summary').textContent = '本页 ' + (d.items || []).length + ' 单';
    $('sales-page').textContent = '第 ' + (salesPageNo + 1) + ' 页';
    $('sales-prev').disabled = salesPageNo === 0;
    $('sales-next').disabled = (d.items || []).length < 50;
  } catch (e) { toast('载入销售失败：' + e.message); }
}

async function loadToday() {
  const day = new Date().toLocaleDateString('sv-SE');
  try {
    const d = await api('/api/sales?date=' + day + '&limit=200');
    const box = $('today-list');
    box.innerHTML = '';
    let sum = 0, count = 0;
    (d.items || []).forEach((s) => {
      if (s.is_void) return;  // the Today page excludes voided sales entirely
      box.appendChild(saleRowEl(s));
      if (!s.is_training) { sum += s.total_cents; count += 1; }
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">今天还没有销售</div>';
    $('today-summary').textContent = '今日 ' + count + ' 单 · ' + fmt(sum);
  } catch (e) { toast('载入今日销售失败：' + e.message); }
}

let lastSaleDetail = null;

async function openSale(id) {
  try {
    const d = await api('/api/sales/' + id);
    lastSaleDetail = d;
    currentSaleId = id;
    const s = d.sale;
    $('sale-title').textContent = '小票 ' + s.receipt_no;
    let html = '';
    (d.items || []).forEach((it) => {
      html += '<div class="row"><span>' + esc(it.name) + ' × ' + it.qty +
        '</span><span>' + fmt(it.line_total_cents) + '</span></div>';
    });
    if (s.discount_cents)
      html += '<div class="row"><span>折扣</span><span>−' + fmt(s.discount_cents) + '</span></div>';
    html += '<div class="row total"><span>总计</span><b>' + fmt(s.total_cents) + '</b></div>';
    html += '<div class="row"><span>方式</span><span>' + esc(s.method) +
      ' · ' + esc(s.cashier) + ' · ' + esc((s.created_at || '').replace('T', ' ').slice(0, 19)) +
      '</span></div>';
    if (s.is_void) html += '<div class="row"><span></span><span class="badge void">已作废</span></div>';
    $('sale-body').innerHTML = html;
    $('sale-void').classList.toggle('hidden',
      !!s.is_void || !session || session.user.role !== 'ADMIN');
    $('sale-modal').classList.remove('hidden');
  } catch (e) { toast('载入小票失败：' + e.message); }
}

async function voidSale() {
  if (!currentSaleId) return;
  if (!confirm('确定作废这一单？库存会加回去。')) return;
  const note = prompt('作废备注（可留空）：', '');
  if (note === null) return;
  try {
    await api('/api/sales/' + currentSaleId + '/void', {
      method: 'POST', body: JSON.stringify({ note: note.trim() }),
    });
    $('sale-modal').classList.add('hidden');
    toast('已作废');
    await loadCatalog();
    loadSales();
  } catch (e) { toast('作废失败：' + e.message); }
}

/* ---------------- settings ---------------- */
function renderQrStatus() {
  const payload = (settings.duitnow_qr_payload || '').trim();
  const box = $('qr-status');
  if (!box) return;
  if (payload) {
    box.textContent = '✅ 已设置：' + (emvTag(payload, '59') || 'DuitNow');
    $('qr-preview').innerHTML = qrSvgSafe(payload);
    // Removing the shop's QR is admin-only (mirrors the server gate).
    $('qr-clear').classList.toggle('hidden', !isAdmin());
  } else {
    box.textContent = '未设置';
    $('qr-preview').innerHTML = '';
    $('qr-clear').classList.add('hidden');
  }
}
function renderSettings() {
  const ro = !isAdmin();
  ['set-store-name', 'set-store-address', 'set-store-phone',
   'set-receipt-header', 'set-receipt-footer', 'set-receipt-notes',
   'set-receipt-width', 'set-low-stock', 'set-hold-timeout',
   'set-stock-policy', 'set-scan-feedback', 'set-training',
   'set-images-enabled', 'set-bt-enabled', 'set-show-sku',
   'set-show-cashier', 'set-show-datetime', 'set-show-payment',
   'set-show-change', 'set-show-discount', 'set-show-unit-price',
   'set-show-qty', 'set-show-qr'].forEach((id) => { $(id).disabled = ro; });
  $('set-save').classList.toggle('hidden', ro);
  $('qr-import').classList.toggle('hidden', ro);
  if (ro) $('qr-clear').classList.add('hidden');
  $('set-store-name').value = settings.store_name || '';
  $('set-store-address').value = settings.store_address || '';
  $('set-store-phone').value = settings.store_phone || '';
  $('set-receipt-header').value = settings.receipt_header || '';
  $('set-receipt-footer').value = settings.receipt_footer || '';
  $('set-receipt-notes').value = settings.receipt_notes || '';
  $('set-receipt-width').value = settings.receipt_char_width || '40';
  const setChk = (id, key, dflt) => {
    $(id).checked = (settings[key] === undefined ? dflt : settings[key]) === '1';
  };
  setChk('set-show-sku', 'receipt_show_sku', '1');
  setChk('set-show-cashier', 'receipt_show_cashier', '1');
  setChk('set-show-datetime', 'receipt_show_datetime', '1');
  setChk('set-show-payment', 'receipt_show_payment', '1');
  setChk('set-show-change', 'receipt_show_change', '1');
  setChk('set-show-discount', 'receipt_show_discount', '1');
  setChk('set-show-unit-price', 'receipt_show_unit_price', '1');
  setChk('set-show-qty', 'receipt_show_qty', '1');
  setChk('set-show-qr', 'receipt_show_duitnow_qr', '0');
  setChk('set-images-enabled', 'product_images_enabled', '0');
  setChk('set-bt-enabled', 'bt_printer_enabled', '0');
  $('set-training').checked = settings.training_mode === '1';
  $('set-stock-policy').value = settings.stock_policy || 'warn';
  $('set-scan-feedback').value = settings.scan_feedback || 'beep';
  $('set-hold-timeout').value = settings.hold_timeout_minutes || '30';
  $('set-low-stock').value =
    (settings.low_stock_threshold === undefined || settings.low_stock_threshold === '')
      ? '10' : settings.low_stock_threshold;
  renderQrStatus();
  renderReceiptPreview();
  $('export-card').classList.toggle('hidden', session.user.role !== 'ADMIN');
}
async function saveSettings() {
  const body = Object.assign(formSettings(), {
    low_stock_threshold: $('set-low-stock').value.trim() || '10',
    stock_policy: $('set-stock-policy').value,
    hold_timeout_minutes: $('set-hold-timeout').value.trim() || '30',
    scan_feedback: $('set-scan-feedback').value,
    product_images_enabled: $('set-images-enabled').checked ? '1' : '0',
    bt_printer_enabled: $('set-bt-enabled').checked ? '1' : '0',
    training_mode: $('set-training').checked ? '1' : '0',
  });
  delete body.duitnow_qr_payload;
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ settings: body }) });
    await refreshSettings();
    renderReceiptPreview();
    toast('设置已保存（服务器）');
  } catch (e) { toast('保存失败：' + e.message); }
}

/* Downscale a picked photo before upload: phone originals are often
   8-15 MB, which the decode endpoints reject. 1600px is plenty for the
   server decoder (verified against the shop's own QR standee). */
async function fileToJpegBase64(file, maxDim) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = rej; img.src = url;
    });
    const scale = Math.min(1, (maxDim || 1600) / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.width * scale));
    cv.height = Math.max(1, Math.round(img.height * scale));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.88).split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}
async function fileToRawBase64(file) {
  const buf = await file.arrayBuffer();
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 8192)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}
async function imageForDecode(file, maxDim) {
  try {
    return await fileToJpegBase64(file, maxDim);
  } catch (_) {
    if (file.size > 8 * 1024 * 1024) throw new Error('图片太大且无法压缩，请换一张较小的图片');
    return fileToRawBase64(file);
  }
}
async function importQr(file) {
  if (!file) return;
  try {
    const b64 = await imageForDecode(file, 1600);
    const d = await api('/api/qr/decode', {
      method: 'POST', body: JSON.stringify({ image_base64: b64 }),
    });
    const payload = (d.payload || '').trim();
    if (!payload || !emvIsValid(payload)) { toast('这张图识别出的不是有效的 DuitNow 码'); return; }
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ settings: { duitnow_qr_payload: payload } }),
    });
    await refreshSettings();
    renderQrStatus();
    toast('✅ 收款码已保存到服务器：' + (emvTag(payload, '59') || ''));
  } catch (e) { toast('导入失败：' + e.message); }
}

let knownUsers = {};
let editingUser = '';

async function loadUsers() {
  try {
    const d = await api('/api/users');
    knownUsers = {};
    const box = $('users-list');
    box.innerHTML = '';
    (d.users || []).forEach((u) => {
      knownUsers[u.username] = u;
      const row = document.createElement('div');
      row.className = 'li' + (u.username === editingUser ? ' sel' : '');
      row.dataset.username = u.username;
      row.innerHTML =
        '<span class="grow"><span class="t">' + esc(u.display_name || u.username) +
        '</span><span class="s">' + esc(u.username) + ' · ' +
        (u.has_pin ? '已设 PIN' : '未设 PIN') + (u.is_active ? '' : ' · 已停用') +
        '</span></span>' +
        (u.role === 'ADMIN' ? '<span class="badge admin">管理员</span>' : '<span class="badge">员工</span>');
      row.addEventListener('click', () => selectUser(u.username));
      box.appendChild(row);
    });
  } catch (_) { /* staff cannot list users */ }
}

function selectUser(username) {
  const u = knownUsers[username];
  if (!u) return;
  editingUser = username;
  $('new-username').value = u.username;
  $('new-display').value = u.display_name || '';
  $('new-pin').value = '';
  $('new-role').value = u.role;
  $('new-active').value = u.is_active ? '1' : '0';
  document.querySelectorAll('#users-list .li').forEach((el) =>
    el.classList.toggle('sel', el.dataset.username === username));
}

function clearUserForm() {
  editingUser = '';
  $('new-username').value = '';
  $('new-display').value = '';
  $('new-pin').value = '';
  $('new-role').value = 'STAFF';
  $('new-active').value = '1';
  document.querySelectorAll('#users-list .li').forEach((el) => el.classList.remove('sel'));
}

async function saveUser() {
  const username = $('new-username').value.trim();
  const pin = $('new-pin').value.trim();
  if (!username) { toast('请填账号'); return; }
  if (pin && !/^\d{6,12}$/.test(pin)) { toast('PIN 必须是 6–12 位数字'); return; }
  const isNew = !knownUsers[username];
  if (isNew && !pin) { toast('新账号必须设置 PIN'); return; }
  if (!isNew && pin && session && username === session.user.username &&
      !window.confirm('你正在修改自己（当前登录管理员）的 PIN，改完下次登录要用新 PIN。确定修改？')) return;
  const body = {
    username,
    display_name: $('new-display').value.trim(),
    role: $('new-role').value,
  };
  if (pin) body.pin = pin;
  if (!isNew) body.is_active = $('new-active').value === '1' ? 1 : 0;
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify(body) });
    toast(isNew ? '已新增账号 ' + username : '已更新账号 ' + username);
    clearUserForm();
    loadUsers();
  } catch (e) { toast('保存账号失败：' + e.message); }
}

/* ---------------- wiring ---------------- */
/* ---------------- data export ------------------------------------------ */
async function downloadApi(path, filename) {
  try {
    const res = await fetch(BASE_PATH + 'api' + path, {
      headers: session ? { Authorization: 'Bearer ' + session.token } : {},
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.status);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast('导出失败：' + e.message); }
}
document.querySelectorAll('#exp-sales,#exp-products,#exp-payments,#exp-backup')
  .forEach((b) => b.addEventListener('click', () => {
    if (b.id === 'exp-sales') {
      const ym = localDateStr(new Date()).slice(0, 7);
      downloadApi(`/export/sales.csv?date_from=${ym}-01&date_to=${ym}-31`, 'sales.csv');
    } else if (b.id === 'exp-products') downloadApi('/export/products.csv', 'products.csv');
    else if (b.id === 'exp-payments') downloadApi('/export/payments.csv', 'payments.csv');
    else downloadApi('/export/backup.json', 'pos2-backup.json');
  }));


/* ---------------- dashboard ---------------- */
async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    const cards = [
      ['今日销售额', fmt(d.sales_total_cents)],
      ['现金 Cash', fmt(d.cash_cents)],
      ['卡 Card', fmt(d.card_cents)],
      ['DuitNow', fmt(d.duitnow_cents)],
      ['今日赊账余额', fmt(d.credit_today_cents)],
      ['全部未清赊账', fmt(d.credit_open_cents)],
      ['单数 Tickets', String(d.tickets)],
    ];
    $('dash-cards').innerHTML = cards.map((c) =>
      '<div class="scard"><div class="k">' + c[0] +
      '</div><div class="v">' + c[1] + '</div></div>').join('');
  } catch (e) { toast('载入主页失败：' + e.message); }
}

/* ---------------- stocktake page ---------------- */
function renderStocktake() {
  const q = ($('stk-search').value || '').trim().toLowerCase();
  const box = $('stk-list');
  box.innerHTML = '';
  products.filter((pr) => !q ||
      pr.name.toLowerCase().includes(q) ||
      (pr.name_en || '').toLowerCase().includes(q) ||
      (pr.sku || '').toLowerCase().includes(q) ||
      (pr.barcode || '').toLowerCase().includes(q))
    .slice(0, 50).forEach((pr) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow"><span class="t">' + esc(pr.name) +
        '</span><span class="s">账面 ' + pr.stock_qty + ' ' + esc(pr.unit || '') +
        '</span></span>' +
        '<input type="number" step="any" class="stk-input" value="' + pr.stock_qty + '">' +
        '<button class="btn small">保存实盘</button>';
      const input = row.querySelector('.stk-input');
      row.querySelector('button').onclick = async () => {
        const v = parseFloat(input.value);
        if (isNaN(v) || v < 0) { toast('实盘数量无效'); return; }
        try {
          await api('/api/products', { method: 'POST', body: JSON.stringify(
            { id: pr.id, name: pr.name, stocktake: v }) });
          toast('已盘点：' + pr.name + ' → ' + v);
          await loadCatalog();
          renderStocktake();
        } catch (e) { toast('盘点失败：' + e.message); }
      };
      box.appendChild(row);
    });
  if (!box.children.length)
    box.innerHTML = '<div class="cart-empty">没有匹配的商品</div>';
}

/* ---------------- categories page ---------------- */
function renderCategoriesPage() {
  const box = $('cat-list');
  box.innerHTML = '';
  categories.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'li';
    row.innerHTML = '<span class="grow"><span class="t">' + esc(c.name) +
      '</span></span>' +
      '<button class="btn small" data-act="rename">改名</button>' +
      '<button class="btn small danger" data-act="del">删除</button>';
    row.querySelector('[data-act="rename"]').onclick = async () => {
      const name = prompt('分类新名称', c.name);
      if (!name || !name.trim() || name.trim() === c.name) return;
      try {
        await api('/api/categories', { method: 'POST',
          body: JSON.stringify({ id: c.id, name: name.trim() }) });
        await loadCatalog(); renderCategoriesPage(); renderPos();
        toast('分类已改名');
      } catch (e) { toast('改名失败：' + e.message); }
    };
    row.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm('删除分类「' + c.name + '」？该分类的商品会变为未分类（商品不会被删）。')) return;
      try {
        await api('/api/categories/' + c.id, { method: 'DELETE' });
        await loadCatalog(); renderCategoriesPage(); renderPos();
        toast('分类已删除');
      } catch (e) { toast('删除失败：' + e.message); }
    };
    box.appendChild(row);
  });
  if (!box.children.length)
    box.innerHTML = '<div class="cart-empty">还没有分类</div>';
}

/* ---------------- barcode queue page ---------------- */
async function loadBarcodeQueue() {
  try {
    const d = await api('/api/barcode-queue');
    const box = $('bq-list');
    box.innerHTML = '';
    (d.items || []).forEach((it) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow"><span class="t">' + esc(it.product_name) +
        '</span><span class="s">' + esc(it.barcode) + ' × ' + it.copies +
        '</span></span>' +
        '<button class="btn small" data-act="print">打印</button>' +
        '<button class="btn small" data-act="done">已打印</button>' +
        '<button class="btn small danger" data-act="del">删除</button>';
      row.querySelector('[data-act="print"]').onclick = () =>
        printLabelsHtml(labelHtml(it.product_name, it.barcode).repeat(it.copies));
      row.querySelector('[data-act="done"]').onclick = async () => {
        await api('/api/barcode-queue/' + it.id + '/done', { method: 'POST' });
        loadBarcodeQueue();
      };
      row.querySelector('[data-act="del"]').onclick = async () => {
        await api('/api/barcode-queue/' + it.id, { method: 'DELETE' });
        loadBarcodeQueue();
      };
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">队列是空的 — 在商品编辑里点「加入条码队列」</div>';
    $('bq-print-all').onclick = () => {
      let html = '';
      (d.items || []).forEach((it) => {
        html += labelHtml(it.product_name, it.barcode).repeat(it.copies);
      });
      if (html) printLabelsHtml(html); else toast('队列是空的');
    };
  } catch (e) { toast('载入条码队列失败：' + e.message); }
}

/* ---------------- discount audit page ---------------- */
async function loadAudit() {
  const today = $('audit-today').checked ? 1 : 0;
  const user = encodeURIComponent($('audit-user').value.trim());
  try {
    const d = await api('/api/audit?today=' + today +
      (user ? '&username=' + user : '') + '&limit=50');
    const box = $('audit-list');
    box.innerHTML = '';
    (d.items || []).forEach((a) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow"><span class="t">' +
        esc(a.action === 'line_discount' ? '行折扣' : '整单折扣') +
        (a.product_name ? ' · ' + esc(a.product_name) : '') + '</span>' +
        '<span class="s">' + esc((a.occurred_at || '').replace('T', ' ').slice(0, 19)) +
        ' · ' + esc(a.username) + '（' + esc(a.role) + '）</span></span>' +
        '<span class="amt">' + esc(a.old_value) + ' → ' + esc(a.new_value) +
        (a.reason ? ' · ' + esc(a.reason) : '') + '</span>';
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">没有折扣审计记录</div>';
  } catch (e) { toast('载入审计失败：' + e.message); }
}

/* ---------------- maintenance / wipe ---------------- */
const WIPE_CATS = [
  ['sales', '销售记录'], ['purchases', '采购记录'],
  ['payments', '收款记录 / 到账账本'], ['stock_moves', '库存流水'],
  ['held_orders', '挂单'], ['daily_closings', '日结记录'],
  ['einvoices', 'e-Invoice 记录'], ['products', '商品'],
  ['customers', '客户'], ['suppliers', '供应商'],
  ['categories', '商品分类'], ['audit', '审计日志与条码队列'],
  ['stock_zero', '库存数量清零（保留商品）'],
];
function renderWipeCats() {
  const box = $('wipe-cats');
  if (!box || box.children.length) return;
  box.innerHTML = WIPE_CATS.map((c) =>
    '<label class="check-row"><input type="checkbox" value="' + c[0] + '"> ' +
    c[1] + '</label>').join('');
}
function wipeCountsText(counts) {
  return Object.keys(counts).map((k) => {
    const c = WIPE_CATS.find((x) => x[0] === k);
    return (c ? c[1] : k) + '：' + counts[k];
  }).join('；');
}
async function runWipe(cats, dry) {
  return api('/api/admin/wipe', { method: 'POST',
    body: JSON.stringify({ categories: cats, dry_run: dry }) });
}
async function wipeFlow(cats) {
  if (!cats.length) { toast('先勾选要清零的类别'); return; }
  try {
    const dry = await runWipe(cats, true);
    if (!confirm('将清零以下数据，确定？\n' + wipeCountsText(dry.counts))) return;
    const done = await runWipe(cats, false);
    $('wipe-result').textContent = '已清零：' + wipeCountsText(done.counts);
    toast('清零完成');
    await loadCatalog(); renderPos();
  } catch (e) { toast('清零失败：' + e.message); }
}

/* ---------------- training ---------------- */
const TRAINING_LESSONS = [
  ['1 · 登录与权限', '开机后选自己的账号输 PIN 登录。管理员能进「管理」中心改商品、作废、清零；员工负责日常收银。连错 5 次 PIN 会锁定 5 分钟。'],
  ['2 · 商品销售', '在收银页点商品卡加入购物车（或用搜索/分类筛选），数量用 +/− 调整；手指往下滚时商品架会收起，合计与结账键始终在底部。总价有变动先跟顾客确认再结账。'],
  ['3 · 收款', '结账选付款方式：现金输实收看找零；DuitNow 出示动态码（金额已锁定），顾客付完系统会自动对账入账（5 秒内可点「不是这单」）；刷卡在刷卡机完成后再确认。赊账必须选客户，可先收定金并选定金方式。非赊账金额按 5 仙规则舍入。'],
  ['4 · 退款（作废）', '退款 = 管理员在销售记录里把原单作废（要填备注），库存自动回滚。已提交 e-Invoice 的单作废前先与管理员核对发票状态。'],
  ['5 · 库存', '销售自动扣库存，进货自动加库存，盘点页可逐个商品填实盘数校正。库存不足时系统会提醒；设为「禁止」策略时不足不能卖。'],
  ['6 · 手机连接（服务器）', '本系统所有设备打开同一个服务器地址即是同一套数据，无需配对：手机、平板、电脑浏览器打开 http://43.156.169.203/pos2/ 登录即可。'],
  ['7 · 数据同步', '服务器是唯一主本：任何设备做的销售、改价、盘点即时写到服务器，其他设备自动刷新，不需要手动同步。'],
  ['8 · 数据备份', '管理员在设置 → 数据导出可导出销售/商品/收款 CSV 与全量备份 JSON；开业前清零在「管理 → 维护」，先算影响再执行。'],
  ['9 · e-Invoice 设置', 'e-Invoice 需要 MyInvois 凭证在服务器配置；未配置前所有单据状态为 Pending，不影响正常收银。'],
  ['10 · e-Invoice 提交', '配置凭证后系统按单提交，可在设置 → e-Invoice 状态查看每单进度（Pending / Submitted / Validated / Rejected）。'],
  ['11 · 常见错误处理', '播报没声音：先检查设备没静音、页面保持打开；到账没自动入账：核对金额是否与应付完全一致；登录被锁：等 5 分钟；二维码导入失败：换一张更清晰、正对无反光的照片。'],
];
function renderTraining() {
  const box = $('training-lessons');
  if (!box || box.children.length) return;
  box.innerHTML = TRAINING_LESSONS.map((l) =>
    '<details class="lesson"><summary>' + esc(l[0]) + '</summary><p>' +
    esc(l[1]) + '</p></details>').join('');
}

/* ---------------- e-invoice status ---------------- */
const EINVOICE_LABELS = { pending: 'Pending', submitting: 'Pending · 核对中',
  submitted: 'Submitted', validated: 'Validated', rejected: 'Rejected',
  invalid: 'Invalid', cancelled: 'Cancelled', needs_review: '待核对' };
async function loadEinvoice() {
  renderTraining();
  try {
    const env = $('einvoice-env').value;
    const d = await api('/api/einvoice-status?environment=' + env);
    const box = $('einvoice-list');
    box.innerHTML = '';
    (d.items || []).forEach((r) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow"><span class="t">' + esc(r.receipt_no) +
        '</span><span class="s">' +
        (r.updated_at ? esc(r.updated_at.replace('T', ' ').slice(0, 19))
                      : '等待系统处理') +
        (r.is_void ? ' · 销售已作废，请向管理员核对 e-Invoice' : '') +
        '</span></span><span class="amt">' +
        esc(EINVOICE_LABELS[r.status] || r.status) + '</span>';
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">还没有销售记录</div>';
  } catch (e) { toast('载入 e-Invoice 状态失败：' + e.message); }
}


/* ---------------- e-receipt (PDF share) ---------------- */
async function canvasToPdfBlob(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
  }
  const stream = new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'));
  const comp = new Uint8Array(await new Response(stream).arrayBuffer());
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (bytes) => {
    const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
    parts.push(b); size += b.length;
  };
  push('%PDF-1.4\n');
  const obj = (n, body) => { offsets[n] = size; push(n + ' 0 obj\n' + body + '\nendobj\n'); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const pw = Math.round(w * 0.6), ph = Math.round(h * 0.6);
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph +
    '] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>');
  const content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im1 Do Q';
  obj(4, '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
  offsets[5] = size;
  push('5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
    ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' +
    comp.length + ' >>\nstream\n');
  push(comp);
  push('\nendstream\nendobj\n');
  const xref = size;
  let tail = 'xref\n0 6\n0000000000 65535 f \n';
  for (let n = 1; n <= 5; n++)
    tail += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';
  tail += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  push(tail);
  return new Blob(parts, { type: 'application/pdf' });
}
function receiptCanvas(sale, items, st) {
  st = st || settings;
  const lines = renderReceiptLines(sale, items, st);
  const W = Math.min(64, Math.max(24,
    parseInt(st.receipt_char_width || '40', 10) || 40));
  const fs = 26, lh = 40, pad = 20;
  const cv = document.createElement('canvas');
  const probe = cv.getContext('2d');
  probe.font = fs + 'px "Courier New", monospace';
  const cw = probe.measureText('M').width;
  cv.width = Math.ceil(W * cw) + pad * 2;
  cv.height = lines.length * lh + pad * 2;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'middle';
  const lat = fs + 'px "Courier New", monospace';
  const cjk = fs + 'px "PingFang SC", "Microsoft YaHei", sans-serif';
  // Draw every character into its own grid cell, so Latin digits and
  // Chinese characters can never drift out of column on any device.
  lines.forEach((ln, i) => {
    const y = pad + i * lh + lh / 2;
    let col = 0;
    for (const ch of ln) {
      if (ch === ' ') { col += 1; continue; }
      if (ch.codePointAt(0) > 255) {
        ctx.font = cjk;
        ctx.fillText(ch, pad + col * cw + Math.max(0, (2 * cw - fs) / 2), y);
        col += 2;
      } else {
        ctx.font = lat;
        ctx.fillText(ch, pad + col * cw, y);
        col += 1;
      }
    }
  });
  return cv;
}
async function shareEReceipt(saleId) {
  try {
    const d = await api('/api/sales/' + saleId);
    const sale = d.sale;
    const items = d.items || [];
    if (!sale.customer_phone) {
      const phone = prompt('电子收据手机号 / Phone（电子收据）', '');
      if (phone === null) return;
      if (phone.trim()) {
        sale.customer_phone = phone.trim();
        if (!sale.customer_id && confirm('保存为客户？')) {
          const name = prompt('客户姓名 / Name', sale.customer_name || '');
          if (name && name.trim()) {
            await api('/api/customers', { method: 'POST', body: JSON.stringify(
              { name: name.trim(), phone: phone.trim() }) });
          }
        }
      }
    }
    const blob = await canvasToPdfBlob(receiptCanvas(sale, items));
    const file = new File([blob], 'CNKH_' + sale.receipt_no + '.pdf',
      { type: 'application/pdf' });
    const caption = (settings.store_name || 'CNKH POS') +
      '\n电子收据 PDF / E-Receipt PDF\n单号 / No: ' + sale.receipt_no +
      '\n请查看附件收据 / Please see attached receipt PDF.';
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: caption });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('收据 PDF 已下载，可手动发送给顾客');
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('电子收据失败：' + e.message);
  }
}

/* ---------------- purchase cost-rise alerts ---------------- */
function showCostAlerts(alerts) {
  if (!alerts || !alerts.length) return;
  $('cost-alert-list').innerHTML = alerts.map((a) =>
    '<div class="li"><span class="grow"><span class="t">' + esc(a.name) +
    '</span><span class="s">成本 ' + fmt(a.old_cost_cents) + ' → ' +
    fmt(a.new_cost_cents) + '（+' + a.pct + '%）</span>' +
    (a.new_margin_pct != null
      ? '<span class="s">售价 ' + fmt(a.price_cents) + ' · 毛利 ' +
        a.old_margin_pct + '% → ' + a.new_margin_pct + '%</span>' : '') +
    '</span></div>').join('');
  $('cost-alert-modal').classList.remove('hidden');
}

/* ---------------- monthly report + PDF export ---------------- */
let lastMonthly = null;

async function loadMonthly() {
  const el = $('mr-month');
  if (!el.value) el.value = localDateStr(new Date()).slice(0, 7);
  const body = $('mr-body');
  body.innerHTML = '<div class="cart-empty">载入中…</div>';
  try {
    const d = await api('/api/reports/monthly?month=' +
      encodeURIComponent(el.value));
    lastMonthly = d;
    const mg = d.margin || {};
    let h = '<div class="summary-cards">' +
      '<div class="scard"><div class="k">本月营业额</div><div class="v">' +
      fmt(d.total_cents) + '</div><div class="k">' + d.sales_count +
      ' 单 · 均单 ' + fmt(d.avg_cents) + '</div></div>' +
      '<div class="scard"><div class="k">估算毛利</div><div class="v">' +
      (mg.covered_cents > 0 ? fmt(mg.profit_cents) : '—') +
      '</div><div class="k">' +
      (mg.covered_cents > 0 ? '按销售行成本快照估算' : '暂无成本快照数据') +
      '</div></div>' +
      '<div class="scard"><div class="k">本月折扣</div><div class="v">' +
      fmt(d.discount_cents) + '</div></div>' +
      '<div class="scard"><div class="k">赊账销售 / 本月还款</div>' +
      '<div class="v">' + fmt(d.credit.total_cents) + ' / ' +
      fmt(d.credit.repaid_cents) + '</div><div class="k">' +
      d.credit.sales_count + ' 笔赊账单</div></div>' +
      '<div class="scard"><div class="k">本月进货</div><div class="v">' +
      fmt(d.purchases.total_cents) + '</div><div class="k">' +
      d.purchases.count + ' 笔采购</div></div></div>';
    h += '<h4 class="sec-title">每日明细</h4>';
    if (!d.by_day.length)
      h += '<div class="cart-empty">本月还没有销售</div>';
    d.by_day.forEach((x) => {
      const parts = Object.keys(x.methods || {}).map((k) =>
        (METHOD_LABEL[k] || k) + ' ' + fmt(x.methods[k])).join(' · ');
      h += '<div class="li"><span class="grow"><span class="t">' +
        esc(x.day) + '</span><span class="s">' + x.n + ' 单' +
        (parts ? ' · ' + esc(parts) : '') +
        '</span></span><span class="amt">' + fmt(x.total_cents) +
        '</span></div>';
    });
    if (d.top_products && d.top_products.length) {
      h += '<h4 class="sec-title">本月热销</h4>';
      d.top_products.forEach((x) => {
        h += '<div class="li"><span class="grow">' + esc(x.name) +
          ' × ' + x.qty + '</span><span class="amt">' + fmt(x.total) +
          '</span></div>';
      });
    }
    body.innerHTML = h;
  } catch (e) {
    body.innerHTML = '<div class="cart-empty">月报载入失败：' +
      esc(e.message) + '</div>';
  }
}

async function canvasesToPdfBlob(canvases) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = {};
  let size = 0;
  const push = (b) => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b;
    parts.push(bytes); size += bytes.length;
  };
  const obj = (n, body) => {
    offsets[n] = size;
    push(n + ' 0 obj\n' + body + '\nendobj\n');
  };
  push('%PDF-1.4\n');
  const count = canvases.length;
  const kids = canvases.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [' + kids + '] /Count ' + count + ' >>');
  for (let i = 0; i < count; i++) {
    const cv = canvases[i];
    const w = cv.width, hgt = cv.height;
    const data = cv.getContext('2d').getImageData(0, 0, w, hgt).data;
    const rgb = new Uint8Array(w * hgt * 3);
    for (let a = 0, j = 0; a < data.length; a += 4, j += 3) {
      rgb[j] = data[a]; rgb[j + 1] = data[a + 1]; rgb[j + 2] = data[a + 2];
    }
    const stream = new Blob([rgb]).stream()
      .pipeThrough(new CompressionStream('deflate'));
    const comp = new Uint8Array(await new Response(stream).arrayBuffer());
    const pw = 595, ph = Math.round(595 * hgt / w);
    const pObj = 3 + i * 3, cObj = pObj + 1, iObj = pObj + 2;
    obj(pObj, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' +
      ph + '] /Resources << /XObject << /Im' + i + ' ' + iObj +
      ' 0 R >> >> /Contents ' + cObj + ' 0 R >>');
    const content = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im' + i + ' Do Q';
    obj(cObj, '<< /Length ' + content.length + ' >>\nstream\n' +
      content + '\nendstream');
    offsets[iObj] = size;
    push(iObj + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w +
      ' /Height ' + hgt + ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
      ' /Filter /FlateDecode /Length ' + comp.length + ' >>\nstream\n');
    push(comp);
    push('\nendstream\nendobj\n');
  }
  const total = 3 + count * 3;
  const xref = size;
  let tail = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
  for (let k = 1; k < total; k++)
    tail += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  tail += 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' +
    xref + '\n%%EOF';
  push(tail);
  return new Blob(parts, { type: 'application/pdf' });
}

function monthlyReportCanvases(d) {
  const W = 1240, H = 1754, M = 70, RIGHT = W - M;
  const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
  const store = (settings.store_name || 'CNKH POS');
  const rows = [];
  const title = (t) => rows.push({ h: 64, draw(ctx, y) {
    ctx.font = '700 40px ' + FONT; ctx.fillStyle = '#111';
    ctx.textAlign = 'left'; ctx.fillText(t, M, y + 42);
  } });
  const sub = (t) => rows.push({ h: 36, draw(ctx, y) {
    ctx.font = '24px ' + FONT; ctx.fillStyle = '#666';
    ctx.textAlign = 'left'; ctx.fillText(t, M, y + 26);
  } });
  const section = (t) => rows.push({ h: 56, draw(ctx, y) {
    ctx.font = '700 29px ' + FONT; ctx.fillStyle = '#111';
    ctx.textAlign = 'left'; ctx.fillText(t, M, y + 38);
    ctx.fillStyle = '#999'; ctx.fillRect(M, y + 48, RIGHT - M, 2);
  } });
  const kv = (k, v, bold) => rows.push({ h: 44, draw(ctx, y) {
    ctx.font = (bold ? '700 ' : '') + '27px ' + FONT;
    ctx.fillStyle = '#333'; ctx.textAlign = 'left';
    ctx.fillText(k, M, y + 30);
    ctx.fillStyle = '#111'; ctx.textAlign = 'right';
    ctx.fillText(v, RIGHT, y + 30);
  } });
  const cols = (c1, c2, c3) => rows.push({ h: 42, draw(ctx, y) {
    ctx.font = '25px ' + FONT; ctx.fillStyle = '#333';
    ctx.textAlign = 'left'; ctx.fillText(c1, M, y + 29);
    ctx.textAlign = 'center'; ctx.fillText(c2, M + (RIGHT - M) * 0.58, y + 29);
    ctx.fillStyle = '#111'; ctx.textAlign = 'right';
    ctx.fillText(c3, RIGHT, y + 29);
  } });
  const gap = (hgt) => rows.push({ h: hgt, draw() {} });

  title(store + ' · 月报表');
  sub(d.month + ' 月度报表 · 生成于 ' +
    new Date().toLocaleString('sv-SE').slice(0, 16) + ' · 不含作废与训练单');
  gap(10);
  section('概览');
  kv('营业额', fmt(d.total_cents), true);
  kv('销售单数 · 均单', d.sales_count + ' 单 · ' + fmt(d.avg_cents));
  kv('折扣总额', fmt(d.discount_cents));
  kv('估算毛利（成本快照）',
    d.margin && d.margin.covered_cents > 0
      ? fmt(d.margin.profit_cents) : '—');
  kv('赊账销售（' + d.credit.sales_count + ' 笔）', fmt(d.credit.total_cents));
  kv('本月收回还款', fmt(d.credit.repaid_cents));
  kv('本月进货（' + d.purchases.count + ' 笔）', fmt(d.purchases.total_cents));
  section('按收款方式');
  (d.by_method || []).forEach((x) => kv(
    (METHOD_LABEL[x.method] || x.method) + ' · ' + x.n + ' 单',
    fmt(x.total)));
  if (!(d.by_method || []).length) kv('（本月无销售）', '');
  section('每日明细');
  cols('日期', '单数', '营业额');
  (d.by_day || []).forEach((x) =>
    cols(x.day, String(x.n), fmt(x.total_cents)));
  if (!(d.by_day || []).length) kv('（本月无销售）', '');
  section('热销商品 Top 10');
  (d.top_products || []).forEach((x, i) =>
    cols((i + 1) + '. ' + x.name, '× ' + x.qty, fmt(x.total)));
  gap(16);
  sub('注：赊账按全额计入营业额；毛利按每笔销售行存档的成本快照估算，' +
    '早期无快照的销售不计入毛利。');

  const pages = [];
  let cv = null, ctx = null, y = 0;
  const newPage = () => {
    cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    ctx.font = '22px ' + FONT; ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText(store + ' · 月报表 ' + d.month, M, 52);
    ctx.textAlign = 'right';
    ctx.fillText('第 ' + (pages.length + 1) + ' 页', RIGHT, 52);
    ctx.fillStyle = '#ddd'; ctx.fillRect(M, 66, RIGHT - M, 2);
    pages.push(cv);
    y = 92;
  };
  newPage();
  rows.forEach((r) => {
    if (y + r.h > H - 60) newPage();
    r.draw(ctx, y);
    y += r.h;
  });
  return pages;
}

async function exportMonthlyPdf() {
  if (!lastMonthly) { toast('月报还没载入完成'); return; }
  try {
    const blob = await canvasesToPdfBlob(monthlyReportCanvases(lastMonthly));
    const name = '月报_' + lastMonthly.month + '.pdf';
    const file = new File([blob], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: name });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('月报 PDF 已下载');
    }
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('导出失败：' + e.message);
  }
}

/* ---------------- barcode scanning ---------------- */
let scanStream = null;
let scanTimer = null;
let scanCount = 0;
let lastScanCode = '';
let lastScanAt = 0;
function scanFeedback() {
  const f = settings.scan_feedback || 'beep';
  if (f === 'vibrate') { if (navigator.vibrate) navigator.vibrate(60); return; }
  if (f === 'mute') return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.08;
    o.start(); o.stop(ctx.currentTime + 0.09);
    setTimeout(() => ctx.close(), 250);
  } catch (_) { /* audio unavailable */ }
}
function updateScanStatus(lastName) {
  $('scan-status').textContent = scanCount
    ? '已加 ' + scanCount + ' 件' + (lastName ? ' · ' + lastName : '')
    : '连续扫码 · 扫一次加 1 件';
}
function onScanCode(code) {
  const now = Date.now();
  if (code === lastScanCode && now - lastScanAt < 1600) return;
  lastScanCode = code; lastScanAt = now;
  const p = products.find((x) => x.barcode === code || x.sku === code);
  if (!p) { toast('未找到商品 / Product not found：' + code); return; }
  const before = cart.get(p.id) ? cart.get(p.id).qty : 0;
  addToCart(p);
  const after = cart.get(p.id) ? cart.get(p.id).qty : 0;
  if (after > before) { scanFeedback(); scanCount += 1; updateScanStatus(p.name); }
}
function renderScanResults() {
  const q = ($('scan-q').value || '').trim().toLowerCase();
  const box = $('scan-results');
  box.innerHTML = '';
  products.filter((pr) => !q || pr.name.toLowerCase().includes(q) ||
      (pr.name_en || '').toLowerCase().includes(q) ||
      (pr.sku || '').toLowerCase().includes(q) ||
      (pr.barcode || '').toLowerCase().includes(q))
    .slice(0, 30).forEach((pr) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow"><span class="t" style="color:#111">' +
        esc(pr.name) + '</span><span class="s">' + esc(pr.sku || '') + ' · ' +
        esc(pr.barcode || '') + ' · 库存 ' + pr.stock_qty + '</span></span>' +
        '<span class="amt" style="color:#111">' + fmt(pr.price_cents) + '</span>';
      row.onclick = () => { addToCart(pr); scanFeedback(); scanCount += 1; updateScanStatus(pr.name); };
      box.appendChild(row);
    });
}
async function openScan() {
  $('scan-overlay').classList.remove('hidden');
  scanCount = 0;
  updateScanStatus();
  renderScanResults();
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices) {
    // iOS Safari has no BarcodeDetector (and cameras need HTTPS anyway):
    // the photo-scan button below is the working path on iPhone.
    $('scan-status').textContent =
      '实时扫码需要 Android/Chrome； iPhone 请用「拍照扫条码」或手动搜索';
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia(
      { video: { facingMode: 'environment' } });
    const video = $('scan-video');
    video.srcObject = scanStream;
    await video.play();
    const det = new BarcodeDetector({ formats:
      ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'upc_a', 'upc_e'] });
    scanTimer = setInterval(async () => {
      try {
        const codes = await det.detect(video);
        if (codes && codes.length) onScanCode(codes[0].rawValue);
      } catch (_) { /* frame not ready */ }
    }, 250);
  } catch (_) {
    toast('摄像头不可用或无权限，请改用手动搜索加购');
  }
}
async function scanPhoto(file) {
  if (!file) return;
  toast('识别中…');
  try {
    const b64 = await fileToJpegBase64(file, 1600);
    const d = await api('/api/scan/decode', {
      method: 'POST', body: JSON.stringify({ image_base64: b64 }),
    });
    if (d && d.payload) onScanCode(String(d.payload).trim());
    else toast('没识别到条码：靠近一点、避开反光再拍');
  } catch (e) { toast('识别失败：' + e.message); }
}
function closeScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  $('scan-overlay').classList.add('hidden');
}

/* ---------------- DuitNow QR fullscreen ---------------- */
function openQrFull() {
  const payload = (settings.duitnow_qr_payload || '').trim();
  const { total } = cartTotals();
  $('qr-full-shop').textContent = settings.store_name || '';
  $('qr-full-amt').textContent = fmt(total);
  $('qr-full-box').innerHTML = payload && emvIsValid(payload) && total > 0
    ? qrSvgSafe(emvBuildDynamic(payload, total), 8)
    : $('pay-qr-box').innerHTML;
  $('qr-full').classList.remove('hidden');
}


/* ---------------- purchase draft review ---------------- */
let draftState = null;
async function openDraftPage(id) {
  try {
    const d = await api('/api/purchase-drafts/' + id);
    const dr = d.draft;
    draftState = {
      id: dr.id, invoice_total_cents: dr.invoice_total_cents,
      lines: (dr.lines || []).map((ln) => Object.assign({}, ln)),
      aliases: [], history: {},
    };
    fillSupplierSelect($('draft-supplier'));
    $('draft-supplier').value = dr.supplier_id ? String(dr.supplier_id) : '';
    $('draft-invoice').value = dr.invoice_no || '';
    $('draft-date').value = dr.invoice_date || '';
    const setFee = (el, cents) => { $(el).value = ((cents || 0) / 100).toFixed(2); };
    setFee('draft-fee-discount', dr.discount_cents);
    setFee('draft-fee-tax', dr.tax_cents);
    setFee('draft-fee-delivery', dr.delivery_fee_cents);
    setFee('draft-fee-other', dr.other_fee_cents);
    $('draft-raw').textContent = dr.ocr_raw_text || '';
    await refreshDraftContext();
    renderDraft();
    switchTab('draft');
  } catch (e) { toast('打开草稿失败：' + e.message); }
}
async function refreshDraftContext() {
  const supId = $('draft-supplier').value;
  draftState.aliases = [];
  if (supId) {
    try {
      draftState.aliases =
        (await api('/api/supplier-aliases?supplier_id=' + supId)).items || [];
    } catch (_) { /* ignore */ }
  }
  const pids = [...new Set(draftState.lines
    .map((l) => l.matched_product_id).filter(Boolean))];
  for (const pid of pids) {
    if (draftState.history[pid]) continue;
    try {
      const h = await api('/api/products/' + pid + '/purchase-history');
      const items = h.items || [];
      draftState.history[pid] = {
        lastCost: items.length ? items[0].cost_cents : null,
        avgQty: items.length
          ? items.reduce((a, x) => a + x.qty, 0) / items.length : null,
      };
    } catch (_) { draftState.history[pid] = { lastCost: null, avgQty: null }; }
  }
}
function draftFees() {
  const g = (id) => Math.max(0, Math.round(parseFloat($(id).value || '0') * 100));
  return { discount: g('draft-fee-discount'), tax: g('draft-fee-tax'),
    delivery: g('draft-fee-delivery'), other: g('draft-fee-other') };
}
function draftCalcTotal() {
  const f = draftFees();
  const sum = draftState.lines.reduce((a, l) => a + (l.line_subtotal_cents || 0), 0);
  return sum - f.discount + f.tax + f.delivery + f.other;
}
function lineIssues(l) {
  const issues = [];
  const p = products.find((x) => x.id === l.matched_product_id);
  if (l.matched_product_id && p) {
    const calc = Math.round(l.quantity * l.unit_cost_cents);
    if (Math.abs(calc - l.line_subtotal_cents) > 5)
      issues.push('行小计对不上（数量×成本 = ' + fmt(calc) + '）');
    if (!l.user_modified && l.match_confidence > 0 && l.match_confidence < 0.72)
      issues.push('匹配置信度低 ' + Math.round(l.match_confidence * 100) + '%');
    const h = draftState.history[l.matched_product_id];
    if (h) {
      const convQty = l.quantity * (l.conversion_factor || 1);
      if (h.avgQty && convQty >= 3 * h.avgQty)
        issues.push('数量异常：高于历史平均 3 倍');
      const unitCost = Math.round(l.unit_cost_cents / (l.conversion_factor || 1));
      if (h.lastCost && Math.abs(unitCost - h.lastCost) > h.lastCost * 0.3)
        issues.push('成本异常：与上次成本相差超过 30%');
    }
    const al = draftState.aliases.find(
      (a) => a.normalized_name === normalizeName(l.raw_product_name || ''));
    if (al && al.product_id === l.matched_product_id && al.unit &&
        l.unit && al.unit.toUpperCase() !== String(l.unit).toUpperCase())
      issues.push('供应商记忆单位冲突（记忆 ' + al.unit + ' ≠ 发票 ' + l.unit + '）');
  }
  return issues;
}
function validateDraft() {
  const errors = [];
  const warnings = [];
  if (!$('draft-supplier').value) errors.push('未选择供应商');
  if (!draftState.lines.length) errors.push('草稿没有商品行');
  draftState.lines.forEach((l, i) => {
    const tag = '第 ' + (i + 1) + ' 行';
    if (!l.matched_product_id) errors.push(tag + ' 未匹配商品：' + (l.raw_product_name || ''));
    if (!(l.quantity > 0) || !isFinite(l.quantity)) errors.push(tag + ' 数量无效');
    if (!(l.conversion_factor > 0) || !isFinite(l.conversion_factor))
      errors.push(tag + ' 换算倍率无效');
    if (l.unit_cost_cents < 0) errors.push(tag + ' 成本为负数');
    lineIssues(l).forEach((w) => warnings.push(tag + ' ' + w));
  });
  if (draftState.invoice_total_cents !== null &&
      draftState.invoice_total_cents !== undefined &&
      Math.abs(draftCalcTotal() - draftState.invoice_total_cents) > 10)
    warnings.push('计算总计与发票总计相差 ' +
      fmt(Math.abs(draftCalcTotal() - draftState.invoice_total_cents)));
  return { errors, warnings };
}
function renderDraft() {
  if (!draftState) return;
  const onlyIssues = $('draft-only-issues').checked;
  const box = $('draft-lines');
  box.innerHTML = '';
  draftState.lines.forEach((l, idx) => {
    const issues = l.matched_product_id ? lineIssues(l) : [];
    if (onlyIssues && l.matched_product_id && !issues.length &&
        l.match_confidence >= 0.72) return;
    const card = document.createElement('div');
    card.className = 'dline';
    const conf = l.match_confidence
      ? Math.round(l.match_confidence * 100) + '%' : '—';
    card.innerHTML =
      '<div class="dl-raw">' + esc(l.raw_text || l.raw_product_name || '') +
      ' · 置信 <span class="conf' +
      (l.match_confidence && l.match_confidence < 0.72 ? ' low' : '') + '">' +
      conf + '</span></div>' +
      '<div class="dl-nums"><select class="dl-prod"></select></div>' +
      '<div class="dl-nums">' +
      '<label>数量 <input type="number" step="any" class="dl-qty"></label>' +
      '<label>单位 <input type="text" class="dl-unit"></label>' +
      '<label>换算× <input type="number" step="any" class="dl-conv"></label>' +
      '<label>成本 RM <input type="number" step="0.01" class="dl-cost"></label>' +
      '<label>小计 RM <input type="number" step="0.01" class="dl-sub"></label>' +
      '<button class="btn small danger dl-del">✕</button></div>' +
      '<div class="dl-preview"></div>' +
      (issues.length ? '<div class="warn-text">' + esc(issues.join('；')) + '</div>' : '');
    const sel = card.querySelector('.dl-prod');
    sel.innerHTML = '<option value="">— 未匹配 —</option>';
    products.forEach((pr) => {
      const o = document.createElement('option');
      o.value = pr.id;
      o.textContent = pr.name + '（库存 ' + pr.stock_qty + '）';
      sel.appendChild(o);
    });
    sel.value = l.matched_product_id ? String(l.matched_product_id) : '';
    const q = (cls) => card.querySelector(cls);
    q('.dl-qty').value = l.quantity;
    q('.dl-unit').value = l.unit || 'pcs';
    q('.dl-conv').value = l.conversion_factor || 1;
    q('.dl-cost').value = (l.unit_cost_cents / 100).toFixed(2);
    q('.dl-sub').value = (l.line_subtotal_cents / 100).toFixed(2);
    const preview = () => {
      const p = products.find((x) => x.id === l.matched_product_id);
      const inn = (l.quantity || 0) * (l.conversion_factor || 1);
      const uc = (l.conversion_factor || 1) > 0
        ? Math.round(l.unit_cost_cents / l.conversion_factor) : 0;
      q('.dl-preview').textContent = p
        ? '入库 +' + inn + ' → 新库存 ' + (p.stock_qty + inn) +
          ' · 新成本 ' + fmt(uc) + '（现成本 ' + fmt(p.cost_cents) + '）'
        : '未匹配商品';
    };
    preview();
    const markModified = () => {
      l.user_modified = 1;
      l.match_confidence = 1.0;
    };
    sel.onchange = () => {
      l.matched_product_id = sel.value ? parseInt(sel.value) : null;
      const p = products.find((x) => x.id === l.matched_product_id);
      l.matched_product_name = p ? p.name : null;
      markModified();
      refreshDraftContext().then(renderDraft);
    };
    q('.dl-qty').oninput = (e) => { l.quantity = parseFloat(e.target.value) || 0; markModified(); preview(); renderDraftTotals(); };
    q('.dl-unit').oninput = (e) => { l.unit = e.target.value; };
    q('.dl-conv').oninput = (e) => { l.conversion_factor = parseFloat(e.target.value) || 0; markModified(); preview(); };
    q('.dl-cost').oninput = (e) => { l.unit_cost_cents = Math.round(parseFloat(e.target.value || '0') * 100); markModified(); };
    q('.dl-sub').oninput = (e) => { l.line_subtotal_cents = Math.round(parseFloat(e.target.value || '0') * 100); markModified(); renderDraftTotals(); };
    q('.dl-del').onclick = () => {
      draftState.lines.splice(idx, 1);
      renderDraft();
    };
    box.appendChild(card);
  });
  renderDraftTotals();
}
function renderDraftTotals() {
  if (!draftState) return;
  $('draft-calc-total').textContent = fmt(draftCalcTotal());
  $('draft-inv-total').textContent =
    draftState.invoice_total_cents !== null &&
    draftState.invoice_total_cents !== undefined
      ? fmt(draftState.invoice_total_cents) : '—（未识别）';
  const { errors, warnings } = validateDraft();
  $('draft-errors').textContent = errors.length
    ? '无法入库：\n' + errors.join('\n') : '';
  $('draft-warnings').textContent = warnings.length
    ? '警告（入库时需确认）：\n' + warnings.join('\n') : '';
  $('draft-commit').disabled = !!errors.length;
}
async function saveDraft() {
  const f = draftFees();
  const supSel = $('draft-supplier');
  await api('/api/purchase-drafts/' + draftState.id, {
    method: 'PUT',
    body: JSON.stringify({
      supplier_id: supSel.value ? parseInt(supSel.value) : null,
      supplier_name: supSel.selectedOptions[0]
        ? supSel.selectedOptions[0].textContent : '',
      invoice_no: $('draft-invoice').value.trim(),
      invoice_date: $('draft-date').value || '',
      discount_cents: f.discount, tax_cents: f.tax,
      delivery_fee_cents: f.delivery, other_fee_cents: f.other,
      invoice_total_cents: draftState.invoice_total_cents,
      lines: draftState.lines,
    }),
  });
}
async function commitDraftFlow() {
  const { errors, warnings } = validateDraft();
  if (errors.length) { toast('无法入库：' + errors[0]); return; }
  if (warnings.length &&
      !confirm('有以下警告，仍要入库？\n' + warnings.join('\n'))) return;
  try {
    await saveDraft();
    const fresh = await api('/api/purchase-drafts/' + draftState.id);
    const aliases = {};
    (fresh.draft.lines || []).forEach((ln, i) => {
      const st = draftState.lines[i];
      if (ln.matched_product_id && st && st.raw_product_name) {
        aliases[ln.id] = {
          raw_name: st.raw_product_name,
          normalized_name: normalizeName(st.raw_product_name),
          unit: st.unit || 'pcs',
          conversion_factor: st.conversion_factor || 1,
        };
      }
    });
    const doCommit = (extra) => api(
      '/api/purchase-drafts/' + draftState.id + '/commit', {
        method: 'POST',
        body: JSON.stringify(Object.assign({ aliases }, extra || {})),
      });
    let d;
    try {
      d = await doCommit();
    } catch (e) {
      if (!/重复进货单号/.test(e.message)) throw e;
      const reason = prompt('同一供应商已存在这个进货单号。\n' +
        '管理员强制入库必须填原因（会记入审计）：');
      if (!reason || !reason.trim()) { toast('已取消入库'); return; }
      d = await doCommit({ allow_duplicate: true, override_reason: reason.trim() });
    }
    toast('已入库 ✅ ' + d.purchase_no + ' · ' + fmt(d.total_cents));
    showCostAlerts(d.cost_alerts);
    draftState = null;
    await loadCatalog();
    renderPos();
    switchTab('purchases');
  } catch (e) { toast('入库失败：' + e.message); }
}

/* ---------------- supplier aliases page ---------------- */
async function loadAliasesPage() {
  try {
    await loadSuppliers();
    fillSupplierSelect($('alias-supplier'));
    const supId = $('alias-supplier').value;
    const box = $('alias-list');
    box.innerHTML = '';
    if (!supId) {
      box.innerHTML = '<div class="cart-empty">先选择供应商</div>';
      return;
    }
    const d = await api('/api/supplier-aliases?supplier_id=' + supId);
    (d.items || []).forEach((a) => {
      const row = document.createElement('div');
      row.className = 'dline';
      row.innerHTML = '<div class="dl-raw">发票品名：' + esc(a.raw_name) +
        ' · 已确认使用 ' + a.use_count + ' 次</div>' +
        '<div class="dl-nums"><select class="al-prod"></select>' +
        '<label>单位 <input type="text" class="al-unit"></label>' +
        '<label>换算× <input type="number" step="any" class="al-conv"></label>' +
        '<button class="btn small al-save">保存</button>' +
        '<button class="btn small danger al-del">删除</button></div>';
      const sel = row.querySelector('.al-prod');
      products.forEach((pr) => {
        const o = document.createElement('option');
        o.value = pr.id;
        o.textContent = pr.name;
        sel.appendChild(o);
      });
      sel.value = String(a.product_id);
      row.querySelector('.al-unit').value = a.unit || 'pcs';
      row.querySelector('.al-conv').value = a.conversion_factor || 1;
      row.querySelector('.al-save').onclick = async () => {
        try {
          await api('/api/supplier-aliases/' + a.id, {
            method: 'PUT',
            body: JSON.stringify({
              product_id: parseInt(sel.value),
              unit: row.querySelector('.al-unit').value.trim() || 'pcs',
              conversion_factor: parseFloat(row.querySelector('.al-conv').value) || 0,
            }),
          });
          toast('记忆已更新');
          loadAliasesPage();
        } catch (e) { toast('保存失败：' + e.message); }
      };
      row.querySelector('.al-del').onclick = async () => {
        if (!confirm('删除这条记忆？')) return;
        await api('/api/supplier-aliases/' + a.id, { method: 'DELETE' });
        loadAliasesPage();
      };
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">这个供应商还没有商品记忆（OCR 入库后自动学习）</div>';
  } catch (e) { toast('载入记忆失败：' + e.message); }
}

function init() {
  $('login-btn').onclick = doLogin;
  $('login-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('logout-btn').onclick = () => logout(false);
  document.querySelectorAll('.tab').forEach((t) =>
    t.onclick = () => switchTab(t.dataset.tab));
  $('pos-search').addEventListener('input', renderPos);
  $('cart-discount').addEventListener('input', renderCart);
  $('checkout-btn').onclick = openCheckout;
  $('co-customer').addEventListener('change', onCoCustomer);
  $('co-phone').addEventListener('input', () => { /* typed phone wins */ });
  document.querySelectorAll('.dmbtn').forEach((b) => b.onclick = () => {
    stopAuto();
    depositMethod = b.dataset.dm;
    document.querySelectorAll('.dmbtn').forEach((x) =>
      x.classList.toggle('active', x === b));
    renderCreditQr();
  });
  $('credit-deposit').addEventListener('input', updateCreditDue);
  $('change-ok').onclick = () => {
    $('change-modal').classList.add('hidden');
    showSuccess();
  };
  $('success-done').onclick = () => $('success-modal').classList.add('hidden');
  $('success-print').onclick = async () => {
    if (!pendingSale) return;
    try {
      const d = await api('/api/sales/' + pendingSale.id);
      lastSaleDetail = d;
      printReceipt();
    } catch (e) { toast('打印失败：' + e.message); }
  };
  $('success-ereceipt').onclick = () => {
    if (pendingSale) shareEReceipt(pendingSale.id);
  };
  $('scan-btn').onclick = openScan;
  $('scan-photo-btn').onclick = () => $('scan-file').click();
  $('scan-file').addEventListener('change', (e) => {
    scanPhoto(e.target.files[0]);
    e.target.value = '';
  });
  $('scan-done').onclick = closeScan;
  $('scan-close').onclick = closeScan;
  $('scan-q').addEventListener('input', renderScanResults);
  $('qr-full-btn').onclick = openQrFull;
  $('qr-full-close').onclick = () => $('qr-full').classList.add('hidden');
  $('cart-discount').addEventListener('change', () => {
    const now = cartTotals().discount;
    const prev = parseInt($('cart-discount').dataset.audited || '0', 10);
    if (now !== prev) {
      postAudit({ action: 'order_discount', old_value: String(prev),
        new_value: String(now), reason: 'rm' });
      $('cart-discount').dataset.audited = String(now);
    }
  });
  document.querySelectorAll('.pm').forEach((b) => b.onclick = () => {
    stopAuto();
    payMethod = b.dataset.method;
    document.querySelectorAll('.pm').forEach((x) =>
      x.classList.toggle('active', x === b));
    showPayPane();
  });
  document.addEventListener('pointerdown', primeSpeech, { once: true });
  $('pay-paid').addEventListener('input', updateChange);
  document.querySelectorAll('.quick-cash button').forEach((b) => b.onclick = () => {
    const { total } = cartTotals();
    $('pay-paid').value = b.dataset.amt === 'exact'
      ? (total / 100).toFixed(2)
      : ((Math.round(parseFloat($('pay-paid').value || '0') * 100) + parseInt(b.dataset.amt) * 100) / 100).toFixed(2);
    updateChange();
  });
  $('pay-confirm').onclick = () => { const r = autoRef; confirmSale(r); };
  document.querySelectorAll('.modal-x').forEach((b) => b.onclick = () => {
    if (b.dataset.close === 'checkout-modal') stopAuto();
    $(b.dataset.close).classList.add('hidden');
  });
  $('prod-search').addEventListener('input', renderProducts);
  $('prod-add').onclick = () => openProduct(null);
  $('prod-save').onclick = saveProduct;
  const pdBtn = $('prod-del');
  if (pdBtn) pdBtn.onclick = async () => {
    const id = $('prod-id').value;
    if (!id) return;
    if (!confirm('删除商品「' + $('prod-name').value + '」？删除后列表不再显示，历史销售记录不受影响。')) return;
    try {
      await api('/api/products/' + id, { method: 'DELETE' });
      $('product-modal').classList.add('hidden');
      toast('商品已删除');
      await loadCatalog();
      renderProducts();
    } catch (e) { toast('删除失败：' + e.message); }
  };
  $('prod-label').onclick = printProductLabel;
  $('cat-add').onclick = async () => {
    const name = prompt('新分类名称');
    if (!name || !name.trim()) return;
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      await loadCatalog(); renderPos(); toast('分类已新增');
    } catch (e) { toast('新增分类失败：' + e.message); }
  };
  $('sale-print').onclick = printReceipt;
  $('prod-img-btn').onclick = () => $('prod-img-file').click();
  $('prod-img-file').addEventListener('change', (e) => {
    pickProductImage(e.target.files[0]);
    e.target.value = '';
  });
  $('prod-img-del').onclick = () => {
    pendingProdImage = '';
    $('prod-img-preview').classList.add('hidden');
    $('prod-img-del').classList.add('hidden');
  };
  document.querySelectorAll('#rep-chips button').forEach((b) => b.onclick = () => {
    repRange = b.dataset.range;
    document.querySelectorAll('#rep-chips button').forEach((x) =>
      x.classList.toggle('sel', x === b));
    loadReport();
  });
  $('closing-btn').onclick = openClosing;
  $('closing-save').onclick = saveClosing;
  $('pur-add').onclick = () => $('pur-choose-modal').classList.remove('hidden');
  $('choose-manual').onclick = () => {
    $('pur-choose-modal').classList.add('hidden');
    openPurchase();
  };
  $('choose-ocr-camera').onclick = () => {
    const f = $('pur-choose-file');
    f.setAttribute('capture', 'environment');
    f.click();
  };
  $('choose-ocr-gallery').onclick = () => {
    const f = $('pur-choose-file');
    f.removeAttribute('capture');
    f.click();
  };
  $('pur-choose-file').addEventListener('change', (e) => {
    purchaseOcr(e.target.files[0]);
    e.target.value = '';
  });
  $('pur-alias-btn').onclick = () => switchTab('aliases');
  $('alias-supplier').addEventListener('change', loadAliasesPage);
  $('draft-back').onclick = () => switchTab('purchases');
  $('draft-supplier').addEventListener('change', () =>
    refreshDraftContext().then(renderDraft));
  ['draft-fee-discount', 'draft-fee-tax', 'draft-fee-delivery', 'draft-fee-other',
   'draft-invoice'].forEach((id) =>
    $(id).addEventListener('input', renderDraftTotals));
  $('draft-only-issues').addEventListener('change', renderDraft);
  $('draft-line-add').onclick = () => {
    draftState.lines.push({
      raw_text: '', raw_product_name: '', matched_product_id: null,
      matched_product_name: null, match_confidence: 0, quantity: 1,
      unit: 'pcs', conversion_factor: 1, unit_cost_cents: 0,
      line_subtotal_cents: 0, user_modified: 1,
    });
    renderDraft();
  };
  $('draft-save').onclick = async () => {
    try { await saveDraft(); toast('草稿已保存'); }
    catch (e) { toast('保存失败：' + e.message); }
  };
  $('draft-commit').onclick = commitDraftFlow;
  $('draft-delete').onclick = async () => {
    if (!confirm('删除这份草稿？')) return;
    await api('/api/purchase-drafts/' + draftState.id, { method: 'DELETE' });
    draftState = null;
    toast('草稿已删除');
    switchTab('purchases');
  };
  $('rev-confirm').onclick = confirmReverse;
  $('pur-line-add').onclick = () => addPurLine();

  $('pur-save').onclick = savePurchase;
  $('pur-ocr-btn').onclick = () => $('pur-ocr-file').click();
  $('pur-ocr-file').addEventListener('change', (e) => {
    purchaseOcr(e.target.files[0]);
    e.target.value = '';
  });
  $('cost-alert-ok').onclick = () =>
    $('cost-alert-modal').classList.add('hidden');
  $('mr-month').addEventListener('change', loadMonthly);
  $('mr-pdf').onclick = exportMonthlyPdf;
  $('sup-add').onclick = () => openSupplier(null);
  $('sup-save').onclick = saveSupplier;
  const sa2 = $('sup-add2');
  if (sa2) sa2.onclick = () => openSupplier(null);
  const ssEl = $('sup-search');
  if (ssEl) ssEl.addEventListener('input', renderSupplierRows);
  $('purd-reverse').onclick = reversePurchase;
  $('hold-btn').onclick = holdCart;
  $('held-btn').onclick = openHeld;
  $('cust-add').onclick = () => openCustomer(null);
  $('cust-save').onclick = saveCustomer;
  const cdBtn = $('cust-del');
  if (cdBtn) cdBtn.onclick = async () => {
    const id = $('cust-id').value;
    if (!id) return;
    if (!confirm('删除客户「' + $('cust-name').value + '」？历史销售记录不受影响。')) return;
    try {
      await api('/api/customers/' + id, { method: 'DELETE' });
      $('customer-modal').classList.add('hidden');
      toast('客户已删除');
      loadCustomersPage();
    } catch (e) { toast('删除失败：' + e.message); }
  };
  $('cust-search').addEventListener('input', renderCustomers);
  $('credit-deposit').addEventListener('input', updateCreditDue);
  // wave-2 navigation + page wiring
  document.querySelectorAll('#hub-menu [data-hub]').forEach((b) =>
    b.onclick = () => switchTab(b.dataset.hub));
  document.querySelectorAll('.hub-back').forEach((b) =>
    b.onclick = () => switchTab('hub'));
  $('goto-training').onclick = () => { renderTraining(); switchTab('training'); };
  $('goto-einvoice').onclick = () => switchTab('einvoice');
  $('training-back').onclick = () => switchTab('settings');
  $('einvoice-back').onclick = () => switchTab('settings');
  $('today-refresh').onclick = loadToday;
  $('sales-q').addEventListener('input', () => { salesPageNo = 0; loadSales(); });
  $('sales-from').addEventListener('change', () => { salesPageNo = 0; loadSales(); });
  $('sales-to').addEventListener('change', () => { salesPageNo = 0; loadSales(); });
  $('sales-clear').onclick = () => {
    $('sales-q').value = ''; $('sales-from').value = ''; $('sales-to').value = '';
    salesPageNo = 0; loadSales();
  };
  $('sales-prev').onclick = () => { if (salesPageNo > 0) { salesPageNo--; loadSales(); } };
  $('sales-next').onclick = () => { salesPageNo++; loadSales(); };
  $('stk-search').addEventListener('input', renderStocktake);
  $('cat-create').onclick = async () => {
    const name = $('cat-new-name').value.trim();
    if (!name) { toast('先填分类名称'); return; }
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
      $('cat-new-name').value = '';
      await loadCatalog(); renderCategoriesPage(); renderPos();
      toast('分类已新增');
    } catch (e) { toast('新增分类失败：' + e.message); }
  };
  $('audit-refresh').onclick = loadAudit;
  $('audit-today').addEventListener('change', loadAudit);
  $('einvoice-refresh').onclick = loadEinvoice;
  $('einvoice-env').addEventListener('change', loadEinvoice);
  $('wipe-dry').onclick = async () => {
    const cats = Array.from(document.querySelectorAll('#wipe-cats input:checked'))
      .map((i) => i.value);
    if (!cats.length) { toast('先勾选要清零的类别'); return; }
    try {
      const d = await runWipe(cats, true);
      $('wipe-result').textContent = '影响（将清零）：' + wipeCountsText(d.counts);
    } catch (e) { toast('计算失败：' + e.message); }
  };
  $('wipe-run').onclick = () => {
    const cats = Array.from(document.querySelectorAll('#wipe-cats input:checked'))
      .map((i) => i.value);
    wipeFlow(cats);
  };
  $('wipe-txn-btn').onclick = () =>
    wipeFlow(['sales', 'purchases', 'stock_moves', 'held_orders', 'daily_closings']);
  $('prod-queue').onclick = async () => {
    const id = $('prod-id').value;
    if (!id) { toast('先保存商品，再加入条码队列'); return; }
    const copies = Math.max(1, parseInt(prompt('入队份数', '1') || '1', 10) || 1);
    try {
      await api('/api/barcode-queue', { method: 'POST',
        body: JSON.stringify({ product_id: parseInt(id), copies }) });
      toast('已加入条码队列');
    } catch (e) { toast('入队失败：' + e.message); }
  };
  $('sale-void').onclick = voidSale;
  $('set-save').onclick = saveSettings;
  document.querySelectorAll('#tab-settings input, #tab-settings textarea, #tab-settings select')
    .forEach((el) => el.addEventListener('input', renderReceiptPreview));
  $('qr-import').onclick = () => $('qr-file').click();
  $('qr-file').addEventListener('change', (e) => { importQr(e.target.files[0]); e.target.value = ''; });
  $('qr-clear').onclick = async () => {
    if (!confirm('移除服务器上的收款码载荷？')) return;
    try {
      await api('/api/settings', {
        method: 'POST', body: JSON.stringify({ settings: { duitnow_qr_payload: '' } }),
      });
      await refreshSettings(); renderQrStatus(); toast('已移除');
    } catch (e) { toast('移除失败：' + e.message); }
  };
  $('user-add').onclick = saveUser;
  $('user-clear').onclick = clearUserForm;

  const saved = localStorage.getItem('pos2_session');
  if (saved) {
    try {
      session = JSON.parse(saved);
      api('/api/auth/me').then((d) => {
        session.user = d.user;
        enterApp();
      }).catch(() => { session = null; loadLoginUsers(); });
      return;
    } catch (_) { session = null; }
  }
  loadLoginUsers();
}

document.addEventListener('DOMContentLoaded', init);

function qrSvgSafe(text, size) {
  try { return window.qrSvg(text, size); } catch (_) { return ''; }
}

/* ---------------- payments: live broadcast + auto-settle (M2) -------- */
let ws = null;
let wsRetry = null;
let handledRefs = new Set();
let autoTimer = null;
let autoRef = null;
let catalogReloadTimer = null;

function speechTextForCents(cents) {
  const ringgit = Math.floor(cents / 100);
  const sen = cents % 100;
  const parts = [];
  if (ringgit > 0) parts.push(ringgit + ' 令吉');
  if (sen > 0) parts.push(sen + ' 仙');
  if (!parts.length) parts.push('0 令吉');
  return 'DuitNow 收款成功，' + parts.join(' ');
}

let zhVoice = null;
function pickZhVoice() {
  const voices = speechSynthesis.getVoices();
  zhVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('zh-cn')) ||
    voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('zh')) || null;
}
if ('speechSynthesis' in window) {
  pickZhVoice();
  speechSynthesis.onvoiceschanged = pickZhVoice;
}

let speechPrimed = false;
function primeSpeech() {
  if (speechPrimed || !('speechSynthesis' in window)) return;
  speechPrimed = true;
  try {
    speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch (_) { /* no audio path: banner still shows */ }
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (zhVoice) u.voice = zhVoice;
    speechSynthesis.speak(u);
  } catch (_) { /* device without voices: banner still shows */ }
}

let wsFails = 0;
function connectWs() {
  if (!session || ws) return;
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + BASE_PATH + 'api/ws?token=' +
    encodeURIComponent(session.token));
  ws.onopen = () => {
    wsFails = 0;
    $('pay-dot').classList.add('on');
    refreshSettings();
    loadHeldCount();
    loadPayments();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'payment' && msg.payment) handlePayment(msg.payment);
    if (msg.type === 'sale') {
      clearTimeout(catalogReloadTimer);
      catalogReloadTimer = setTimeout(async () => {
        try { await loadCatalog(); renderPos(); } catch (_) { /* offline blip */ }
      }, 400);
    }
    if (msg.type === 'settings') refreshSettings();
    if (msg.type === 'held') loadHeldCount();
  };
  ws.onclose = () => {
    ws = null;
    $('pay-dot').classList.remove('on');
    if (session) {
      wsFails += 1;
      if (wsFails >= 6) {
        wsFails = 0;
        api('/api/auth/me').catch(() => { /* 401 path logs out */ });
      }
      clearTimeout(wsRetry);
      wsRetry = setTimeout(connectWs, 5000);
    }
  };
  ws.onerror = () => { try { ws.close(); } catch (_) { /* noop */ } };
}

function handlePayment(p) {
  if (!p || !p.ref_no || handledRefs.has(p.ref_no)) {
    if (!$('tab-payments').classList.contains('hidden')) loadPayments();
    return;
  }
  handledRefs.add(p.ref_no);
  if (handledRefs.size > 300) handledRefs = new Set([...handledRefs].slice(-150));
  speak(speechTextForCents(p.amount_cents));
  const banner = $('pay-banner');
  banner.textContent = '💰 到账 ' + fmt(p.amount_cents) + ' · DuitNow';
  banner.classList.remove('hidden');
  clearTimeout(banner._h);
  banner._h = setTimeout(() => banner.classList.add('hidden'), 6000);
  if (!$('tab-payments').classList.contains('hidden')) loadPayments();
  // Auto-settle: checkout open, exact-amount match on the DuitNow due —
  // or on a credit deposit being collected by DuitNow.
  const modalOpen = !$('checkout-modal').classList.contains('hidden');
  if (modalOpen && cart.size) {
    if (payMethod === 'DUITNOW' && p.amount_cents === cartTotals().total) {
      startAuto(p, $('pay-auto'));
    } else if (payMethod === 'CREDIT' && depositMethod === 'DUITNOW' &&
               creditDepositCents() > 0 &&
               p.amount_cents === creditDepositCents()) {
      startAuto(p, $('credit-auto'));
    }
  }
}

function startAuto(p, box) {
  stopAuto();
  autoRef = p.ref_no;
  let remain = 5;
  box = box || $('pay-auto');
  const draw = () => {
    box.innerHTML = '✅ 已到账 ' + fmt(p.amount_cents) + ' · 与应付一致 · ' +
      remain + ' 秒后自动入账' +
      '<div class="rowb"><button id="auto-now">立即入账</button>' +
      '<button id="auto-no">不是这单</button></div>';
    $('auto-now').onclick = () => { const r = autoRef; confirmSale(r); };
    $('auto-no').onclick = () => {
      stopAuto();
      $('pay-qr-note').textContent = '已忽略这笔到账，请核对后再确认收款。';
    };
  };
  draw();
  box.classList.remove('hidden');
  autoTimer = setInterval(() => {
    remain -= 1;
    if (remain <= 0) { const r = autoRef; confirmSale(r); return; }
    draw();
  }, 1000);
}

function stopAuto() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  autoRef = null;
  const box = $('pay-auto');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
  const cbox = $('credit-auto');
  if (cbox) { cbox.classList.add('hidden'); cbox.innerHTML = ''; }
}

/* ---------------- payments page ---------------- */
async function loadPayments() {
  try {
    const d = await api('/api/payments?limit=200');
    const s = d.summary || {};
    $('pay-summary').innerHTML =
      '<div class="scard"><div class="k">今日收款</div><div class="v">' +
      fmt(s.today_cents || 0) + '</div></div>' +
      '<div class="scard"><div class="k">本月收款</div><div class="v">' +
      fmt(s.month_cents || 0) + '</div></div>' +
      '<div class="scard"><div class="k">总计（' + (s.total_count || 0) +
      ' 笔）</div><div class="v">' + fmt(s.total_cents || 0) + '</div></div>';
    const box = $('payments-list');
    box.innerHTML = '';
    if (!d.available) {
      box.innerHTML = '<div class="cart-empty">收款流水线未连接（服务器账本不存在）</div>';
      return;
    }
    (d.items || []).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML =
        '<span class="grow"><span class="t">' + fmt(p.amount_cents) + '</span>' +
        '<span class="s">' + esc(p.time_kl) + ' · Ref ' + esc(p.ref_no) +
        '</span></span>';
      const btn = document.createElement('button');
      btn.className = 'replay';
      btn.textContent = '🔊';
      btn.title = '重播这笔到账';
      btn.onclick = () => speak(speechTextForCents(p.amount_cents));
      row.appendChild(btn);
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">还没有收款记录</div>';
  } catch (e) { toast('载入收款记录失败：' + e.message); }
}

/* ---------------- held orders (P2) ---------------- */
let heldItems = [];

async function loadHeldCount() {
  try {
    const d = await api('/api/held');
    heldItems = d.items || [];
    $('held-count').textContent = heldItems.length ? '(' + heldItems.length + ')' : '';
  } catch (_) { /* offline */ }
}

async function holdCart() {
  if (!cart.size) { toast('购物车是空的'); return; }
  const payload = { items: [], discount_cents: cartTotals().discount };
  cart.forEach(({ p, qty, disc }) => payload.items.push({
    product_id: p.id, name: p.name, price_cents: p.price_cents, qty,
    discount_cents: disc || 0,
  }));
  try {
    const d = await api('/api/held', {
      method: 'POST', body: JSON.stringify({ payload }),
    });
    cart.clear();
    $('cart-discount').value = '0';
    renderCart();
    toast('已挂单 ' + d.hold_no);
    loadHeldCount();
  } catch (e) { toast('挂单失败：' + e.message); }
}

function openHeld() {
  const box = $('held-list');
  box.innerHTML = '';
  if (!heldItems.length) box.innerHTML = '<div class="cart-empty">没有挂单</div>';
  heldItems.forEach((h) => {
    const items = (h.payload && h.payload.items) || [];
    const total = items.reduce((a, it) => a + Math.round(it.price_cents * it.qty), 0) -
      ((h.payload && h.payload.discount_cents) || 0);
    const row = document.createElement('div');
    row.className = 'li';
    row.innerHTML =
      '<span class="grow"><span class="t">' + esc(h.hold_no) + ' · ' +
      items.map((it) => esc(it.name) + '×' + it.qty).join('，') +
      '</span><span class="s">' + esc((h.created_at || '').replace('T', ' ').slice(0, 19)) +
      ' · ' + esc(h.cashier) + '</span></span>' +
      '<span class="amt">' + fmt(Math.max(0, total)) + '</span>';
    const resume = document.createElement('button');
    resume.className = 'replay';
    resume.textContent = '取回';
    resume.onclick = () => resumeHeld(h);
    const del = document.createElement('button');
    del.className = 'replay';
    del.textContent = '删';
    del.onclick = async () => {
      if (!confirm('删除挂单 ' + h.hold_no + '？')) return;
      try {
        await api('/api/held/' + h.id, { method: 'DELETE' });
        await loadHeldCount();
        openHeld();
      } catch (e) { toast('删除失败：' + e.message); }
    };
    row.appendChild(resume);
    row.appendChild(del);
    box.appendChild(row);
  });
  $('held-modal').classList.remove('hidden');
}

async function resumeHeld(h) {
  if (cart.size && !confirm('购物车已有商品，取回挂单将替换它，继续？')) return;
  let payload = (h && h.payload) || {};
  try {
    const d = await api('/api/held/' + h.id + '/consume', { method: 'POST' });
    payload = (d.item && d.item.payload) || payload;
  } catch (e) { toast('取单失败：' + e.message); return; }
  cart.clear();
  (payload.items || []).forEach((it) => {
    cart.set(it.product_id, {
      p: { id: it.product_id, name: it.name, price_cents: it.price_cents, _snap: true },
      qty: it.qty, disc: it.discount_cents || 0,
    });
  });
  $('cart-discount').value = ((payload.discount_cents || 0) / 100).toFixed(2);
  $('held-modal').classList.add('hidden');
  renderCart();
  loadHeldCount();
  toast('已取回挂单 ' + h.hold_no);
}

/* ---------------- customers + credit (P2) ---------------- */
let customers = [];

async function loadCustomers() {
  const d = await api('/api/customers');
  customers = d.items || [];
}

let custOutstanding = {};
async function fillCustomerSelect() {
  try { await loadCustomers(); } catch (_) { /* keep cache */ }
  try {
    const d = await api('/api/credits');
    custOutstanding = {};
    (d.items || []).forEach((r) => {
      custOutstanding[r.customer_id] =
        (custOutstanding[r.customer_id] || 0) + r.outstanding_cents;
    });
  } catch (_) { /* warning is best-effort */ }
  const sel = $('co-customer');
  const keep = sel.value;
  sel.innerHTML = '<option value="">— 无 —</option>';
  customers.forEach((c) => {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name + (c.phone ? '  ' + c.phone : '');
    sel.appendChild(o);
  });
  if (keep) sel.value = keep;
  onCoCustomer();
}
function onCoCustomer() {
  const sel = $('co-customer');
  const c = customers.find((x) => String(x.id) === sel.value);
  const phoneEl = $('co-phone');
  if (c) {
    // only overwrite a phone the cashier has not typed over themselves
    if (!phoneEl.value || phoneEl.dataset.auto === phoneEl.value) {
      phoneEl.value = c.phone || '';
      phoneEl.dataset.auto = phoneEl.value;
    }
    const out = custOutstanding[c.id] || 0;
    $('co-outstanding').textContent = out > 0
      ? '⚠ 赊账未结 / Outstanding: ' + fmt(out) : '';
  } else {
    $('co-outstanding').textContent = '';
  }
}

function creditDepositCents() {
  const v = Math.round(parseFloat($('credit-deposit').value || '0') * 100);
  return isFinite(v) ? Math.max(0, v) : 0;
}
function updateCreditDue() {
  const { raw } = cartTotals();
  const dep = creditDepositCents();
  $('credit-due').textContent = fmt(Math.max(0, raw - dep));
  renderCreditQr();
}
function renderCreditQr() {
  const dep = creditDepositCents();
  const show = payMethod === 'CREDIT' && depositMethod === 'DUITNOW' && dep > 0;
  $('credit-qr').classList.toggle('hidden', !show);
  if (!show) return;
  $('credit-qr-name').textContent = settings.store_name || '';
  $('credit-qr-amt').textContent = fmt(dep);
  const payload = (settings.duitnow_qr_payload || '').trim();
  $('credit-qr-box').innerHTML =
    payload && emvIsValid(payload) ? qrSvgSafe(emvBuildDynamic(payload, dep), 5) : '';
}

async function loadCustomersPage() {
  try {
    await loadCustomers();
    renderCustomers();
    const d = await api('/api/credit');
    const box = $('credit-list');
    box.innerHTML = '';
    (d.items || []).forEach((s) => {
      const due = s.total_cents - s.paid_cents;
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML =
        '<span class="grow"><span class="t">' + esc(s.customer_name || '客户') +
        '</span><span class="s">' + esc(s.receipt_no) + ' · ' +
        esc((s.created_at || '').slice(0, 10)) + ' · 已付 ' + fmt(s.paid_cents) +
        ' / ' + fmt(s.total_cents) + '</span></span>' +
        '<span class="amt">' + fmt(due) + '</span>';
      const btn = document.createElement('button');
      btn.className = 'replay';
      btn.textContent = '还款';
      btn.onclick = async () => {
        const v = prompt('还款金额 RM（欠 ' + (due / 100).toFixed(2) + '）',
          (due / 100).toFixed(2));
        if (v === null) return;
        const cents = Math.round(parseFloat(v || '0') * 100);
        if (!cents || cents <= 0) { toast('金额不正确'); return; }
        try {
          const r = await api('/api/credit/' + s.id + '/repay', {
            method: 'POST', body: JSON.stringify({ amount_cents: cents }),
          });
          toast(r.remaining_cents ? '已还款，剩 ' + fmt(r.remaining_cents) : '已结清 ✅');
          loadCustomersPage();
        } catch (e) { toast('还款失败：' + e.message); }
      };
      row.appendChild(btn);
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">没有未结清的赊账</div>';
  } catch (e) { toast('载入客户失败：' + e.message); }
}

function renderCustomers() {
  const q = $('cust-search').value.trim().toLowerCase();
  const box = $('cust-list');
  box.innerHTML = '';
  customers
    .filter((c) => !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q))
    .forEach((c) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML =
        '<span class="grow"><span class="t">' + esc(c.name) + '</span>' +
        '<span class="s">' + esc(c.phone || '') +
        (c.note ? ' · ' + esc(c.note) : '') + '</span></span>' +
        (c.outstanding_cents > 0
          ? '<span class="badge low">欠 ' + fmt(c.outstanding_cents) + '</span>' : '');
      const eb = document.createElement('button');
      eb.className = 'replay'; eb.textContent = '编辑';
      eb.onclick = (ev) => { ev.stopPropagation(); openCustomer(c); };
      row.appendChild(eb);
      row.onclick = () => openCustomer(c);
      box.appendChild(row);
    });
  if (!box.children.length) box.innerHTML = '<div class="cart-empty">没有客户</div>';
}

function openCustomer(c) {
  $('cust-modal-title').textContent = c ? '编辑客户' : '新增客户';
  $('cust-id').value = c ? c.id : '';
  $('cust-name').value = c ? c.name : '';
  $('cust-phone').value = c ? (c.phone || '') : '';
  $('cust-note').value = c ? (c.note || '') : '';
  const cdEl = $('cust-del');
  if (cdEl) cdEl.classList.toggle('hidden', !c);
  $('customer-modal').classList.remove('hidden');
}

async function saveCustomer() {
  const body = {
    name: $('cust-name').value.trim(),
    phone: $('cust-phone').value.trim(),
    note: $('cust-note').value.trim(),
  };
  if (!body.name) { toast('请填客户姓名'); return; }
  if ($('cust-id').value) body.id = parseInt($('cust-id').value);
  try {
    await api('/api/customers', { method: 'POST', body: JSON.stringify(body) });
    $('customer-modal').classList.add('hidden');
    toast('客户已保存');
    loadCustomersPage();
  } catch (e) { toast('保存失败：' + e.message); }
}

/* ---------------- product image picker (P3) ---------------- */
function pickProductImage(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
    pendingProdImage = dataUrl.split(',')[1];
    const prev = $('prod-img-preview');
    prev.src = dataUrl;
    prev.classList.remove('hidden');
    $('prod-img-del').classList.remove('hidden');
  };
  img.src = url;
}

/* ---------------- reports + daily closing (P3) ---------------- */
const METHOD_LABEL = { CASH: '现金', DUITNOW: 'DuitNow QR', CARD: '刷卡', CREDIT: '赊账' };
let repRange = 'today';

function localDateStr(d) { return d.toLocaleDateString('sv-SE'); }

function rangeDates() {
  const now = new Date();
  const today = localDateStr(now);
  if (repRange === 'week') {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return [localDateStr(monday), today];
  }
  if (repRange === 'month') {
    return [today.slice(0, 8) + '01', today];
  }
  return [today, today];
}

async function loadReport() {
  try {
    const [from, to] = rangeDates();
    const d = await api('/api/reports/summary?date_from=' + from + '&date_to=' + to);
    $('rep-summary').innerHTML =
      '<div class="scard"><div class="k">单数</div><div class="v">' + d.sales_count + '</div></div>' +
      '<div class="scard"><div class="k">营业额</div><div class="v">' + fmt(d.total_cents) + '</div></div>' +
      '<div class="scard"><div class="k">折扣</div><div class="v">' + fmt(d.discount_cents) + '</div></div>';
    const m = $('rep-methods');
    m.innerHTML = '<div class="li"><span class="grow"><span class="t">按收款方式</span></span></div>';
    (d.by_method || []).forEach((x) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow">' + esc(METHOD_LABEL[x.method] || x.method) +
        ' · ' + x.n + ' 单</span><span class="amt">' + fmt(x.total) + '</span>';
      m.appendChild(row);
    });
    const t = $('rep-top');
    t.innerHTML = '<div class="li"><span class="grow"><span class="t">热销商品</span></span></div>';
    (d.top_products || []).forEach((x) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow">' + esc(x.name) + ' × ' + x.qty +
        '</span><span class="amt">' + fmt(x.total) + '</span>';
      t.appendChild(row);
    });
  } catch (_) { /* report is best-effort on this tab */ }
}

function renderClosingResult(c) {
  let html = '';
  (c.by_method || []).forEach((x) => {
    html += '<div class="row"><span>' + esc(METHOD_LABEL[x.method] || x.method) +
      '（' + x.n + ' 单）</span><span>' + fmt(x.total) + '</span></div>';
  });
  html += '<div class="row total"><span>全日总计</span><b>' + fmt(c.grand_total_cents) + '</b></div>';
  html += '<div class="row"><span>现金应有</span><span>' + fmt(c.cash_expected_cents) + '</span></div>';
  if (c.cash_counted_cents !== null && c.cash_counted_cents !== undefined) {
    const diff = c.cash_diff_cents;
    html += '<div class="row"><span>现金盘点</span><span>' + fmt(c.cash_counted_cents) +
      '</span></div><div class="row"><span>差额</span><b style="color:' +
      (diff === 0 ? 'var(--ok)' : 'var(--danger)') + '">' +
      (diff > 0 ? '+' : '') + fmt(diff) + '</b></div>';
  }
  $('closing-result').innerHTML = html;
}

async function openClosing() {
  $('closing-date').value = localDateStr(new Date());
  $('closing-counted').value = '';
  $('closing-result').innerHTML = '';
  $('closing-modal').classList.remove('hidden');
  loadClosings();
}

async function loadClosings() {
  try {
    const d = await api('/api/closings');
    const box = $('closing-list');
    box.innerHTML = '';
    (d.items || []).forEach((c) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML = '<span class="grow"><span class="t">' + esc(c.business_date) +
        '</span><span class="s">' + esc(c.closed_by) + ' · ' +
        esc((c.closed_at || '').replace('T', ' ').slice(0, 19)) + '</span></span>';
      row.onclick = async () => {
        const r = await api('/api/closings/' + c.business_date);
        renderClosingResult(r.closing.payload);
      };
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">还没有日结记录</div>';
  } catch (_) { /* modal still usable */ }
}

async function saveClosing() {
  const counted = $('closing-counted').value === ''
    ? null : Math.round(parseFloat($('closing-counted').value) * 100);
  try {
    const d = await api('/api/closings', {
      method: 'POST',
      body: JSON.stringify({
        business_date: $('closing-date').value, cash_counted_cents: counted,
      }),
    });
    renderClosingResult(d.closing);
    toast('日结完成 ✅');
    loadClosings();
  } catch (e) { toast('日结失败：' + e.message); }
}

/* ---------------- suppliers + purchases (P3) ---------------- */
let suppliers = [];
let currentPurchaseId = null;

async function loadSuppliers() {
  const d = await api('/api/suppliers');
  suppliers = d.items || [];
  renderSupplierRows();
}

function renderSupplierRows() {
  const box = $('sup-rows');
  if (!box) return;
  const q = (($('sup-search') || {}).value || '').trim().toLowerCase();
  box.innerHTML = '';
  suppliers
    .filter((sp) => !q || sp.name.toLowerCase().includes(q) ||
      (sp.phone || '').includes(q))
    .forEach((sp) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML =
        '<span class="grow"><span class="t">' + esc(sp.name) + '</span>' +
        '<span class="s">' +
        esc([sp.phone, sp.email].filter(Boolean).join(' · ') || '—') +
        (sp.note ? ' · ' + esc(sp.note) : '') + '</span></span>';
      const eb = document.createElement('button');
      eb.className = 'replay'; eb.textContent = '编辑';
      eb.onclick = () => openSupplier(sp);
      const db = document.createElement('button');
      db.className = 'replay danger-text'; db.textContent = '删除';
      db.onclick = async () => {
        if (!confirm('删除供应商「' + sp.name + '」？历史进货记录不受影响。')) return;
        try {
          await api('/api/suppliers/' + sp.id, { method: 'DELETE' });
          toast('供应商已删除');
          loadSuppliers();
        } catch (e) { toast('删除失败：' + e.message); }
      };
      row.appendChild(eb); row.appendChild(db);
      box.appendChild(row);
    });
  if (!box.children.length)
    box.innerHTML = '<div class="cart-empty">还没有供应商</div>';
}

function fillSupplierSelect(sel) {
  sel.innerHTML = '<option value="">（无供应商）</option>';
  suppliers.forEach((s) => {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  });
}

function openSupplier(s) {
  $('sup-id').value = s ? s.id : '';
  $('sup-name').value = s ? s.name : '';
  $('sup-phone').value = s ? (s.phone || '') : '';
  $('sup-email').value = s ? (s.email || '') : '';
  $('sup-note').value = s ? (s.note || '') : '';
  $('supplier-modal').classList.remove('hidden');
}

async function saveSupplier() {
  const body = {
    name: $('sup-name').value.trim(),
    phone: $('sup-phone').value.trim(),
    email: $('sup-email').value.trim(),
    note: $('sup-note').value.trim(),
  };
  if (!body.name) { toast('请填供应商名称'); return; }
  if ($('sup-id').value) body.id = parseInt($('sup-id').value);
  try {
    await api('/api/suppliers', { method: 'POST', body: JSON.stringify(body) });
    $('supplier-modal').classList.add('hidden');
    toast('供应商已保存');
    loadPurchasesPage();
  } catch (e) { toast('保存失败：' + e.message); }
}

async function loadPurchasesPage() {
  try {
    await loadSuppliers();
    try {
      const dd = await api('/api/purchase-drafts');
      const dbox = $('draft-list');
      dbox.innerHTML = '';
      $('draft-count').textContent = dd.items.length ? '（' + dd.items.length + '）' : '';
      (dd.items || []).forEach((dr) => {
        const row = document.createElement('div');
        row.className = 'li';
        row.innerHTML = '<span class="grow"><span class="t">' +
          esc(dr.invoice_no || '无单号') + ' · ' + esc(dr.supplier_name || '未选供应商') +
          '</span><span class="s">' + dr.line_count + ' 行 · ' +
          esc((dr.updated_at || '').replace('T', ' ').slice(0, 19)) +
          '</span></span><button class="btn small">继续核对</button>';
        row.querySelector('button').onclick = (e) => {
          e.stopPropagation();
          openDraftPage(dr.id);
        };
        row.onclick = () => openDraftPage(dr.id);
        dbox.appendChild(row);
      });
      if (!dbox.children.length)
        dbox.innerHTML = '<div class="cart-empty">没有未完成的草稿</div>';
    } catch (_) { /* drafts are admin-only; ignore for staff */ }
    const d = await api('/api/purchases');
    const box = $('pur-list');
    box.innerHTML = '';
    (d.items || []).forEach((p) => {
      const row = document.createElement('div');
      row.className = 'li';
      row.innerHTML =
        '<span class="grow"><span class="t">' +
        esc(p.purchase_no ? p.purchase_no + ' · ' : '') +
        esc(p.invoice_no || ('采购 #' + p.id)) + ' · ' + esc(p.supplier_name || '无供应商') +
        '</span><span class="s">' + esc((p.created_at || '').replace('T', ' ').slice(0, 19)) +
        ' · ' + esc(p.cashier) + '</span></span>' +
        (p.source === 'ocr' ? '<span class="badge train">OCR</span>' : '') +
        (p.is_reversed ? '<span class="badge void">已反冲</span>' : '') +
        '<span class="amt">' + fmt(p.total_cents) + '</span>';
      row.onclick = () => openPurchaseDetail(p.id);
      box.appendChild(row);
    });
    if (!box.children.length)
      box.innerHTML = '<div class="cart-empty">还没有采购记录</div>';
  } catch (e) { toast('载入采购失败：' + e.message); }
}

async function openPurchaseDetail(id) {
  try {
    const d = await api('/api/purchases/' + id);
    currentPurchaseId = id;
    const p = d.purchase;
    $('purd-title').textContent = '采购 ' + (p.purchase_no || '') +
      ' · ' + (p.invoice_no || '#' + p.id);
    let html = '<div class="row"><span>供应商</span><span>' +
      esc(p.supplier_name || '无') + '</span></div>';
    html += '<div class="row"><span>来源</span><span>' +
      (p.source === 'ocr' ? 'OCR 识别' : p.source === 'desktop_sync' ? '桌面同步' : '手动') +
      (p.invoice_date ? ' · 发票日期 ' + esc(p.invoice_date) : '') + '</span></div>';
    (d.items || []).forEach((it) => {
      const conv = it.conversion_factor && it.conversion_factor !== 1
        ? '（' + it.raw_qty + ' ' + esc(it.unit || '') + ' ×' + it.conversion_factor + '）'
        : '';
      html += '<div class="row"><span>' + esc(it.name) + ' × ' + it.qty + conv +
        ' @ ' + fmt(it.cost_cents) + '</span><span>' + fmt(it.line_total_cents) + '</span></div>';
      if (it.prev_cost_cents != null && it.prev_cost_cents > 0 &&
          it.prev_cost_cents !== it.cost_cents) {
        const pct = ((it.cost_cents - it.prev_cost_cents) * 100 /
          it.prev_cost_cents).toFixed(1);
        const up = it.cost_cents > it.prev_cost_cents;
        const hot = up && parseFloat(pct) >= 10;
        html += '<div class="row"><span style="' +
          (hot ? 'color:#b02a2a;font-weight:700' : 'color:#888') + '">' +
          (up ? '▲' : '▼') + ' 上次成本 ' + fmt(it.prev_cost_cents) +
          ' → ' + fmt(it.cost_cents) + '（' + (up ? '+' : '') + pct +
          '%）' + (hot ? ' ⚠️ 涨幅大' : '') + '</span><span></span></div>';
      }
    });
    if (p.discount_cents)
      html += '<div class="row"><span>折扣</span><span>−' + fmt(p.discount_cents) + '</span></div>';
    if (p.tax_cents)
      html += '<div class="row"><span>SST / Tax</span><span>' + fmt(p.tax_cents) + '</span></div>';
    if (p.delivery_fee_cents)
      html += '<div class="row"><span>运费</span><span>' + fmt(p.delivery_fee_cents) + '</span></div>';
    if (p.other_fee_cents)
      html += '<div class="row"><span>其他费用</span><span>' + fmt(p.other_fee_cents) + '</span></div>';
    html += '<div class="row total"><span>总计</span><b>' + fmt(p.total_cents) + '</b></div>';
    if (p.is_reversed) {
      html += '<div class="error-text">已撤销：' + esc(p.reversal_reason || '') +
        (p.reversed_by ? ' · ' + esc(p.reversed_by) : '') +
        (p.reversal_notes ? ' · ' + esc(p.reversal_notes) : '') + '</div>';
    }
    if ((d.audit || []).length) {
      html += '<h4 class="sec-title">入库审计</h4>';
      d.audit.forEach((a) => {
        html += '<div class="row"><span>' + esc(a.action) + '</span><span>' +
          esc(a.username) + ' · ' + esc((a.occurred_at || '').replace('T', ' ').slice(0, 19)) +
          '</span></div>';
      });
    }
    $('purd-body').innerHTML = html;
    $('purd-reverse').classList.toggle('hidden',
      !!p.is_reversed || !session || session.user.role !== 'ADMIN');
    $('purchase-detail-modal').classList.remove('hidden');
  } catch (e) { toast('载入采购失败：' + e.message); }
}

function reversePurchase() {
  if (!currentPurchaseId) return;
  $('reverse-modal').classList.remove('hidden');
}
async function confirmReverse() {
  try {
    const d = await api('/api/purchases/' + currentPurchaseId + '/reverse', {
      method: 'POST',
      body: JSON.stringify({
        reason: $('rev-reason').value,
        notes: $('rev-notes').value.trim(),
      }),
    });
    $('reverse-modal').classList.add('hidden');
    $('purchase-detail-modal').classList.add('hidden');
    toast(d.warning ? '已撤销。注意：' + d.warning : '已撤销进货');
    await loadCatalog();
    loadPurchasesPage();
  } catch (e) { toast('撤销失败：' + e.message); }
}

/* OCR invoice line parser: pull product rows out of the raw OCR text.
   Handles "NAME qty x price total", "NAME qty total" and "NAME RM amount".
   Header/total/tax lines are skipped; names are matched to the catalog. */
function parseInvoiceLines(text) {
  const SKIP = /(total|sub\s*total|tax|gst|sst|vat|change|cash|amount due|balance|invoice|date|tel|fax|thank|rounding|tender|items? sold|grand)/i;
  const out = [];
  (text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 4 || SKIP.test(line)) return;
    let m = line.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s*[xX×]\s*(?:RM\s*)?(\d+(?:\.\d{1,2})?)\s+(?:RM\s*)?(\d+(?:\.\d{1,2})?)\s*$/);
    if (m) {
      out.push({ name: m[1], qty: parseFloat(m[2]), cost: Math.round(parseFloat(m[3]) * 100) });
      return;
    }
    m = line.match(/^(.*?)\s+(\d+(?:\.\d+)?)\s+(?:RM\s*)?(\d+(?:\.\d{1,2})?)\s*$/);
    if (m && parseFloat(m[2]) > 0) {
      const q = parseFloat(m[2]);
      out.push({ name: m[1], qty: q, cost: Math.round((parseFloat(m[3]) * 100) / q) });
      return;
    }
    m = line.match(/^(.*?)\s+(?:RM\s*)(\d+(?:\.\d{1,2})?)\s*$/);
    if (m) out.push({ name: m[1], qty: 1, cost: Math.round(parseFloat(m[2]) * 100) });
  });
  return out.filter((i) => i.name.replace(/[^A-Za-z0-9]/g, '').length >= 2 && i.cost > 0 && i.qty > 0);
}

function matchProduct(name) {
  const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const n = norm(name);
  if (!n) return null;
  let best = null, bestScore = 0;
  products.forEach((p) => {
    const pn = norm(p.name);
    if (!pn) return;
    let score = 0;
    if (pn === n) score = 100;
    else if (pn.includes(n) || n.includes(pn)) score = 60;
    else {
      const words = n.split(' ').filter((w) => w.length >= 2);
      const hit = words.filter((w) => pn.includes(w)).length;
      score = words.length ? Math.round((hit / words.length) * 50) : 0;
    }
    if (score > bestScore) { bestScore = score; best = p; }
  });
  return bestScore >= 40 ? best : null;
}

function addPurLine(preset) {
  const row = document.createElement('div');
  row.className = 'pur-line';
  const sel = document.createElement('select');
  sel.className = 'pur-prod';
  products.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.name + '（库存 ' + p.stock_qty + '）';
    o.dataset.cost = p.cost_cents;
    sel.appendChild(o);
  });
  const qty = document.createElement('input');
  qty.type = 'number'; qty.min = '0'; qty.step = '1'; qty.value = '1'; qty.className = 'pur-qty';
  const cost = document.createElement('input');
  cost.type = 'number'; cost.min = '0'; cost.step = '0.10'; cost.className = 'pur-cost';
  cost.value = products.length ? (products[0].cost_cents / 100).toFixed(2) : '0';
  const del = document.createElement('button');
  del.className = 'qtybtn'; del.textContent = '✕';
  del.onclick = () => { row.remove(); purTotal(); };
  sel.onchange = () => {
    cost.value = (parseInt(sel.selectedOptions[0].dataset.cost || '0') / 100).toFixed(2);
    purTotal();
  };
  qty.oninput = purTotal;
  cost.oninput = purTotal;
  if (preset) {
    sel.value = String(preset.product_id);
    qty.value = preset.qty;
    cost.value = (preset.cost_cents / 100).toFixed(2);
  }
  row.appendChild(sel); row.appendChild(qty); row.appendChild(cost); row.appendChild(del);
  $('pur-lines').appendChild(row);
  purTotal();
}

function purFeesCents() {
  const g = (id) => Math.max(0, Math.round(parseFloat($(id).value || '0') * 100));
  return { discount: g('pur-fee-discount'), tax: g('pur-fee-tax'),
    delivery: g('pur-fee-delivery'), other: g('pur-fee-other') };
}
function purTotal() {
  const f = purFeesCents();
  let total = -f.discount + f.tax + f.delivery + f.other;
  document.querySelectorAll('.pur-line').forEach((row) => {
    const qty = parseFloat(row.querySelector('.pur-qty').value || '0');
    const cost = Math.round(parseFloat(row.querySelector('.pur-cost').value || '0') * 100);
    total += Math.round(cost * qty);
  });
  $('pur-total').textContent = fmt(total);
  return total;
}

async function openPurchase() {
  await loadSuppliers().catch(() => {});
  fillSupplierSelect($('pur-supplier'));
  $('pur-invoice').value = '';
  $('pur-date').value = '';
  ['pur-fee-discount', 'pur-fee-tax', 'pur-fee-delivery', 'pur-fee-other']
    .forEach((id) => { $(id).value = '0'; });
  ['pur-fee-discount', 'pur-fee-tax', 'pur-fee-delivery', 'pur-fee-other']
    .forEach((id) => { $(id).oninput = purTotal; });
  $('pur-lines').innerHTML = '';
  $('pur-ocr-status').textContent = '';
  $('pur-ocr-details').classList.add('hidden');
  addPurLine();
  $('purchase-modal').classList.remove('hidden');
}

async function savePurchase() {
  const items = [];
  document.querySelectorAll('.pur-line').forEach((row) => {
    const qty = parseFloat(row.querySelector('.pur-qty').value || '0');
    if (!qty || qty < 0) return;
    items.push({
      product_id: parseInt(row.querySelector('.pur-prod').value),
      qty,
      cost_cents: Math.max(0, Math.round(parseFloat(row.querySelector('.pur-cost').value || '0') * 100)),
    });
  });
  if (!items.length) { toast('请至少加一行采购明细'); return; }
  try {
    const d = await api('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({
        supplier_id: $('pur-supplier').value ? parseInt($('pur-supplier').value) : null,
        invoice_no: $('pur-invoice').value.trim(),
        invoice_date: $('pur-date').value || '',
        discount_cents: purFeesCents().discount,
        tax_cents: purFeesCents().tax,
        delivery_fee_cents: purFeesCents().delivery,
        other_fee_cents: purFeesCents().other,
        items,
      }),
    });
    $('purchase-modal').classList.add('hidden');
    toast('已入货 ✅ 总计 ' + fmt(d.total_cents));
    showCostAlerts(d.cost_alerts);
    await loadCatalog();
    renderPos();
    loadPurchasesPage();
  } catch (e) { toast('入货失败：' + e.message); }
}


/* ---------------- invoice parser + product matcher (original rules) --- */
function pad2(n) { return String(n).padStart(2, '0'); }
function isMoneyTok(t) {
  return /^RM/i.test(t) ||
    /^-?\d{1,3}([.,]\d{3})*([.,]\d{2})$/.test(t) ||
    /^-?\d+[.,]\d{2}$/.test(t);
}
function parseMoneyTok(tok) {
  if (tok === undefined || tok === null) return null;
  let t = String(tok).replace(/RM/i, '').trim();
  if (!t) return null;
  const neg = t.startsWith('-') || t.startsWith('−');
  t = t.replace(/[-−]/g, '');
  if (!/^[\d.,]+$/.test(t)) return null;
  const lastDot = t.lastIndexOf('.');
  const lastComma = t.lastIndexOf(',');
  let dec = -1;
  if (lastDot >= 0 && lastComma >= 0) dec = Math.max(lastDot, lastComma);
  else if (lastComma >= 0 && /,\d{2}$/.test(t)) dec = lastComma;
  else if (lastDot >= 0 && /\.\d{2}$/.test(t)) dec = lastDot;
  let intPart;
  let fracPart = '00';
  if (dec >= 0) {
    intPart = t.slice(0, dec).replace(/[.,]/g, '');
    fracPart = (t.slice(dec + 1) + '00').slice(0, 2);
  } else {
    intPart = t.replace(/[.,]/g, '');
  }
  if (!intPart) return null;
  const cents = parseInt(intPart, 10) * 100 + parseInt(fracPart, 10);
  return neg ? -cents : cents;
}
const PUR_UNITS = ['PCS', 'PC', 'CTN', 'CARTON', 'BOX', 'PKT', 'PACK', 'BTL',
  'BOTTLE', 'KG', 'G', 'L', 'ML', 'TIN', 'CAN', 'UNIT', 'SET', 'DOZEN', 'BAG'];
function parseInvoiceText(text) {
  const rawLines = (text || '').split(/\r?\n/);
  const res = { supplierGuess: '', invoiceNo: '', invoiceDate: '',
    discount: 0, tax: 0, delivery: 0, other: 0, invoiceTotal: null, lines: [] };
  const allText = rawLines.join('\n');
  for (const mm of allText.matchAll(
      /(?:invoice|inv|bill)\s*(?:no\.?|number|#)?\s*[:：]?\s*((?=[A-Z0-9\-\/]*\d)[A-Z0-9][A-Z0-9\-\/]{2,})/gi)) {
    if (/\d/.test(mm[1])) { res.invoiceNo = mm[1].replace(/\s/g, ''); break; }
  }
  let mDate = allText.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (mDate) {
    res.invoiceDate = mDate[1] + '-' + pad2(mDate[2]) + '-' + pad2(mDate[3]);
  } else {
    mDate = allText.match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (mDate) res.invoiceDate = mDate[3] + '-' + pad2(mDate[2]) + '-' + pad2(mDate[1]);
  }
  for (const ln of rawLines.slice(0, 8)) {
    const t = ln.trim();
    if (t.length >= 3 && !/(invoice|tax|resit|tel|fax|date|page|receipt)/i.test(t) &&
        /[A-Za-z\u4e00-\u9fff]/.test(t)) { res.supplierGuess = t; break; }
  }
  rawLines.forEach((raw) => {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 4) return;
    const up = line.toUpperCase();
    const toks = line.split(' ');
    const lastMoney = () => {
      for (let i = toks.length - 1; i >= 0; i--) {
        if (isMoneyTok(toks[i])) return parseMoneyTok(toks[i]);
      }
      return null;
    };
    if (/DISCOUNT|REBATE/.test(up)) {
      const v = lastMoney(); if (v !== null) res.discount += Math.abs(v);
      return;
    }
    if (/SST|GST|\bTAX\b/.test(up)) {
      const v = lastMoney(); if (v !== null) res.tax += Math.abs(v);
      return;
    }
    if (/DELIVERY|FREIGHT|SHIPPING|HANDLING|TRANSPORT/.test(up)) {
      const v = lastMoney(); if (v !== null) res.delivery += Math.abs(v);
      return;
    }
    if (/SERVICE CHARGE|OTHER CHARGE|SURCHARGE/.test(up)) {
      const v = lastMoney(); if (v !== null) res.other += Math.abs(v);
      return;
    }
    if (/GRAND TOTAL|TOTAL AMOUNT|AMOUNT DUE/.test(up) || /^TOTAL\b/.test(up)) {
      const v = lastMoney(); if (v !== null) res.invoiceTotal = v;
      return;
    }
    if (/SUB\s*-?\s*TOTAL/.test(up)) return;
    if (/^(INVOICE|TAX INVOICE|CASH BILL|TEL|FAX|PAGE|THANK|ADDRESS)/.test(up)) return;
    const moneyIdx = [];
    toks.forEach((t, i) => { if (isMoneyTok(t)) moneyIdx.push(i); });
    if (!moneyIdx.length) return;
    const lastI = moneyIdx[moneyIdx.length - 1];
    if (lastI !== toks.length - 1) return;
    const subtotal = parseMoneyTok(toks[lastI]);
    if (subtotal === null || subtotal < 0) return;
    let cost = null;
    let qty = 1;
    let unit = 'pcs';
    let nameEnd = lastI;
    const takeQtyUnit = (j) => {
      if (j >= 0 && /^[xX×]$/.test(toks[j])) j -= 1;  // "qty x cost" separator
      if (j >= 0 && PUR_UNITS.includes(toks[j].toUpperCase())) {
        unit = toks[j].toUpperCase(); j -= 1;
      }
      if (j >= 0 && /^\d+(?:\.\d+)?$/.test(toks[j])) {
        qty = parseFloat(toks[j]); j -= 1;
      }
      return j + 1;
    };
    if (moneyIdx.length >= 2) {
      const ci = moneyIdx[moneyIdx.length - 2];
      cost = parseMoneyTok(toks[ci]);
      nameEnd = takeQtyUnit(ci - 1);
    } else {
      nameEnd = takeQtyUnit(lastI - 1);
      cost = qty > 0 ? Math.round(subtotal / qty) : subtotal;
    }
    const name = toks.slice(0, nameEnd).join(' ').replace(/[.\s]+$/, '');
    if (name.replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, '').length < 2) return;
    if (!qty || qty <= 0) return;
    if (cost === null || cost < 0) cost = Math.round(subtotal / qty);
    res.lines.push({ rawText: line, rawName: name, qty, unit,
      costCents: cost, subtotalCents: subtotal });
  });
  return res;
}
function normalizeName(s) {
  let t = (s || '').toLowerCase();
  t = t.replace(/\bctn\b/g, ' carton ').replace(/\bpcs?\b/g, ' pcs ')
    .replace(/\bpk\b/g, ' pack ').replace(/\bbtl\b/g, ' bottle ');
  t = t.replace(/([a-z])0([a-z])/g, '$1o$2')
    .replace(/([a-z])1([a-z])/g, '$1i$2');
  return t.replace(/[^a-z0-9\u4e00-\u9fff.]/g, ' ').replace(/\s+/g, ' ').trim();
}
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function specTokens(norm) {
  return norm.match(/\d+(?:\.\d+)?\s*(?:ml|l|kg|g|pcs|pack)/g) || [];
}
function nameSimilarity(rawNorm, candNorm) {
  if (!rawNorm || !candNorm) return 0;
  if (rawNorm === candNorm) return 0.99;
  const lev = 1 - levenshtein(rawNorm, candNorm) /
    Math.max(rawNorm.length, candNorm.length);
  const ra = new Set(rawNorm.split(' '));
  const ca = new Set(candNorm.split(' '));
  let inter = 0;
  ra.forEach((t) => { if (ca.has(t)) inter += 1; });
  const jac = inter / Math.max(1, ra.size + ca.size - inter);
  let score = Math.max(lev * 0.72 + jac * 0.28,
    (candNorm.includes(rawNorm) || rawNorm.includes(candNorm)) ? 0.9 : 0);
  const rs = specTokens(rawNorm);
  const cs = specTokens(candNorm);
  if (rs.length && cs.length && !rs.some((t) => cs.includes(t))) score *= 0.45;
  return score;
}
function bestMatch(rawName) {
  const rn = normalizeName(rawName);
  if (!rn) return null;
  let best = null;
  let bestScore = 0;
  products.forEach((p) => {
    let sc = 0;
    if (p.barcode && rawName.trim() === p.barcode) sc = 1.0;
    else if (p.sku && rn === normalizeName(p.sku)) sc = 0.995;
    else sc = Math.max(nameSimilarity(rn, normalizeName(p.name)),
      nameSimilarity(rn, normalizeName(p.name_en || '')));
    if (sc > bestScore) { bestScore = sc; best = p; }
  });
  return best ? { product: best, score: bestScore } : null;
}
async function buildDraftFromOcr(text) {
  const parsed = parseInvoiceText(text);
  await loadSuppliers().catch(() => {});
  let sup = null;
  let supScore = 0;
  suppliers.forEach((sp) => {
    const sc = nameSimilarity(normalizeName(parsed.supplierGuess),
      normalizeName(sp.name));
    if (sc > supScore) { supScore = sc; sup = sp; }
  });
  if (supScore < 0.78) sup = null;
  let aliases = [];
  if (sup) {
    try {
      aliases = (await api('/api/supplier-aliases?supplier_id=' + sup.id)).items || [];
    } catch (_) { /* matching still works without memory */ }
  }
  const lines = parsed.lines.map((ln) => {
    const base = {
      raw_text: ln.rawText, raw_product_name: ln.rawName,
      quantity: ln.qty, unit: ln.unit,
      unit_cost_cents: ln.costCents, line_subtotal_cents: ln.subtotalCents,
      orig_quantity: ln.qty, orig_unit_cost_cents: ln.costCents,
      orig_line_subtotal_cents: ln.subtotalCents, user_modified: 0,
    };
    const al = aliases.find((a) => a.normalized_name === normalizeName(ln.rawName));
    if (al) {
      const p = products.find((x) => x.id === al.product_id);
      if (p) {
        return Object.assign(base, {
          matched_product_id: p.id, matched_product_name: p.name,
          match_confidence: 1.0, conversion_factor: al.conversion_factor,
        });
      }
    }
    const m = bestMatch(ln.rawName);
    return Object.assign(base, {
      matched_product_id: m && m.score >= 0.45 ? m.product.id : null,
      matched_product_name: m && m.score >= 0.45 ? m.product.name : null,
      match_confidence: m ? m.score : 0, conversion_factor: 1,
    });
  });
  const d = await api('/api/purchase-drafts', {
    method: 'POST',
    body: JSON.stringify({
      supplier_id: sup ? sup.id : null,
      supplier_name: sup ? sup.name : parsed.supplierGuess,
      invoice_no: parsed.invoiceNo, invoice_date: parsed.invoiceDate,
      ocr_raw_text: text,
      discount_cents: parsed.discount, tax_cents: parsed.tax,
      delivery_fee_cents: parsed.delivery, other_fee_cents: parsed.other,
      invoice_total_cents: parsed.invoiceTotal, lines,
    }),
  });
  return d.id;
}

async function purchaseOcr(file) {
  if (!file) return;
  $('pur-ocr-status').textContent = '识别中…（上传到服务器识别）';
  try {
    const b64 = await imageForDecode(file, 2000);
    const d = await api('/api/ocr/invoice', {
      method: 'POST', body: JSON.stringify({ image_base64: b64 }),
    });
    const text = (d.text || '').trim();
    $('pur-ocr-text').textContent = text;
    $('pur-ocr-details').classList.remove('hidden');
    const m = text.match(/INV[-\s]?[A-Z0-9][A-Z0-9-]{1,}/i) ||
      text.match(/Invoice\s*(?:No\.?|Number|#)?\s*[:：]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i);
    if (m) {
      $('pur-invoice').value = (m[1] || m[0]).replace(/\s/g, '');
      $('pur-ocr-status').textContent = '已识别单号，请核对';
    } else {
      $('pur-ocr-status').textContent = '已识别文字（没找到单号，请看原文手动填）';
    }
    $('pur-ocr-status').textContent = '正在生成草稿…';
    const draftId = await buildDraftFromOcr(text);
    $('purchase-modal').classList.add('hidden');
    $('pur-choose-modal').classList.add('hidden');
    toast('已生成 OCR 草稿，请核对后入库');
    openDraftPage(draftId);
  } catch (e) {
    $('pur-ocr-status').textContent = '识别失败：' + e.message;
  }
}

/* ---------------- barcode labels (P4) ---------------------------------- */
const C39 = { '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', 'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw', 'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn', 'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn', 'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww', 'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn', 'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn', 'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw', 'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '$': 'nwnwnwnnn', '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn' };
function code39Svg(text) {
  let x = 0;
  const rects = [];
  ('*' + text + '*').split('').forEach((ch) => {
    const pat = C39[ch] || C39[' '];
    for (let i = 0; i < 9; i++) {
      const wdt = pat[i] === 'w' ? 3 : 1;
      if (i % 2 === 0) rects.push('<rect x="' + x + '" y="0" width="' + wdt + '" height="40"/>');
      x += wdt;
    }
    x += 1;
  });
  return '<svg viewBox="0 0 ' + x + ' 40" fill="#000" preserveAspectRatio="none">' + rects.join('') + '</svg>';
}
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
function ean13CheckDigit(code12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(code12[i], 10) * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}
function isValidEan13(code) {
  return /^\d{13}$/.test(code) &&
    ean13CheckDigit(code.slice(0, 12)) === parseInt(code[12], 10);
}
function ean13Svg(code) {
  let seq = '101';
  const par = EAN_PARITY[parseInt(code[0], 10)];
  for (let i = 0; i < 6; i++) {
    const d = parseInt(code[1 + i], 10);
    seq += par[i] === 'L' ? EAN_L[d] : EAN_G[d];
  }
  seq += '01010';
  for (let i = 0; i < 6; i++) seq += EAN_R[parseInt(code[7 + i], 10)];
  seq += '101';
  let rects = '';
  let x = 8;
  for (const b of seq) {
    if (b === '1') rects += '<rect x="' + x + '" y="0" width="1" height="40"/>';
    x += 1;
  }
  return '<svg viewBox="0 0 ' + (x + 8) + ' 40" fill="#000" preserveAspectRatio="none">' +
    rects + '</svg>';
}
function barcodeSvg(code) {
  if (isValidEan13(code)) return ean13Svg(code);
  const clean = String(code).toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '');
  return clean ? code39Svg(clean) : '';
}
/* Original label spec: barcode + human-readable code + product name.
   No price on the label. */
function labelHtml(name, code) {
  const svg = barcodeSvg(code);
  if (!svg) return '';
  return '<div class="label">' + svg + '<div class="lcode">' + esc(code) +
    '</div><div class="lname">' + esc(name) + '</div></div>';
}
function printLabelsHtml(html) {
  if (!html) { toast('没有可打印的标签（条码无效）'); return; }
  $('print-area').innerHTML = html;
  window.print();
}
function printProductLabel() {
  const name = $('prod-name').value.trim();
  const code = ($('prod-barcode').value.trim() || $('prod-sku').value.trim());
  if (!name) { toast('先填商品名'); return; }
  if (!code) { toast('这个商品没有条码/SKU，没法打印条码标签'); return; }
  const n = Math.max(1, Math.min(50, parseInt(prompt('打印几张标签？', '1') || '1', 10) || 1));
  printLabelsHtml(labelHtml(name, code).repeat(n));
}

/* ---------------- receipt template (original layout) ---------------- */
function dispW(str) {
  let w = 0;
  for (const ch of String(str)) w += ch.codePointAt(0) > 255 ? 2 : 1;
  return w;
}
function truncW(str, W) {
  let out = '', w = 0;
  for (const ch of String(str)) {
    const cw = ch.codePointAt(0) > 255 ? 2 : 1;
    if (w + cw > W) break;
    out += ch; w += cw;
  }
  return out;
}
function centerLine(str, W) {
  const t = truncW(str, W);
  return ' '.repeat(Math.max(0, Math.floor((W - dispW(t)) / 2))) + t;
}
function padLine(left, right, W) {
  const gap = Math.max(1, W - dispW(left) - dispW(right));
  return truncW(left, W - dispW(right) - 1) + ' '.repeat(gap) + right;
}
const amt2 = (c) => (c / 100).toFixed(2);
/* One renderer for thermal print, the settings live preview and the
   e-receipt: same layout and toggles as the original app. */
function renderReceiptLines(sv, items, st) {
  st = st || settings;
  const W = Math.min(64, Math.max(24, parseInt(st.receipt_char_width || '40', 10) || 40));
  const on = (k) => st[k] !== '0';
  const L = [];
  const pushC = (txt) => { if (txt) L.push(centerLine(txt, W)); };
  pushC(st.store_name || 'CNKH POS');
  (st.store_address || '').split('\n').forEach(pushC);
  pushC(st.store_phone || '');
  (st.receipt_header || '').split('\n').forEach(pushC);
  if (sv.is_training) pushC('— 训练单 TRAINING · 非正式销售 —');
  if (sv.is_void) pushC('*** 已作废 VOID ***');
  L.push('-'.repeat(W));
  L.push(truncW('Receipt: ' + sv.receipt_no, W));
  if (on('receipt_show_datetime'))
    L.push(truncW('Date: ' + (sv.created_at || '').replace('T', ' ').slice(0, 19), W));
  if (on('receipt_show_cashier'))
    L.push(truncW('Cashier: ' + (sv.cashier || ''), W));
  L.push('-'.repeat(W));
  (items || []).forEach((it) => {
    L.push(truncW(it.name || 'Item', W));
    if (on('receipt_show_sku') && (it.sku || it.barcode))
      L.push(truncW('  SKU: ' + (it.sku || it.barcode), W));
    let left = '  ';
    if (on('receipt_show_qty')) left += it.qty + ' pcs';
    if (on('receipt_show_unit_price'))
      left += (on('receipt_show_qty') ? ' x ' : '') + 'RM ' + amt2(it.unit_price_cents);
    const gross = it.line_total_cents + (it.discount_cents || 0);
    L.push(padLine(left, amt2(gross), W));
    if (on('receipt_show_discount') && it.discount_cents)
      L.push(padLine('  Discount / 折扣', '−' + amt2(it.discount_cents), W));
  });
  L.push('-'.repeat(W));
  L.push(padLine('SUBTOTAL', amt2(sv.subtotal_cents), W));
  if (on('receipt_show_discount'))
    L.push(padLine('DISCOUNT', '−' + amt2(sv.discount_cents || 0), W));
  L.push(padLine('TOTAL', amt2(sv.total_cents), W));
  L.push(padLine('PAID', amt2(sv.paid_cents), W));
  if (on('receipt_show_change'))
    L.push(padLine('CHANGE', amt2(sv.change_cents || 0), W));
  if (sv.method === 'CREDIT')
    L.push(padLine('Outstanding / 欠款',
      amt2(Math.max(0, sv.total_cents - sv.paid_cents)), W));
  if (on('receipt_show_payment'))
    L.push(truncW('Payment: ' + (METHOD_LABEL[sv.method] || sv.method), W));
  if (sv.bank_ref) L.push(truncW('Ref: ' + sv.bank_ref, W));
  L.push('-'.repeat(W));
  (st.receipt_footer || '').split('\n').forEach(pushC);
  (st.receipt_notes || '').split('\n').forEach(pushC);
  return L;
}
function printReceipt() {
  if (!lastSaleDetail) return;
  const s = lastSaleDetail.sale;
  const items = lastSaleDetail.items || [];
  let html = '';
  try {
    html = '<img class="receipt-img" src="' +
      receiptCanvas(s, items).toDataURL('image/png') + '">';
  } catch (_) {
    html = '<pre class="receipt-print">' +
      esc(renderReceiptLines(s, items).join('\n')) + '</pre>';
  }
  const payload = (settings.duitnow_qr_payload || '').trim();
  if (settings.receipt_show_duitnow_qr === '1' && payload &&
      typeof emvIsValid === 'function' && emvIsValid(payload)) {
    html += '<div class="c">' + qrSvgSafe(payload, 4) +
      '</div><div class="c">DuitNow 扫码付款</div>';
  }
  $('print-area').innerHTML = html;
  window.print();
}
/* The original's built-in sample sale for the settings preview. */
const SAMPLE_SALE = {
  receipt_no: 'M20260904-0001', created_at: '2026-09-04T10:30:00',
  cashier: 'admin', method: 'CASH', subtotal_cents: 1850,
  discount_cents: 50, total_cents: 1800, paid_cents: 2000,
  change_cents: 200,
};
const SAMPLE_ITEMS = [
  { name: '螺丝钉 M4', sku: 'SCR-M4', qty: 2, unit_price_cents: 500,
    line_total_cents: 1000, discount_cents: 0 },
  { name: '强力胶', sku: 'GLU-01', qty: 1, unit_price_cents: 850,
    line_total_cents: 800, discount_cents: 50 },
];
function formSettings() {
  const g = (id) => $(id).value;
  const c = (id) => $(id).checked ? '1' : '0';
  return {
    store_name: g('set-store-name'), store_address: g('set-store-address'),
    store_phone: g('set-store-phone'), receipt_header: g('set-receipt-header'),
    receipt_footer: g('set-receipt-footer'), receipt_notes: g('set-receipt-notes'),
    receipt_char_width: g('set-receipt-width') || '40',
    receipt_show_sku: c('set-show-sku'), receipt_show_cashier: c('set-show-cashier'),
    receipt_show_datetime: c('set-show-datetime'),
    receipt_show_payment: c('set-show-payment'),
    receipt_show_change: c('set-show-change'),
    receipt_show_discount: c('set-show-discount'),
    receipt_show_unit_price: c('set-show-unit-price'),
    receipt_show_qty: c('set-show-qty'),
    receipt_show_duitnow_qr: c('set-show-qr'),
    duitnow_qr_payload: settings.duitnow_qr_payload || '',
  };
}
function renderReceiptPreview() {
  const el = $('receipt-preview');
  if (!el) return;
  try {
    const cv = receiptCanvas(SAMPLE_SALE, SAMPLE_ITEMS, formSettings());
    el.innerHTML = '';
    el.appendChild(cv);
  } catch (_) {
    el.textContent =
      renderReceiptLines(SAMPLE_SALE, SAMPLE_ITEMS, formSettings()).join('\n');
  }
}
