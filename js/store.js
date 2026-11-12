const KEY = 'svc-digital-warehouse:v2';
const uid = () => Math.random().toString(36).slice(2, 10);
const pad2 = n => String(n).padStart(2, '0');

export const LIMITS = { maxWidth: 52, maxHeight: 40, maxLevels: 12, binsPerLevel: 2 };

const DEFAULT = () => ({
  layout: { width: LIMITS.maxWidth, height: 12, depot: { x: 0, y: 11 } },
  shelves: [],       // { id, code (opcional), street, x, y, levels }
  bins: [],          // { id, shelfId, street, level, binNo (1|2, interno), seq, address }
  products: [],      // { id, sku, name }
  placements: [],    // { id, productId, binId, qty }
  seqCounters: {},   // "rua|nível" -> último número emitido (endereços removidos não são reaproveitados)
  history: [],       // { at, msg }
});

let state = load();
const subs = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...DEFAULT(), ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEFAULT();
  }
}

function commit(msg) {
  if (msg) {
    state.history.push({ at: new Date().toISOString(), msg });
    state.history = state.history.slice(-200);
  }
  localStorage.setItem(KEY, JSON.stringify(state));
  subs.forEach(fn => fn(state));
}

// Endereço N{rua}-{nível}-{posição}, posição sequencial por (rua, nível)
function nextSeq(street, level) {
  const k = `${street}|${level}`;
  state.seqCounters[k] = (state.seqCounters[k] || 0) + 1;
  return state.seqCounters[k];
}

function createBins(shelf, fromLevel, toLevel) {
  for (let level = fromLevel; level <= toLevel; level++) {
    for (let binNo = 1; binNo <= LIMITS.binsPerLevel; binNo++) {
      const seq = nextSeq(shelf.street, level);
      state.bins.push({
        id: uid(), shelfId: shelf.id, street: shelf.street, level, binNo, seq,
        address: `N${shelf.street}-${pad2(level)}-${pad2(seq)}`,
      });
    }
  }
}

function validatePlacement(p, exceptId = null) {
  const bin = state.bins.find(b => b.id === p.binId);
  if (!bin) throw new Error('Endereço de bin não encontrado');
  if (!state.products.some(x => x.id === p.productId)) throw new Error('Produto não encontrado');
  if (!Number.isInteger(p.qty) || p.qty < 0) throw new Error('A quantidade deve ser um inteiro não negativo');
  const taken = state.placements.find(x => x.id !== exceptId && x.binId === p.binId);
  if (taken) throw new Error(`O endereço ${bin.address} já está ocupado`);
}

export const store = {
  get: () => state,
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

  setLayout(patch) {
    const next = { ...state.layout, ...patch };
    if (!(next.width >= 3 && next.width <= LIMITS.maxWidth && next.height >= 3 && next.height <= LIMITS.maxHeight)) {
      throw new Error(`Largura de 3 a ${LIMITS.maxWidth} e altura de 3 a ${LIMITS.maxHeight} células`);
    }
    if (state.shelves.some(s => s.x >= next.width || s.y >= next.height)) {
      throw new Error('Há estantes fora do novo tamanho');
    }
    const d = next.depot;
    if (d.x >= next.width || d.y >= next.height || state.shelves.some(s => s.x === d.x && s.y === d.y)) {
      throw new Error('A entrada precisa estar em uma célula livre dentro da grade');
    }
    state.layout = next;
    commit('layout alterado');
  },

  addProduct({ sku, name }) {
    const p = { id: uid(), sku, name };
    state.products.push(p);
    commit(`produto criado: ${name}`);
    return p;
  },
  removeProduct(id) {
    state.products = state.products.filter(p => p.id !== id);
    state.placements = state.placements.filter(p => p.productId !== id);
    commit('produto removido');
  },

  addShelf({ code = null, street, x, y, levels = 4 }) {
    if (!Number.isInteger(street) || street < 1) throw new Error('Número de rua inválido');
    if (!Number.isInteger(levels) || levels < 1 || levels > LIMITS.maxLevels) {
      throw new Error(`Níveis de 1 a ${LIMITS.maxLevels}`);
    }
    if (state.shelves.some(s => s.x === x && s.y === y)) throw new Error('Já existe estante nesta célula');
    const d = state.layout.depot;
    if (d.x === x && d.y === y) throw new Error('Esta célula é a entrada');
    const shelf = { id: uid(), code, street, x, y, levels };
    state.shelves.push(shelf);
    createBins(shelf, 1, levels);
    commit(`estante criada: ${code || `rua ${street}`}`);
    return shelf;
  },
  // Rua e posição não mudam após a criação, para os endereços continuarem estáveis
  updateShelf(id, patch) {
    if ('street' in patch) throw new Error('A rua não pode ser alterada após a criação da estante');
    const shelf = state.shelves.find(s => s.id === id);
    if (!shelf) throw new Error('Estante não encontrada');
    if (patch.levels !== undefined && patch.levels !== shelf.levels) {
      if (!Number.isInteger(patch.levels) || patch.levels < 1 || patch.levels > LIMITS.maxLevels) {
        throw new Error(`Níveis de 1 a ${LIMITS.maxLevels}`);
      }
      if (patch.levels < shelf.levels) {
        const removed = state.bins.filter(b => b.shelfId === id && b.level > patch.levels).map(b => b.id);
        if (state.placements.some(p => removed.includes(p.binId))) {
          throw new Error('Há locações nos níveis que seriam removidos');
        }
        state.bins = state.bins.filter(b => !removed.includes(b.id));
      } else {
        createBins(shelf, shelf.levels + 1, patch.levels);
      }
      shelf.levels = patch.levels;
    }
    if ('code' in patch) shelf.code = patch.code || null;
    commit(`estante editada: ${shelf.code || `rua ${shelf.street}`}`);
  },
  removeShelf(id) {
    const binIds = state.bins.filter(b => b.shelfId === id).map(b => b.id);
    state.placements = state.placements.filter(p => !binIds.includes(p.binId));
    state.bins = state.bins.filter(b => b.shelfId !== id);
    state.shelves = state.shelves.filter(s => s.id !== id);
    commit('estante removida');
  },

  place({ productId, binId, qty }) {
    const p = { id: uid(), productId, binId, qty };
    validatePlacement(p);
    state.placements.push(p);
    commit('locação criada');
    return p;
  },
  updatePlacement(id, patch) {
    const p = state.placements.find(x => x.id === id);
    const next = { ...p, ...patch };
    validatePlacement(next, id);
    const before = { binId: p.binId, qty: p.qty };
    Object.assign(p, patch);
    commit(`locação alterada: ${JSON.stringify(before)} → ${JSON.stringify({ binId: p.binId, qty: p.qty })}`);
  },
  removePlacement(id) {
    state.placements = state.placements.filter(p => p.id !== id);
    commit('locação removida');
  },

  reset() { state = DEFAULT(); commit('reset'); },

  seed() {
    state = DEFAULT();
    const mk = (code, street, x, y, levels) => {
      const shelf = { id: uid(), code, street, x, y, levels };
      state.shelves.push(shelf);
      createBins(shelf, 1, levels);
      return shelf;
    };
    const A1 = mk('A1', 17, 2, 1, 8);
    const A2 = mk('A2', 17, 2, 3, 4);
    const A3 = mk('A3', 17, 2, 5, 4);
    const B1 = mk('B1', 18, 6, 1, 4);
    const B2 = mk('B2', 18, 6, 3, 4);
    const B3 = mk('B3', 18, 6, 5, 4);
    const binOf = (shelf, level, binNo) =>
      state.bins.find(b => b.shelfId === shelf.id && b.level === level && b.binNo === binNo).id;

    const P = [
      { id: uid(), sku: 'P-001', name: 'Parafuso M6 (cx. 100)' },
      { id: uid(), sku: 'C-010', name: 'Cabo HDMI 2m' },
      { id: uid(), sku: 'F-220', name: 'Filtro de ar' },
      { id: uid(), sku: 'M-500', name: 'Mouse USB' },
    ];
    state.products.push(...P);
    state.placements.push(
      { id: uid(), productId: P[0].id, binId: binOf(A1, 2, 1), qty: 100 },
      { id: uid(), productId: P[1].id, binId: binOf(B2, 1, 1), qty: 30 },
      { id: uid(), productId: P[1].id, binId: binOf(B2, 1, 2), qty: 0 },   // bin vazio
      { id: uid(), productId: P[2].id, binId: binOf(A1, 6, 2), qty: 6 },
      { id: uid(), productId: P[2].id, binId: binOf(A3, 3, 1), qty: 8 },
      { id: uid(), productId: P[3].id, binId: binOf(B1, 2, 1), qty: 12 },
      { id: uid(), productId: P[3].id, binId: binOf(B3, 1, 1), qty: 5 },
    );
    commit('dados de exemplo carregados');
  },
};
