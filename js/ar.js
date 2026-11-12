import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CELL } from './routing.js';

const LEVEL = 0.55;        // altura de cada nível (m)
const TIER_LEVELS = 4;     // níveis por módulo; níveis acima empilham um novo módulo
const DEPTH = 1.1;         // profundidade da estante (m)

const COLORS = {
  frame: 0x1e3a8a, beam: 0xf97316, deck: 0x94a3b8,
  pallet: 0x9a6b3c, box: 0xc8a16a, floor: 0x9ca3af,
};

let active = null;
const _m = new THREE.Matrix4();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

const BIN_COLORS = [0xc8a16a, 0x38bdf8, 0x4ade80, 0xf472b6, 0xa78bfa, 0xfacc15];
const binColor = id => BIN_COLORS[String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0) % BIN_COLORS.length];

// Um módulo da estante: pilares, níveis e bins. Bin vazio (sem produto ou sem quantidade) não tem caixa.
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
      const pl = binMap.get(s.id + '|' + level + '|' + bin);
      if (!pl) continue;
      const px = bin === 1 ? -w / 4 : w / 4;
      box(rack, 0.5, 0.28, 0.45, binColor(pl.productId), px, y + 0.04 + 0.14, 0);
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

// Cenário: piso e estantes com bins. Nenhuma caixa ou palete no chão.
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

const dotGeo = new THREE.SphereGeometry(0.07, 12, 12);
const dotMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee });

function buildLeg(g, cells) {
  const grp = new THREE.Group();
  cells.forEach(c => {
    const m = new THREE.Mesh(dotGeo, dotMat);
    m.position.copy(at(c.x, c.y, 0.25));
    grp.add(m);
  });
  grp.visible = false;
  g.add(grp);
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
 *  - xr:      WebXR immersive-ar com rastreamento de posição (Android + Chrome + ARCore).
 *             O usuário toca no chão para fixar o armazém; a posição se mantém ao andar.
 *  - preview: visualização 3D interativa, para testes no computador.
 */
export async function startAR({ layout, shelves, placements = [], bins = [], plan, overlay, onCollect, startAt = 0 }) {
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
  const content = new THREE.Group();
  content.position.set(-layout.width * CELL / 2, 0, -layout.height * CELL / 2);
  world.add(content);
  world.visible = false;
  scene.add(world);

  // Mapeia cada bin preenchido (shelfId|nível|bin interno) para sua locação
  const binById = new Map(bins.map(b => [b.id, b]));
  const binMap = new Map();
  for (const p of placements) {
    const b = binById.get(p.binId);
    if (b && p.qty > 0) binMap.set(b.shelfId + '|' + b.level + '|' + b.binNo, p);
  }
  buildWarehouse(content, layout, shelves, binMap);
  const legs = plan.legs.map(leg => buildLeg(content, leg.cells));
  const marker = buildMarker();
  content.add(marker);

  const info = overlay.querySelector('#ar-info');
  let step = Math.min(startAt, plan.stops.length);
  let mode = 'preview';
  let note = '';
  let placed = false, scale = 1, session = null, hitSource = null, reticle = null;
  let controls = null, done = false;
  let anchor = null, lastHit = null, trackingEmulated = null;

  const refresh = () => {
    legs.forEach((g, i) => (g.visible = i === step));
    const stop = plan.stops[step];
    marker.visible = !!stop;
    if (stop) {
      const p = at(stop.cell.x, stop.cell.y);
      marker.position.set(p.x, 0, p.z);
    }
    const hint = (mode === 'xr' && !placed ? '<i>Aponte para o chão e toque para posicionar o armazém</i><br>' : '')
      + (note ? `<i>${esc(note)}</i><br>` : '');
    info.innerHTML = hint + (stop
      ? `<b>Parada ${step + 1}/${plan.stops.length} · Estante ${esc(stop.shelf.code)}</b><br>`
        + stop.items.map(i => `${i.qty}× ${esc(i.product.name)} · ${esc(i.address)}`).join('<br>')
      : '<b>Separação concluída ✅</b>');
  };

  const setScale = v => { scale = Math.min(3, Math.max(0.1, v)); world.scale.setScalar(scale); };

  overlay.querySelector('#ar-collect').onclick = () => {
    if (!plan.stops[step]) return;
    onCollect?.(step);
    step++;
    refresh();
  };
  overlay.querySelector('#ar-zoom-in').onclick = () => setScale(scale * 1.25);
  overlay.querySelector('#ar-zoom-out').onclick = () => setScale(scale / 1.25);
  overlay.querySelector('#ar-reset').onclick = () => {
    if (mode !== 'xr') return;
    placed = false;
    world.visible = false;
    if (reticle) reticle.visible = false;
    if (anchor) { anchor.delete?.(); anchor = null; }
    refresh();
  };
  overlay.querySelector('#ar-exit').onclick = () => stopAR();

  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', onResize);

  const teardown = () => {
    if (done) return;
    done = true;
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
    refresh();
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

    renderer.xr.setReferenceSpaceType('local');
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
      if (lastHit.createAnchor) {
        try {
          anchor = await lastHit.createAnchor();
        } catch (err) {
          console.warn('Âncora indisponível, usando posição fixa:', err);
        }
      }
      refresh();
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
      note = 'Não foi possível iniciar a RA (' + (err?.name || 'erro') + ': ' + (err?.message || 'sem detalhes') + '). Mostrando prévia 3D.';
      startPreview();
    }
  } else {
    note = 'RA indisponível neste navegador. Use o Chrome no Android com ARCore. Mostrando prévia 3D.';
    startPreview();
  }

  renderer.setAnimationLoop((_t, frame) => {
    if (mode === 'xr' && session && frame) {
      const refSpace = renderer.xr.getReferenceSpace();

      // Aviso quando o ARCore não está rastreando a posição do celular
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

      // Com âncora, o armazém segue o ponto real do chão à medida que o usuário anda
      if (anchor) {
        const ap = frame.getPose(anchor.anchorSpace, refSpace);
        if (ap) {
          _m.fromArray(ap.transform.matrix);
          world.position.setFromMatrixPosition(_m);
          world.quaternion.setFromRotationMatrix(_m);
        }
      }
    }
    controls?.update();
    renderer.render(scene, camera);
  });

  refresh();
  return self;
}
