import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CELL, buildGrid, planRoute } from './routing.js';

const LEVEL = 0.55;        // altura de cada nível (m)
const TIER_LEVELS = 4;     // níveis por módulo; níveis acima empilham um novo módulo
const DEPTH = 1.1;         // profundidade da estante (m)
const FLOOR_STEP = 0.05;   // ajuste manual da altura do piso (m)
const NEON = 0x39ff14;     // verde néon da trilha e das setas

const COLORS = { frame: 0x1e3a8a, beam: 0xf97316, deck: 0x94a3b8, box: 0xc19a6b, floor: 0x9ca3af };

let active = null;
const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shelfName = s => s.code || `Rua ${s.street} (${s.x},${s.y})`;
const at = (x, y, h = 0) => new THREE.Vector3(x * CELL + CELL / 2, h, y * CELL + CELL / 2);

const matCache = new Map();
const mat = (color, opts = {}) => {
  const k = `${color}|${JSON.stringify(opts)}`;
  if (!matCache.has(k)) matCache.set(k, new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts }));
  return matCache.get(k);
};

function box(parent, w, h, d, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

// Um módulo da estante: pilares, níveis e caixas nos bins com quantidade
function buildTier(rack, s, base, n, offset, w, hd, binMap) {
  const H = n * LEVEL;
  const hw = w / 2;
  for (const [x, z] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) {
    box(rack, 0.07, H + 0.1, 0.07, COLORS.frame, x, base + (H + 0.1) / 2, z);
  }
  for (let l = 0; l < n; l++) {
    const y = base + l * LEVEL;
    const level = offset + l + 1;
    box(rack, w, 0.04, DEPTH, COLORS.deck, 0, y + 0.02, 0);
    box(rack, w, 0.08, 0.05, COLORS.beam, 0, y + LEVEL, -hd);
    box(rack, w, 0.08, 0.05, COLORS.beam, 0, y + LEVEL, hd);
    for (const bin of [1, 2]) {
      if (!binMap.get(s.id + '|' + level + '|' + bin)) continue; // bin vazio: sem caixa
      const px = bin === 1 ? -w / 4 : w / 4;
      box(rack, 0.5, 0.28, 0.45, COLORS.box, px, y + 0.04 + 0.14, 0);
    }
  }
}

function buildRack(parent, s, binMap) {
  const levels = Math.max(1, s.levels || TIER_LEVELS);
  const rack = new THREE.Group();
  rack.position.copy(at(s.x, s.y, 0));
  parent.add(rack);

  const w = CELL * 0.9, hd = DEPTH / 2;
  let base = 0, built = 0;
  while (built < levels) {
    const n = Math.min(TIER_LEVELS, levels - built);
    buildTier(rack, s, base, n, built, w, hd, binMap);
    base += n * LEVEL;
    built += n;
  }
}

// Cenário: piso e estantes com caixas. Nenhum objeto no chão.
function buildWarehouse(g, layout, shelves, binMap) {
  const W = layout.width * CELL, H = layout.height * CELL;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(W, H),
    mat(COLORS.floor, { transparent: true, opacity: 0.6 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, H / 2);
  g.add(floor);
  for (const s of shelves) buildRack(g, s, binMap);
}

// Trilha em verde néon: pontos e setas indicando o sentido de cada trecho
const dotGeo = new THREE.SphereGeometry(0.07, 12, 12);
const dotMat = new THREE.MeshBasicMaterial({ color: NEON });
const arrowGeo = new THREE.ConeGeometry(0.16, 0.45, 12);
const arrowMat = new THREE.MeshBasicMaterial({ color: NEON });
const UP = new THREE.Vector3(0, 1, 0);

function buildLegGroup(cells) {
  const grp = new THREE.Group();
  cells.forEach(c => {
    const m = new THREE.Mesh(dotGeo, dotMat);
    m.position.copy(at(c.x, c.y, 0.06));
    grp.add(m);
  });
  for (let i = 0; i + 1 < cells.length; i++) {
    const a = at(cells[i].x, cells[i].y), b = at(cells[i + 1].x, cells[i + 1].y);
    const dir = b.clone().sub(a).setY(0).normalize();
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    arrow.position.copy(a).lerp(b, 0.5);
    arrow.position.y = 0.16;
    arrow.quaternion.setFromUnitVectors(UP, dir);
    grp.add(arrow);
  }
  grp.visible = false;
  return grp;
}

function buildMarker() {
  const grp = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.6, 20), new THREE.MeshBasicMaterial({ color: 0xfacc15 }));
  cone.rotation.x = Math.PI;
  cone.position.y = 1.2;
  grp.add(cone);
  grp.visible = false;
  return grp;
}

export function stopAR() { active?.stop(); }

/**
 * Modos:
 *  - xr:      WebXR immersive-ar com âncora no chão e rastreamento de posição (Android + ARCore).
 *  - preview: visualização 3D interativa, para testes no computador.
 * A rota começa na posição do usuário no momento em que o armazém é posicionado.
 */
export async function startAR({ layout, shelves, bins = [], placements = [], plan, collected = [], overlay, onCollect }) {
  stopAR();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.domElement.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:1';
  document.body.append(renderer.domElement);
  document.body.classList.add('ar-on');
  overlay.hidden = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 300);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 8, 5);
  scene.add(sun);

  const world = new THREE.Group();
  world.visible = false;
  scene.add(world);
  const content = new THREE.Group();
  content.position.set(-layout.width * CELL / 2, 0, -layout.height * CELL / 2);
  world.add(content);

  const binById = new Map(bins.map(b => [b.id, b]));
  const binMap = new Map();
  for (const p of placements) {
    const b = binById.get(p.binId);
    if (b && p.qty > 0) binMap.set(b.shelfId + '|' + b.level + '|' + b.binNo, p);
  }
  buildWarehouse(content, layout, shelves, binMap);

  const routeGroup = new THREE.Group();
  content.add(routeGroup);
  const marker = buildMarker();
  content.add(marker);

  const info = overlay.querySelector('#ar-info');
  const grid = buildGrid(layout, shelves);
  const blocked = new Set(shelves.map(s => `${s.x},${s.y}`));
  const doneSet = new Set(collected);
  const pending = plan.stops.map((s, i) => ({ ...s, origIndex: i })).filter(s => !doneSet.has(s.origIndex));

  let route = { stops: [], legs: [] };
  let legGroups = [];
  let step = 0;
  let mode = 'preview';
  let note = '';
  let placed = false, scale = 1, session = null, hitSource = null, reticle = null;
  let anchor = null, lastHit = null, trackingEmulated = null;
  let controls = null, closed = false;
  let fixedY = 0, floorOffset = 0;

  const refresh = () => {
    legGroups.forEach((g, i) => (g.visible = i === step));
    const stop = route.stops[step];
    marker.visible = !!stop;
    if (stop) {
      const p = at(stop.cell.x, stop.cell.y);
      marker.position.set(p.x, 0, p.z);
    }
    const ready = mode === 'preview' || placed;
    const hint = (mode === 'xr' && !placed ? '<i>Aponte para o chão e toque para posicionar o armazém</i><br>' : '')
      + (note ? `<i>${esc(note)}</i><br>` : '');
    let body = '';
    if (ready) {
      body = stop
        ? `<b>Parada ${step + 1}/${route.stops.length} · Estante ${esc(shelfName(stop.shelf))}</b><br>`
          + stop.items.map(i => `${i.qty}× ${esc(i.product.name)} · ${esc(i.address)}`).join('<br>')
        : '<b>Separação concluída ✅</b>';
    }
    info.innerHTML = hint + body;
  };

  const setScale = v => { scale = Math.min(3, Math.max(0.1, v)); world.scale.setScalar(scale); };

  const setRoute = r => {
    route = r;
    routeGroup.clear();
    legGroups = route.legs.map(leg => {
      const g = buildLegGroup(leg.cells);
      routeGroup.add(g);
      return g;
    });
    step = 0;
    refresh();
  };
  const planFrom = start => planRoute(grid, start, pending);

  // Célula livre mais próxima de (cx, cy)
  const nearestFree = (cx, cy) => {
    let best = null, bd = Infinity;
    for (let x = 0; x < layout.width; x++) {
      for (let y = 0; y < layout.height; y++) {
        if (blocked.has(`${x},${y}`)) continue;
        const d = Math.abs(x - cx) + Math.abs(y - cy);
        if (d < bd) { bd = d; best = { x, y }; }
      }
    }
    return best ?? layout.depot;
  };

  // Posição do usuário, convertida para a célula da grade, no momento do posicionamento
  const userStartCell = () => {
    scene.updateMatrixWorld(true);
    renderer.xr.getCamera().getWorldPosition(_v);
    content.worldToLocal(_v);
    const cx = Math.min(layout.width - 1, Math.max(0, Math.floor(_v.x / CELL)));
    const cy = Math.min(layout.height - 1, Math.max(0, Math.floor(_v.z / CELL)));
    return nearestFree(cx, cy);
  };

  const btn = id => overlay.querySelector(id);
  btn('#ar-collect').onclick = () => {
    const s = route.stops[step];
    if (!s) return;
    onCollect?.(s.origIndex);
    step++;
    refresh();
  };
  btn('#ar-zoom-in').onclick = () => setScale(scale * 1.25);
  btn('#ar-zoom-out').onclick = () => setScale(scale / 1.25);
  btn('#ar-floor-up').onclick = () => { floorOffset += FLOOR_STEP; };
  btn('#ar-floor-down').onclick = () => { floorOffset -= FLOOR_STEP; };
  btn('#ar-reset').onclick = () => {
    if (mode !== 'xr') return;
    placed = false;
    floorOffset = 0;
    world.visible = false;
    if (reticle) reticle.visible = false;
    if (anchor) { anchor.delete?.(); anchor = null; }
    setRoute({ stops: [], legs: [] });
  };
  btn('#ar-exit').onclick = () => stopAR();

  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', onResize);

  const teardown = () => {
    if (closed) return;
    closed = true;
    renderer.setAnimationLoop(null);
    controls?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    removeEventListener('resize', onResize);
    overlay.hidden = true;
    document.body.classList.remove('ar-on');
    if (active === self) active = null;
  };
  const stop = () => { session?.end().catch(() => {}); teardown(); };
  const self = { stop };
  active = self;

  const startPreview = () => {
    mode = 'preview';
    controls = new OrbitControls(camera, renderer.domElement);
    const span = Math.max(layout.width, layout.height) * CELL;
    camera.position.set(span * 0.6, span * 0.7, span * 0.9);
    controls.target.set(0, 0, 0);
    controls.update();
    placed = true;
    world.visible = true;
    setRoute(planFrom(layout.depot));
  };

  const startXR = async () => {
    renderer.xr.enabled = true;
    reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x22c55e }),
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    const attempts = [
      {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['dom-overlay', 'local-floor', 'anchors'],
        domOverlay: { root: overlay },
      },
      {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local-floor', 'anchors'],
      },
    ];
    let lastErr = null;
    for (const opts of attempts) {
      try {
        session = await navigator.xr.requestSession('immersive-ar', opts);
        break;
      } catch (err) {
        lastErr = err;
        console.warn('requestSession falhou com', Object.keys(opts).join(','), err);
      }
    }
    if (!session) throw lastErr;

    // Origem no chão quando disponível: a altura do piso fica correta desde o início
    renderer.xr.setReferenceSpaceType(session.enabledFeatures?.includes('local-floor') ? 'local-floor' : 'local');
    await renderer.xr.setSession(session);
    session.addEventListener('end', teardown);

    const viewer = await session.requestReferenceSpace('viewer');
    hitSource = await session.requestHitTestSource({ space: viewer });

    session.addEventListener('select', async () => {
      if (placed || !reticle.visible || !lastHit) return;
      placed = true;
      reticle.visible = false;
      world.visible = true;
      world.position.setFromMatrixPosition(reticle.matrix);
      fixedY = world.position.y;
      if (lastHit.createAnchor) {
        try {
          anchor = await lastHit.createAnchor();
        } catch (err) {
          console.warn('Âncora indisponível, usando posição fixa:', err);
        }
      }
      setRoute(planFrom(userStartCell()));
    });
    mode = 'xr';
    refresh();
  };

  let supported = false;
  if (navigator.xr) {
    supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  }

  if (supported) {
    try {
      await startXR();
    } catch (err) {
      console.warn('Falha ao iniciar WebXR:', err);
      session?.end().catch(() => {});
      session = null;
      renderer.xr.enabled = false;
      note = `Não foi possível iniciar a RA (${err?.name || 'erro'}: ${err?.message || 'sem detalhes'}). Mostrando prévia 3D.`;
      startPreview();
    }
  } else {
    note = 'RA indisponível neste navegador. Use o Chrome no Android com ARCore. Mostrando prévia 3D.';
    startPreview();
  }

  renderer.setAnimationLoop((_t, frame) => {
    if (mode === 'xr' && session && frame) {
      const refSpace = renderer.xr.getReferenceSpace();

      const vp = frame.getViewerPose(refSpace);
      if (vp && vp.emulatedPosition !== trackingEmulated) {
        trackingEmulated = vp.emulatedPosition;
        note = trackingEmulated
          ? 'Sem rastreamento de movimento: mova o celular devagar e aponte para um chão com textura.'
          : '';
        refresh();
      }

      if (!placed && hitSource) {
        const hits = frame.getHitTestResults(hitSource);
        if (hits.length) {
          const pose = hits[0].getPose(refSpace);
          if (pose) {
            lastHit = hits[0];
            reticle.visible = true;
            reticle.matrix.fromArray(pose.transform.matrix);
          }
        }
      }

      if (placed) {
        const ap = anchor ? frame.getPose(anchor.anchorSpace, refSpace) : null;
        if (ap) {
          // Ancorado: o armazém segue o ponto do chão (posição e giro no plano horizontal)
          _m.fromArray(ap.transform.matrix);
          _e.setFromRotationMatrix(_m, 'YXZ');
          world.position.set(_m.elements[12], _m.elements[13] + floorOffset, _m.elements[14]);
          world.rotation.set(0, _e.y, 0);
        } else {
          world.position.y = fixedY + floorOffset;
        }
      }
    }
    controls?.update();
    renderer.render(scene, camera);
  });

  refresh();
  return self;
}
