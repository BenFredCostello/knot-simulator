// ---------------------------------------------------------------------------
// main.js — application state and UI wiring.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { createStage, VIEW_DIRS } from './scene.js';
import { buildRings, buildPegs, CFG } from './geometry.js';
import { Sim } from './physics.js';
import { Tube } from './tube.js';
import { parseWord, verifyBrunnian, wordToHTML, genLabel } from './word.js';

const PALETTE = [
  '#5ec8ff', '#ff6b8b', '#7ef0a0', '#ffd166', '#c792ea',
  '#ff9f5a', '#4dd8c4', '#f78fb3', '#9ad0ff', '#b8ff9e',
];

const TUBE_RADIUS = 0.085;
const TUBE_RADIAL = 9;
const SETTLE_FRAMES = 260;

const $ = (id) => document.getElementById(id);

const MODE_HINT = {
  pegs:
    'Each base ring is threaded on an upright peg between a hard floor and ceiling, ' +
    'so it cannot wander or slip off. Pull dilates the pegs outward from the origin — ' +
    'a peg at the centre stays put — and stops once the link is taut.',
  free:
    'No pegs, no bounds. Rings contract and drift apart under their own tension. ' +
    'Looser and more organic, but components can travel a long way.',
};

const state = {
  mode: 'pegs',
  ringCount: 3,
  wordText: "aba'b'",
  cutFrac: [],        // per ring (0-based): null, or where along the ring it is snipped
  pulling: false,
  spaceHeld: false,
  cutMode: false,
  tension: 1,
  autoSettle: true,
  settleFrames: 0,
  view: 'three',
};

const canvas = $('canvas');
const stage = createStage(canvas);
const sim = new Sim();

/** Per-ring render data, index-aligned with sim.strands. */
let rings = [];
let materials = [];
let lastTopology = -1;
let hovered = -1;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function currentWord() {
  return parseWord(state.wordText, Math.max(0, state.ringCount - 1));
}

function disposeTubes() {
  for (const r of rings) {
    if (!r.tube) continue;
    stage.scene.remove(r.tube.mesh);
    r.tube.dispose();
    r.tube = null;
  }
}

function rebuild({ refit = false } = {}) {
  const pegged = state.mode === 'pegs';
  const { letters } = currentWord();
  const spec = buildRings(state.ringCount, letters, pegged);

  // A base ring on a peg has to keep a hole wide enough for the word ring to
  // pass beside the peg, so it is pinned against Pull and floored against
  // Equalise. Radius 0.8 leaves a comfortable annulus outside the peg.
  const PEGGED_MIN = 2 * Math.PI * 0.8;
  // The word ring needs its own floor as well. Once a snip frees it, nothing
  // resists its contraction and it would shrink to a fat little donut with no
  // visible hole — it has separated, but it no longer reads as a ring.
  const WORD_MIN = 2 * Math.PI * 0.85;

  sim.setStrands(
    spec.map((r) => ({
      points: r.points,
      closed: true,
      shrink: pegged ? r.isWordRing : true,
      minLen: pegged ? (r.isWordRing ? WORD_MIN : PEGGED_MIN) : 0,
      // Hoops must not balloon past their peg spacing when equalising.
      maxLen: r.isWordRing ? 0 : 2 * Math.PI * 1.25,
    }))
  );

  const pegs = pegged ? buildPegs(state.ringCount) : [];
  sim.setPegs(pegs, CFG.PEG_CLEAR);
  sim.setSlab(pegged ? -CFG.SLAB : null, pegged ? CFG.SLAB : null);
  stage.setPegs(pegs, CFG.PEG_R);

  // Re-apply any snips at roughly the same place along each ring.
  for (let i = 0; i < spec.length; i++) {
    const frac = state.cutFrac[i];
    if (frac == null) continue;
    const n = sim.strands[i].n;
    sim.cut(i, Math.min(n - 1, Math.max(0, Math.round(frac * n) % n)));
  }

  disposeTubes();
  hovered = -1;
  rings = spec.map((r, i) => ({
    index: r.index,
    isWordRing: r.isWordRing,
    color: PALETTE[i % PALETTE.length],
    tube: null,
  }));

  syncMaterials();
  syncTubes(true);
  state.settleFrames = state.autoSettle ? SETTLE_FRAMES : 0;

  renderRingList();
  renderWord();
  clearVerdict();
  if (refit) stage.frame(sim.bounds(), VIEW_DIRS[state.view]);
}

function syncMaterials() {
  for (const m of materials) m.dispose();
  materials = rings.map((r) => {
    const col = new THREE.Color(r.color);
    return new THREE.MeshStandardMaterial({
      color: col,
      roughness: 0.34,
      metalness: 0.22,
      side: THREE.DoubleSide,
      emissive: col.clone().multiplyScalar(r.isWordRing ? 0.2 : 0.09),
    });
  });
}

/** Rebuild tube meshes whenever the point count or open/closed state changes. */
function syncTubes(force = false) {
  if (!force && sim.topologyVersion === lastTopology) return;
  lastTopology = sim.topologyVersion;

  for (let i = 0; i < rings.length; i++) {
    const s = sim.strands[i];
    if (!s) continue;
    const r = rings[i];
    if (r.tube && r.tube.n === s.n && r.tube.closed === s.closed) continue;
    if (r.tube) {
      stage.scene.remove(r.tube.mesh);
      r.tube.dispose();
    }
    r.tube = new Tube(s.n, s.closed, TUBE_RADIUS, TUBE_RADIAL, materials[i]);
    r.tube.mesh.userData.ring = i;
    stage.scene.add(r.tube.mesh);
  }
  renderRingList();
}

// ---------------------------------------------------------------------------
// Sidebar rendering
// ---------------------------------------------------------------------------

function renderRingList() {
  const ul = $('ringList');
  ul.innerHTML = '';
  rings.forEach((r, i) => {
    const s = sim.strands[i];
    const cut = s && !s.closed;
    const li = document.createElement('li');
    li.className = 'ring-item' + (r.isWordRing ? ' wordring' : '');
    li.innerHTML =
      `<span class="swatch" style="background:${r.color};color:${r.color}"></span>` +
      `<span class="ring-name">Ring ${r.index}</span>` +
      (cut
        ? '<span class="ring-tag cut">snipped &mdash; click to rejoin</span>'
        : r.isWordRing
          ? '<span class="ring-tag word">word ring</span>'
          : `<span class="ring-tag">generator ${genLabel(r.index)}</span>`);
    if (cut) {
      li.style.cursor = 'pointer';
      li.title = 'Rejoin this ring';
      li.addEventListener('click', () => {
        state.cutFrac[i] = null;
        rebuild();
        toast(`Ring ${r.index} rejoined.`, 'ok');
      });
    }
    ul.appendChild(li);
  });
}

function renderWord() {
  const { letters, errors, warnings } = currentWord();
  $('wordPretty').innerHTML = wordToHTML(letters);
  const msg = $('wordMsg');
  const input = $('wordInput');
  if (errors.length) {
    msg.className = 'msg bad';
    msg.textContent = errors[0];
    input.classList.add('err');
  } else if (warnings.length) {
    msg.className = 'msg';
    msg.textContent = warnings[0];
    input.classList.remove('err');
  } else {
    msg.className = 'msg';
    msg.textContent = '';
    input.classList.remove('err');
  }
}

function clearVerdict() {
  $('verifyOut').innerHTML = '';
}

function runVerify() {
  const genCount = Math.max(0, state.ringCount - 1);
  const { letters } = currentWord();
  const v = verifyBrunnian(letters, genCount);
  const out = $('verifyOut');

  let head;
  if (!v.enoughRings) {
    head = `<div class="verdict no">Not Brunnian<small>Needs at least 3 rings &mdash; you have ${state.ringCount}.</small></div>`;
  } else if (!v.nontrivial) {
    head = '<div class="verdict no">Not Brunnian<small>The word itself freely reduces to the identity, so the word ring is already unlinked. This is the unlink, not a Brunnian link.</small></div>';
  } else if (v.brunnian) {
    head = `<div class="verdict yes">Brunnian<small>The word is non-trivial, yet deleting any single generator kills it. Remove any one ring and all ${state.ringCount} fall apart.</small></div>`;
  } else {
    const bad = v.rows.filter((r) => !r.ok).map((r) => genLabel(r.gen));
    head = `<div class="verdict no">Not Brunnian<small>Survives deletion of ${bad.join(', ')} &mdash; the word ring stays linked after removing ${bad.length > 1 ? 'those rings' : 'that ring'}.</small></div>`;
  }

  const rows = v.rows
    .map((r) => {
      const res = r.reduced.length ? wordToHTML(r.reduced) : '1';
      return (
        `<div class="vrow"><span class="mark ${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</span>` +
        `<span class="lbl">del ${genLabel(r.gen)} →</span>` +
        `<span class="res ${r.ok ? 'empty' : ''}">${res}</span></div>`
      );
    })
    .join('');

  const full = `<div class="vrow"><span class="mark">∑</span><span class="lbl">full →</span>` +
    `<span class="res">${v.full.length ? wordToHTML(v.full) : '1'}</span></div>`;

  out.innerHTML = head + full + rows;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(text, kind = '') {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 2200);
}

function meshes() {
  return rings.filter((r) => r.tube).map((r) => r.tube.mesh);
}

/** Index of the nearest centre-line point of strand `si` to a world position. */
function nearestPoint(si, p) {
  const flat = sim.view(si);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < flat.length / 3; i++) {
    const dx = flat[i * 3] - p.x;
    const dy = flat[i * 3 + 1] - p.y;
    const dz = flat[i * 3 + 2] - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function setHover(idx) {
  if (hovered === idx) return;
  if (hovered >= 0 && materials[hovered]) {
    const r = rings[hovered];
    if (r) materials[hovered].emissive.setStyle(r.color).multiplyScalar(r.isWordRing ? 0.2 : 0.09);
  }
  hovered = idx;
  if (hovered >= 0 && materials[hovered]) {
    materials[hovered].emissive.setStyle(rings[hovered].color).multiplyScalar(0.6);
  }
}

canvas.addEventListener('pointermove', (e) => {
  if (!state.cutMode) {
    setHover(-1);
    return;
  }
  const hit = stage.pick(e, meshes());
  setHover(hit ? hit.object.userData.ring : -1);
});

canvas.addEventListener('pointerdown', (e) => {
  if (!state.cutMode || e.button !== 0) return;
  const hit = stage.pick(e, meshes());
  if (!hit) return;
  const si = hit.object.userData.ring;
  const strand = sim.strands[si];
  if (!strand.closed) {
    state.cutFrac[si] = null;
    rebuild();
    toast(`Ring ${rings[si].index} rejoined.`, 'ok');
    return;
  }
  const idx = nearestPoint(si, hit.point);
  state.cutFrac[si] = idx / strand.n;
  sim.cut(si, idx);
  syncTubes(true);
  toast(`Ring ${rings[si].index} snipped. Pull to see what comes free.`, 'bad');
});

$('addRing').addEventListener('click', () => {
  // The ring that was carrying the word becomes an ordinary base ring, and a
  // fresh word ring appears above it, so neither keeps an old snip.
  state.cutFrac[state.ringCount - 1] = null;
  state.ringCount += 1;
  state.cutFrac[state.ringCount - 1] = null;
  state.cutFrac.length = state.ringCount;
  rebuild({ refit: true });
});

$('removeRing').addEventListener('click', () => {
  if (state.ringCount <= 1) return;
  state.cutFrac[state.ringCount - 1] = null;
  state.ringCount -= 1;
  state.cutFrac[state.ringCount - 1] = null;
  state.cutFrac.length = state.ringCount;
  rebuild({ refit: true });
});

$('wordInput').addEventListener('input', (e) => {
  state.wordText = e.target.value;
  // The word ring is rebuilt from scratch, so its snip no longer applies.
  state.cutFrac[state.ringCount - 1] = null;
  rebuild();
});

$('invBtn').addEventListener('click', () => {
  const input = $('wordInput');
  input.value += "'";
  state.wordText = input.value;
  input.focus();
  state.cutFrac[state.ringCount - 1] = null;
  rebuild();
});

$('clearWord').addEventListener('click', () => {
  $('wordInput').value = '';
  state.wordText = '';
  rebuild();
});

function preset(ringCount, word) {
  state.ringCount = ringCount;
  state.wordText = word;
  state.cutFrac = [];
  $('wordInput').value = word;
  rebuild({ refit: true });
}

$('borromean').addEventListener('click', () => preset(3, "aba'b'"));
$('preset4').addEventListener('click', () => preset(4, "aba'b'cbab'a'c'"));

$('verifyBtn').addEventListener('click', runVerify);

$('pullBtn').addEventListener('click', () => {
  state.pulling = !state.pulling;
  $('pullBtn').classList.toggle('on', state.pulling);
});

$('equaliseBtn').addEventListener('click', () => {
  sim.equalise();
  const lens = sim.strands.map((_, i) => sim.strandLength(i));
  const mean = lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length);
  toast(`Equalising every ring toward ${mean.toFixed(1)} units.`, 'ok');
});

$('cutBtn').addEventListener('click', () => {
  state.cutMode = !state.cutMode;
  $('cutBtn').classList.toggle('danger-on', state.cutMode);
  $('stage').classList.toggle('cutting', state.cutMode);
  // OrbitControls owns the same canvas, so orbiting is parked while armed.
  stage.controls.enabled = !state.cutMode;
  if (!state.cutMode) setHover(-1);
  else toast('Cut tool armed — click a ring to snip it. Orbit is paused.');
});

$('resetBtn').addEventListener('click', () => {
  state.cutFrac = [];
  state.pulling = false;
  $('pullBtn').classList.remove('on');
  rebuild({ refit: true });
});

$('tension').addEventListener('input', (e) => {
  state.tension = parseFloat(e.target.value);
  $('tensionVal').textContent = `${state.tension.toFixed(1)}×`;
});

$('autoSettle').addEventListener('change', (e) => {
  state.autoSettle = e.target.checked;
});

document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state.mode === btn.dataset.mode) return;
    state.mode = btn.dataset.mode;
    document.querySelectorAll('.mode').forEach((b) => b.classList.toggle('on', b === btn));
    $('modeHint').textContent = MODE_HINT[state.mode];
    $('tensionLabel').textContent = state.mode === 'pegs' ? 'Spread speed' : 'Tension';
    state.cutFrac = [];
    state.pulling = false;
    $('pullBtn').classList.remove('on');
    rebuild({ refit: true });
  });
});

document.querySelectorAll('.view').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    document.querySelectorAll('.view').forEach((b) => b.classList.toggle('on', b === btn));
    stage.frame(sim.bounds(), VIEW_DIRS[state.view]);
  });
});

$('fitBtn').addEventListener('click', () => stage.frame(sim.bounds(), VIEW_DIRS[state.view]));

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target.tagName !== 'INPUT') {
    e.preventDefault();
    state.spaceHeld = true;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') state.spaceHeld = false;
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function updateHud() {
  const pulling = state.pulling || state.spaceHeld;
  const settling = state.settleFrames > 0 && !pulling;
  const cuts = sim.strands.filter((s) => !s.closed).length;
  const taut = pulling && sim.pegs.length && !sim.pegsMoving;
  $('hud').innerHTML =
    `<b>${state.ringCount}</b> rings &middot; <b>${sim.count}</b> points` +
    (sim.pegs.length ? ` &middot; ${sim.pegs.length} pegs` : '') +
    (cuts ? ` &middot; <b>${cuts}</b> snipped` : '') +
    (sim.equalising ? ' &middot; <b>equalising</b>' : '') +
    (taut ? ' &middot; <b>taut</b>' : pulling ? ' &middot; <b>pulling</b>' : settling ? ' &middot; settling' : '') +
    (state.cutMode ? ' &middot; <b>cut tool armed</b>' : '');
  $('stats').textContent = `three.js r169 · ${sim.count} sim points`;
}

function loop() {
  requestAnimationFrame(loop);
  frameOnce();
}

function frameOnce() {
  stage.resize();

  const manual = state.pulling || state.spaceHeld;
  const settling = state.settleFrames > 0;
  const pull = manual || settling;
  // Auto-settle pulls gently: enough to tidy the raw threading comb into a
  // readable link, not enough to lock it taut.
  const tension = manual ? state.tension : state.tension * 0.55;

  sim.step(pull, tension);
  if (settling) state.settleFrames = manual ? 0 : state.settleFrames - 1;

  syncTubes();
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].tube && sim.strands[i]) rings[i].tube.update(sim.view(i));
  }

  if (sim.pegs.length) stage.updatePegs(sim.pegs);
  // A tightened link ends up far smaller than it started, so track it.
  if (pull || sim.equalising) stage.follow(sim.bounds());
  stage.updateCamera();
  stage.renderer.render(stage.scene, stage.camera);
  updateHud();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.querySelector('.view[data-view="three"]').classList.add('on');
$('modeHint').textContent = MODE_HINT[state.mode];
$('tensionLabel').textContent = state.mode === 'pegs' ? 'Spread speed' : 'Tension';
$('wordInput').value = state.wordText;
rebuild();
stage.resize();
stage.frame(sim.bounds(), VIEW_DIRS.three, true);
requestAnimationFrame(loop);

// Exposed so the simulation can be poked from the browser console during a
// lecture — e.g. knotLab.sim.strandLength(2), or knotLab.state.tension = 3.
// `rings` is a getter because rebuild() replaces the array wholesale.
window.knotLab = {
  state,
  sim,
  stage,
  rebuild,
  frameOnce,
  runVerify,
  get rings() {
    return rings;
  },
};
