// ---------------------------------------------------------------------------
// geometry.js — turns a parsed word into initial threading geometry.
//
// Layout (three.js coords, y is up):
//   * Base rings 1..m are unit circles lying in the plane y = 0, centred on the
//     x axis and evenly spaced.  Ring i bounds the disk
//        { (x, 0, z) : (x - X_i)^2 + z^2 < 1 }.
//   * The word ring is a single closed curve that crosses exactly one disk per
//     letter — downward for a generator, upward for its inverse — and stays
//     clear of every disk in between.  Its class in pi_1 of the complement is
//     therefore precisely the typed word.
//
// Between letters the curve parks on a "lane": a line at y = 0, z = ZS + j*DZ.
// Every lane sits at z > 1, i.e. outside every disk, so lanes contribute no
// linking.  Each letter gets its own lane, so the curve never revisits one and
// never crosses itself.  The result sprawls like a comb — that is fine, and
// expected; relaxation under tension is what pulls it into a readable link.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

export const CFG = {
  R: 1,             // base ring radius
  SPACING: 2.7,     // centre-to-centre distance between base rings
  H: 1.15,          // how far above/below the plane an excursion reaches
  ZM: 1.8,          // staging depth in front of the rings
  ZS: 2.5,          // depth of the first lane
  DZ: 0.6,          // depth step between consecutive lanes
  XFAR_PAD: 1.9,    // how far past the last ring the return leg wraps
  MAXOFF: 0.62,     // max sideways offset of a crossing from a disk centre
  SEG: 0.13,        // target arc length between simulated points
  MIN_PTS: 24,
  MAX_PTS: 700,
  MAX_GAP: 0.45,    // waypoint densification, keeps the spline hugging corners
  PEG_R: 0.1,       // radius of the peg standing through each base ring
  PEG_CLEAR: 0.26,  // centre-line distance a strand must keep from a peg
  SLAB: 1.95,       // floor at -SLAB, ceiling at +SLAB
  HRET: 1.6,        // height of the word ring's return sweep in peg mode
  LANE_PAD: 1.3,    // first lane sits this far outside the ring of pegs
  LANE_STEP: 0.32,  // radial gap between consecutive lanes
  HOME_R: 0.85,     // radius of the word ring's collar around its own stump
  // Sideways offsets used for crossings in peg mode. Every one clears
  // PEG_CLEAR, alternates sides, and stays well inside the ring's rim.
  PEG_OFFSETS: [0.42, 0.59, 0.76],
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** x-coordinate of base ring `i` (1-based) when there are `m` base rings. */
export function baseCenterX(i, m) {
  return (i - (m + 1) / 2) * CFG.SPACING;
}

/** Number of simulated points for a curve of the given arc length. */
function pointCount(length) {
  return clamp(Math.round(length / CFG.SEG), CFG.MIN_PTS, CFG.MAX_PTS);
}

/**
 * Evenly spaced samples of a closed curve.
 *
 * getSpacedPoints(n) returns n+1 points spanning t = 0..1 inclusive, and on a
 * closed curve those endpoints are the same point. Keeping both would leave a
 * zero-length segment in the simulation, so the duplicate is dropped.
 */
function sampleClosed(curve) {
  const n = pointCount(curve.getLength());
  return curve.getSpacedPoints(n).slice(0, n);
}

/** A base ring: a unit circle in the y = 0 plane. */
export function buildBaseRing(i, m) {
  const cx = baseCenterX(i, m);
  const n = pointCount(2 * Math.PI * CFG.R);
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    pts.push(new THREE.Vector3(cx + CFG.R * Math.cos(a), 0, CFG.R * Math.sin(a)));
  }
  return pts;
}

/**
 * Spread repeated crossings of the same ring sideways so two excursions
 * through one disk never land on top of each other.
 */
function crossingOffsets(letters, pegged) {
  const counts = new Map();
  for (const l of letters) counts.set(l.gen, (counts.get(l.gen) || 0) + 1);
  const seen = new Map();
  return letters.map((l) => {
    const c = counts.get(l.gen);
    const p = seen.get(l.gen) || 0;
    seen.set(l.gen, p + 1);
    if (pegged) {
      // A peg occupies the centre of every base ring, so the word ring has to
      // thread the annulus beside it rather than straight down the middle.
      const tier = Math.min(CFG.PEG_OFFSETS.length - 1, Math.floor(p / 2));
      return (p % 2 === 0 ? 1 : -1) * CFG.PEG_OFFSETS[tier];
    }
    if (c === 1) return 0;
    const step = Math.min(0.42, 1.24 / (c - 1));
    return clamp((p - (c - 1) / 2) * step, -CFG.MAXOFF, CFG.MAXOFF);
  });
}

/** Insert points so no consecutive pair is further apart than CFG.MAX_GAP. */
function densify(corners) {
  const out = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    out.push(a);
    const d = a.distanceTo(b);
    const steps = Math.floor(d / CFG.MAX_GAP);
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      out.push(new THREE.Vector3().lerpVectors(a, b, t));
    }
  }
  return out;
}

/** A plain circle parked clear of the row — used when the word is empty. */
function idleRing(m) {
  const cx = m > 0 ? baseCenterX(m, m) + CFG.SPACING : 0;
  const n = pointCount(2 * Math.PI * CFG.R);
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    pts.push(new THREE.Vector3(cx + CFG.R * Math.cos(a), 0, CFG.R * Math.sin(a)));
  }
  return pts;
}

/**
 * Build the word ring.  `letters` is the parsed word; letters naming a ring
 * that does not exist are skipped (the UI warns about them separately).
 */
export function buildWordRing(letters, m, pegged = false) {
  const valid = letters.filter((l) => l.gen >= 1 && l.gen <= m);
  if (m <= 0 || valid.length === 0) return idleRing(m);

  const { H, ZM, ZS, DZ, R, XFAR_PAD } = CFG;
  const off = crossingOffsets(valid, pegged);
  const xs = valid.map((l, j) => baseCenterX(l.gen, m) + off[j]);
  const xFar = baseCenterX(m, m) + R + XFAR_PAD;

  const corners = [];
  const P = (x, y, z) => corners.push(new THREE.Vector3(x, y, z));

  for (let j = 0; j < valid.length; j++) {
    const x = xs[j];
    const zIn = ZS + j * DZ;
    const zOut = ZS + (j + 1) * DZ;
    // A generator dives down through its disk; its inverse rises up through it.
    const yA = valid[j].inv ? -H : H;
    const yB = -yA;

    P(x, 0, zIn);          // dock on this letter's lane
    P(x, yA, ZM);          // lift clear of the plane, still in front
    P(x, yA, 0.55);        // move in over (or under) the ring
    P(x, yA, 0);
    P(x, yA * 0.4, 0);
    P(x, 0, 0);            // *** the crossing: inside disk `gen`, and only it
    P(x, yB * 0.4, 0);
    P(x, yB, 0);
    P(x, yB, 0.55);        // back out in front, now on the far side of the plane
    P(x, yB, ZM);
    P(x, 0, zOut);         // dock on the next lane
  }

  // Wrap around the far end and run back along lane 0 to close the loop.
  const zLast = ZS + valid.length * DZ;
  P(xFar, 0, zLast);
  P(xFar, 0, ZS);
  P(xFar * 0.66 + xs[0] * 0.34, 0, ZS);
  P(xFar * 0.33 + xs[0] * 0.67, 0, ZS);

  const dense = densify(corners);
  return sampleClosed(new THREE.CatmullRomCurve3(dense, true, 'centripetal', 0.5));
}

/**
 * Full scene geometry for `ringCount` rings and a parsed word.
 * Returns one entry per ring, lowest index first.
 */
export function buildRings(ringCount, letters, pegged = false) {
  if (ringCount <= 0) return [];
  if (ringCount === 1) {
    return [{ index: 1, isWordRing: true, points: pegged ? idleRingRadial(1) : idleRing(0) }];
  }

  const m = ringCount - 1;
  const out = [];
  for (let i = 1; i <= m; i++) {
    out.push({
      index: i,
      isWordRing: false,
      points: pegged ? buildBaseRingRadial(i, ringCount) : buildBaseRing(i, m),
    });
  }
  out.push({
    index: ringCount,
    isWordRing: true,
    points: pegged
      ? buildWordRingRadial(letters, m, ringCount)
      : buildWordRing(letters, m, false),
  });
  return out;
}

// ---------------------------------------------------------------------------
// Peg mode: a radial "flower" layout.
//
// The base rings sit evenly around a circle centred on the origin — three of
// them make a triangle — so nothing sits at the centre and every peg has a
// genuine outward direction to travel in. Dilating the pegs away from the
// origin therefore separates every pair at once.
// ---------------------------------------------------------------------------

/** Distance from the origin to each peg, wide enough that base rings clear. */
export function pegRadius(m) {
  if (m <= 1) return 1.6;
  return Math.max(1.6, 1.38 / Math.sin(Math.PI / m));
}

/** Angle of base ring `i` in the flower. Starts at the top so 3 reads as a triangle. */
export function ringAngle(i, m) {
  return (2 * Math.PI * (i - 1)) / m - Math.PI / 2;
}

function centerOf(i, m) {
  const D = pegRadius(m);
  const a = ringAngle(i, m);
  return { x: D * Math.cos(a), z: D * Math.sin(a), a, D };
}

/** A point at polar (radius, angle) pushed `off` along the tangent, at height y. */
function polar(radius, a, off, y) {
  return new THREE.Vector3(
    radius * Math.cos(a) - off * Math.sin(a),
    y,
    radius * Math.sin(a) + off * Math.cos(a)
  );
}

export function buildBaseRingRadial(i, m) {
  const c = centerOf(i, m);
  const n = pointCount(2 * Math.PI * CFG.R);
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push(new THREE.Vector3(c.x + CFG.R * Math.cos(t), 0, c.z + CFG.R * Math.sin(t)));
  }
  return pts;
}

/** With no word to follow, the word ring simply sits on its own stump. */
function idleRingRadial(slots) {
  const c = centerOf(Math.max(1, slots), Math.max(1, slots));
  const n = pointCount(2 * Math.PI * CFG.R);
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = (2 * Math.PI * k) / n;
    pts.push(new THREE.Vector3(c.x + CFG.R * Math.cos(t), 0, c.z + CFG.R * Math.sin(t)));
  }
  return pts;
}

const wrapPi = (d) => {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

/**
 * The word ring for the flower layout.
 *
 * Each letter dives once through its ring's disk, offset sideways so it passes
 * beside the peg rather than through it. Between letters the curve parks on a
 * lane: a circle at y = 0 wide enough to clear every base ring, one lane per
 * letter so the path never revisits itself. The loop closes with a sweep lifted
 * above the plane, which is the only way back to the innermost lane without
 * cutting across the others.
 */
export function buildWordRingRadial(letters, m, slots = m + 1) {
  const valid = letters.filter((l) => l.gen >= 1 && l.gen <= m);
  if (m <= 0 || valid.length === 0) return idleRingRadial(slots);

  const { H, HRET, LANE_PAD, LANE_STEP, HOME_R } = CFG;
  const D = pegRadius(slots);
  const RM = D + 1.3; // staging radius, already outside every base ring
  const RL0 = D + LANE_PAD;
  const off = crossingOffsets(valid, true);
  const ang = valid.map((l) => ringAngle(l.gen, slots));

  // Choose which way round to travel between letters so the net angular travel
  // stays near zero.
  //
  // This matters far more than it looks. A peg runs from the floor to the
  // ceiling, so it is an infinite barrier: if the word ring's path winds around
  // one, it is threaded onto that peg permanently and no cut can ever free it.
  // Always taking the short way round accumulates a full turn about the whole
  // flower, which trapped the word ring on every peg — Borromean rings could be
  // snipped and would still refuse to come apart. Picking the direction that
  // keeps the running total near zero, and closing with exactly the opposite
  // total, leaves winding zero about every peg.
  const use = new Array(valid.length);
  use[0] = ang[0];
  for (let j = 1; j < valid.length; j++) {
    const d0 = wrapPi(ang[j] - use[j - 1]);
    const alt = d0 > 0 ? d0 - 2 * Math.PI : d0 + 2 * Math.PI;
    const cum = use[j - 1] - ang[0];
    use[j] = use[j - 1] + (Math.abs(cum + d0) <= Math.abs(cum + alt) ? d0 : alt);
  }

  const corners = [];
  const P = (r, a, o, y) => corners.push(polar(r, a, o, y));

  for (let j = 0; j < valid.length; j++) {
    const a = use[j];
    const o = off[j];
    const rIn = RL0 + j * LANE_STEP;
    const rOut = RL0 + (j + 1) * LANE_STEP;
    const yA = valid[j].inv ? -H : H;
    const yB = -yA;

    P(rIn, a, o, 0);        // dock on this letter's lane
    P(rIn, a, o, yA);       // lift clear of the plane
    P(RM, a, o, yA);        // run inward, passing over the ring
    P(D, a, o, yA);
    P(D, a, o, yA * 0.4);
    P(D, a, o, 0);          // *** the crossing: inside this disk, beside the peg
    P(D, a, o, yB * 0.4);
    P(D, a, o, yB);
    P(RM, a, o, yB);        // back out on the far side of the plane
    P(rOut, a, o, yB);
    P(rOut, a, o, 0);       // dock on the next lane

    if (j < valid.length - 1) {
      const d = use[j + 1] - a;
      const steps = Math.max(1, Math.round(Math.abs(d) / 0.22));
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        P(rOut, a + d * f, o + (off[j + 1] - o) * f, 0);
      }
    }
  }

  // Return sweep: lift above the plane, travel back over every lane, and drop
  // in just short of the first dock so the descent never shares a line with it.
  const last = valid.length - 1;
  const rLast = RL0 + valid.length * LANE_STEP;
  // Land just short of the first dock, and unwind exactly the angle the letters
  // travelled, so the closed loop encircles no peg.
  const aLand = ang[0] - 0.22;
  const aLift = use[last] + 0.22;
  // Step off the final dock before lifting, otherwise the rise shares a line
  // with the descent that just landed there and the curve pinches to nothing.
  P(rLast, use[last] + 0.11, off[last] * 0.5, 0);
  P(rLast, aLift, 0, 0);
  P(rLast, aLift, 0, HRET);
  const d = aLand - aLift;
  const steps = Math.max(4, Math.round(Math.abs(d) / 0.22) + 3);
  for (let s = 1; s <= steps; s++) {
    const f = s / steps;
    P(rLast + (RL0 - rLast) * f, aLift + d * f, 0, HRET);
  }
  P(RL0, aLand, 0, 0);      // descend outside every disk

  // Collar the word ring onto its own stump.
  //
  // Without this the word ring is the one component nothing drags: the hoops are
  // held by their pegs, but the word ring merely rests against them, so after a
  // snip it often stays sitting in the tangle instead of coming free. Slot
  // `slots` carries a stump of its own, and one turn around it captures the word
  // ring exactly the way each hoop is captured by its peg.
  //
  // The whole detour runs beneath the plane, so it crosses no disk and leaves
  // the word untouched. The turn contributes winding 1 about the stump and none
  // about any other peg, and the two arcs retrace each other so they cancel.
  const aHome = ringAngle(slots, slots);
  const rOut2 = RL0 + 0.45;
  const aEnter = ang[0] - 0.4;
  P(RL0, aEnter, 0, -HRET * 0.55);
  P(RL0, aEnter, 0, -HRET);
  const dIn = wrapPi(aHome - aEnter);
  const stepsIn = Math.max(3, Math.round(Math.abs(dIn) / 0.22));
  for (let s = 1; s <= stepsIn; s++) {
    P(RL0, aEnter + dIn * (s / stepsIn), 0, -HRET);
  }
  P(D + HOME_R, aHome, 0, -HRET);
  // One full turn around the stump, ramped in height so the ends stay apart.
  const turn = 22;
  for (let s = 0; s <= turn; s++) {
    const psi = aHome + (2 * Math.PI * s) / turn;
    const y = -HRET - 0.16 + 0.32 * (s / turn);
    corners.push(
      new THREE.Vector3(
        D * Math.cos(aHome) + HOME_R * Math.cos(psi),
        y,
        D * Math.sin(aHome) + HOME_R * Math.sin(psi)
      )
    );
  }
  P(rOut2, aHome, 0, -HRET + 0.16);
  const dOut = wrapPi(ang[0] - aHome);
  const stepsOut = Math.max(3, Math.round(Math.abs(dOut) / 0.22));
  for (let s = 1; s <= stepsOut; s++) {
    P(rOut2, aHome + dOut * (s / stepsOut), 0, -HRET + 0.16);
  }
  P(rOut2, ang[0], 0, -HRET * 0.55);
  P(RL0, ang[0], off[0] * 0.5, -0.35);

  const dense = densify(corners);
  return sampleClosed(new THREE.CatmullRomCurve3(dense, true, 'centripetal', 0.5));
}

/** One peg per base ring, standing through its centre and spanning the slab. */
export function buildPegs(ringCount) {
  if (ringCount <= 0) return [];
  const pegs = [];
  // One slot per ring. Slots 1..n-1 carry the base rings; the last carries the
  // word ring's own stump, so every ring has something to be dragged by.
  for (let i = 1; i <= ringCount; i++) {
    const c = centerOf(i, ringCount);
    pegs.push({ x: c.x, z: c.z, ylo: -CFG.SLAB, yhi: CFG.SLAB });
  }
  return pegs;
}
