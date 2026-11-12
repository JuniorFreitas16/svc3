import { store, LIMITS } from './store.js';
import { buildGrid, planRoute, accessCells, key } from './routing.js';
import { startAR } from './ar.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cellSize = W => Math.max(14, Math.min(40, Math.floor(860 / W)));
const guard = fn => { try { fn(); } catch (err) { alert(err.message); } };

const selected = new Set();
let plan = null, planKey = '';
let collected = new Set();
let layoutMode = 'shelf';
let selShelfId = null;

const S = () => store.get();
const shelfById = id => S().shelves.find(s => s.id === id);
const binById = id => S().bins.find(b => b.id === id);
const shelfName = s => (s ? (s.code || `Rua ${s.street} (${s.x},${s.y})`) : '?');
const sortedBins = () => [...S().bins].sort((a, b) => a.street - b.street || a.level - b.level || a.seq - b.seq);
const binLabel = b => `${b.address} · ${shelfName(shelfById(b.shelfId))}`;

// ---------- Navegação ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.tab));
function show(name) {
  document.querySelectorAll('section').forEach(s => s.classList.toggle('active', s.id === name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ({ layout: renderLayout, placements: renderPlacements, pick: renderPick, catalog: renderCatalog })[name]?.();
}

// ---------- Catálogo ----------
function renderCatalog() {
  const { products, placements } = S();
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#product-list');
  list.innerHTML = '';
  products.filter(p => `${p.name} ${p.sku}`.toLowerCase().includes(q)).forEach(p => {
    const locs = placements.filter(pl => pl.productId === p.id)
      .map(pl => `${binById(pl.binId)?.address ?? '?'} · ${pl.qty} un.`).join(' | ') || 'sem locação';
    const row = document.createElement('div');
    row.className = 'card';
    row.innerHTML = `
      <input type="checkbox" ${selected.has(p.id) ? 'checked' : ''}>
      <div style="flex:1"><b>${esc(p.name)}</b> <span class="muted">${esc(p.sku)}</span>
        <div class="muted">${esc(locs)}</div></div>
      <button class="ghost" title="Remover">🗑</button>`;
    row.querySelector('input').onchange = e => {
      e.target.checked ? selected.add(p.id) : selected.delete(p.id);
      updateCount();
    };
    row.querySelector('button').onclick = () => {
      if (confirm(`Remover ${p.name}?`)) { selected.delete(p.id); store.removeProduct(p.id); }
    };
    list.append(row);
  });
  updateCount();
}
function updateCount() { $('#sel-count').textContent = `${selected.size} selecionado(s)`; }

$('#search').oninput = renderCatalog;
$('#p-add').onclick = () => {
  const name = $('#p-name').value.trim(), sku = $('#p-sku').value.trim();
  if (!name) return alert('Informe o nome do produto');
  store.addProduct({ name, sku: sku || '—' });
  $('#p-name').value = ''; $('#p-sku').value = '';
};
$('#make-pick').onclick = () => {
  if (!selected.size) return alert('Selecione ao menos um produto');
  show('pick');
};
$('#reset').onclick = () => {
  if (!confirm('Apagar todos os dados e restaurar o exemplo?')) return;
  selected.clear(); store.reset(); store.seed();
};

// ---------- Layout ----------
function setMode(m) {
  layoutMode = m;
  $('#mode-shelf').classList.toggle('primary', m === 'shelf');
  $('#mode-depot').classList.toggle('primary', m === 'depot');
}
$('#mode-shelf').onclick = () => setMode('shelf');
$('#mode-depot').onclick = () => setMode('depot');

$('#grid-apply').onclick = () => {
  const width = +$('#grid-w').value, height = +$('#grid-h').value;
  const { layout } = S();
  const depot = layout.depot.x < width && layout.depot.y < height ? layout.depot : { x: 0, y: Math.max(0, height - 1) };
  guard(() => store.setLayout({ width, height, depot }));
};

function renderLayout() {
  const { layout, shelves, bins } = S();
  $('#grid-w').value = layout.width;
  $('#grid-h').value = layout.height;
  drawMap($('#grid-canvas'), { highlightShelf: selShelfId });

  const sh = shelves.find(s => s.id === selShelfId);
  const info = $('#shelf-info');
  if (!sh) {
    info.innerHTML = '<p class="muted">Nenhuma estante selecionada.</p>';
    return;
  }
  const shBins = bins.filter(b => b.shelfId === sh.id)
    .sort((a, b) => a.level - b.level || a.binNo - b.binNo);
  info.innerHTML = `
    <div class="card"><b>Estante</b>
      rótulo <input id="sh-code" value="${esc(sh.code ?? '')}" size="8">
      níveis <input id="sh-levels" type="number" min="1" max="${LIMITS.maxLevels}" value="${sh.levels}" style="width:60px">
      <button class="primary" id="sh-save">Salvar</button>
      <button class="ghost" id="sh-del">Excluir</button>
      <span class="muted">rua ${sh.street} · posição ${sh.x},${sh.y}</span>
    </div>
    <div class="muted">Endereços: ${shBins.map(b => b.address).join(' · ')}</div>`;
  $('#sh-save').onclick = () => guard(() => store.updateShelf(sh.id, {
    code: $('#sh-code').value.trim() || null,
    levels: +$('#sh-levels').value,
  }));
  $('#sh-del').onclick = () => {
    if (!confirm('Excluir a estante, seus bins e locações?')) return;
    selShelfId = null;
    store.removeShelf(sh.id);
  };
}

function cellFromEvent(e, canvas) {
  const r = canvas.getBoundingClientRect();
  const cs = canvas.width / S().layout.width;
  return {
    x: Math.floor((e.clientX - r.left) * canvas.width / r.width / cs),
    y: Math.floor((e.clientY - r.top) * canvas.height / r.height / cs),
  };
}

$('#grid-canvas').onclick = e => {
  const { layout, shelves } = S();
  const c = cellFromEvent(e, $('#grid-canvas'));
  if (c.x < 0 || c.y < 0 || c.x >= layout.width || c.y >= layout.height) return;
  const shelfAt = shelves.find(s => s.x === c.x && s.y === c.y);

  if (layoutMode === 'depot') {
    if (shelfAt) return alert('Essa célula está ocupada por uma estante.');
    return guard(() => store.setLayout({ depot: c }));
  }
  if (shelfAt) { selShelfId = shelfAt.id; return renderLayout(); }
  if (key(c) === key(layout.depot)) return alert('Essa célula é a entrada.');

  const code = prompt('Rótulo da estante (opcional, ex.: A1):', '');
  if (code === null) return;
  const lastStreet = shelves.length ? shelves[shelves.length - 1].street : 1;
  const street = Number(prompt('Número da rua:', String(lastStreet)));
  if (!Number.isInteger(street) || street < 1) return alert('Número de rua inválido.');
  guard(() => { selShelfId = store.addShelf({ code: code.trim() || null, street, x: c.x, y: c.y, levels: 4 }).id; });
};

function drawMap(canvas, { route = null, stops = [], highlightShelf = null, collected: done = new Set() } = {}) {
  const { layout, shelves } = S();
  const W = layout.width, H = layout.height;
  const CS = cellSize(W);
  canvas.width = W * CS;
  canvas.height = H * CS;
  const g = canvas.getContext('2d');
  g.fillStyle = '#f1f5f9';
  g.fillRect(0, 0, canvas.width, canvas.height);

  g.strokeStyle = '#e2e8f0';
  for (let x = 0; x <= W; x++) { g.beginPath(); g.moveTo(x * CS, 0); g.lineTo(x * CS, H * CS); g.stroke(); }
  for (let y = 0; y <= H; y++) { g.beginPath(); g.moveTo(0, y * CS); g.lineTo(W * CS, y * CS); g.stroke(); }

  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '11px sans-serif';

  for (const s of shelves) {
    g.fillStyle = s.id === highlightShelf ? '#f59e0b' : '#334155';
    g.fillRect(s.x * CS + 2, s.y * CS + 2, CS - 4, CS - 4);
    g.fillStyle = '#fff';
    g.fillText(s.code || String(s.street), s.x * CS + CS / 2, s.y * CS + CS / 2);
  }

  const d = layout.depot;
  g.fillStyle = '#22c55e';
  g.fillRect(d.x * CS + 2, d.y * CS + 2, CS - 4, CS - 4);
  g.fillStyle = '#fff';
  g.fillText('E', d.x * CS + CS / 2, d.y * CS + CS / 2);

  if (route) {
    g.strokeStyle = '#2563eb';
    g.lineWidth = 3;
    for (const leg of route.legs) {
      if (!leg.cells.length) continue;
      g.beginPath();
      leg.cells.forEach((c, i) => {
        const px = c.x * CS + CS / 2, py = c.y * CS + CS / 2;
        i ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.stroke();
    }
    g.lineWidth = 1;
  }

  stops.forEach((s, i) => {
    const px = s.cell.x * CS + CS / 2, py = s.cell.y * CS + CS / 2;
    g.fillStyle = done.has(i) ? '#16a34a' : '#f97316';
    g.beginPath(); g.arc(px, py, 10, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    g.fillText(String(i + 1), px, py);
  });
}

// ---------- Locações (por endereço de bin) ----------
function renderPlacements() {
  const { products, placements } = S();
  const bins = sortedBins();
  const occupied = new Map(placements.map(p => [p.binId, p]));

  $('#pl-product').innerHTML = products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const free = bins.filter(b => !occupied.has(b.id));
  $('#pl-bin').innerHTML = free.length
    ? free.map(b => `<option value="${b.id}">${esc(binLabel(b))} · livre</option>`).join('')
    : '<option value="">Nenhum endereço livre</option>';

  const list = $('#placement-list');
  list.innerHTML = '';
  if (!products.length || !bins.length) {
    list.innerHTML = '<p class="muted">Cadastre produtos e estantes antes de criar locações.</p>';
  }
  placements.forEach(pl => {
    const options = bins
      .filter(b => !occupied.has(b.id) || occupied.get(b.id).id === pl.id)
      .map(b => `<option value="${b.id}" ${b.id === pl.binId ? 'selected' : ''}>${esc(binLabel(b))}</option>`)
      .join('');
    const row = document.createElement('div');
    row.className = 'card';
    row.innerHTML = `
      <div style="flex:1"><b>${esc(productById(pl.productId)?.name ?? '?')}</b></div>
      <select data-f="bin">${options}</select>
      qtd <input data-f="qty" type="number" min="0" value="${pl.qty}" style="width:80px">
      <button class="primary">Salvar</button>
      <button class="ghost">🗑</button>`;
    const bin = row.querySelector('[data-f="bin"]');
    const qty = row.querySelector('[data-f="qty"]');
    const [save, del] = row.querySelectorAll('button');
    save.onclick = () => guard(() => store.updatePlacement(pl.id, { binId: bin.value, qty: +qty.value || 0 }));
    del.onclick = () => store.removePlacement(pl.id);
    list.append(row);
  });
}

function productById(id) { return S().products.find(p => p.id === id); }

$('#pl-add').onclick = () => {
  const productId = $('#pl-product').value, binId = $('#pl-bin').value;
  const qty = +$('#pl-qty').value || 0;
  if (!productId || !binId) return alert('Selecione produto e endereço livre');
  guard(() => store.place({ productId, binId, qty }));
};

// ---------- Separação ----------
function buildPlan() {
  const { products, placements, shelves, layout } = S();
  const grid = buildGrid(layout, shelves);
  const groups = new Map();
  const missing = [];

  products.filter(p => selected.has(p.id)).forEach(p => {
    const locs = placements.filter(pl => pl.productId === p.id && pl.qty > 0);
    if (!locs.length) missing.push(p.name);
    locs.forEach(pl => {
      const b = binById(pl.binId);
      const shelf = b && shelfById(b.shelfId);
      if (!shelf) return;
      if (!groups.has(shelf.id)) groups.set(shelf.id, { shelf, items: [] });
      groups.get(shelf.id).items.push({ product: p, address: b.address, qty: pl.qty });
    });
  });

  const stops = [...groups.values()].map(g => ({
    shelf: g.shelf,
    items: g.items,
    access: accessCells(grid, g.shelf),
  }));
  const result = planRoute(grid, layout.depot, stops);
  result.missing = missing;
  return result;
}

function renderPick() {
  const s = S();
  const k = JSON.stringify([[...selected].sort(), s.placements, s.bins, s.shelves, s.layout]);
  if (!plan || k !== planKey) {
    plan = buildPlan();
    planKey = k;
    collected = new Set();
  }

  const warnings = [
    ...plan.missing.map(n => `${n}: sem estoque em nenhum endereço`),
    ...plan.unreachable.map(sh => `${shelfName(sh.shelf)}: inacessível`),
  ];
  $('#pick-summary').innerHTML = !selected.size
    ? '<p class="muted">Selecione produtos no Catálogo para gerar a separação.</p>'
    : `<div><b>${plan.stops.length}</b> parada(s) · <b>${plan.steps}</b> passo(s) no total · ${collected.size}/${plan.stops.length} coletada(s)</div>`
      + (warnings.length ? `<div style="color:#b45309;width:100%">${warnings.map(esc).join('<br>')}</div>` : '');

  const list = $('#pick-list');
  list.innerHTML = plan.stops.map((st, i) => `
    <div class="card" style="${collected.has(i) ? 'opacity:.5' : ''}">
      <div style="flex:1"><b>${i + 1}. ${esc(shelfName(st.shelf))}</b>
        <div class="muted">${st.items.map(it => `${it.qty}× ${esc(it.product.name)} · ${esc(it.address)}`).join(' · ')}</div>
      </div>
      <button class="ghost" data-i="${i}">${collected.has(i) ? 'Desfazer' : 'Coletado'}</button>
    </div>`).join('');
  list.querySelectorAll('button').forEach(b => b.onclick = () => {
    const i = +b.dataset.i;
    collected.has(i) ? collected.delete(i) : collected.add(i);
    renderPick();
  });

  drawMap($('#route-canvas'), { route: plan, stops: plan.stops, collected });
}

$('#open-ar').onclick = () => {
  if (!plan?.stops.length) return alert('Nenhuma parada para exibir em RA.');
  const next = plan.stops.findIndex((_, i) => !collected.has(i));
  if (next === -1) return alert('Todos os itens já foram coletados.');
  const { layout, shelves, bins, placements } = S();
  startAR({
    layout, shelves, bins, placements, plan,
    overlay: $('#ar-overlay'),
    startAt: next,
    onCollect: i => { collected.add(i); renderPick(); },
  });
};

// ---------- Inicialização ----------
if (!S().products.length && !S().shelves.length) store.seed();

const renders = { catalog: renderCatalog, layout: renderLayout, placements: renderPlacements };
store.subscribe(() => renders[document.querySelector('section.active')?.id]?.());

setMode('shelf');
renderCatalog();
