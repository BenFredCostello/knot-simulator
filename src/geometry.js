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
  MAX_PTS: 560,
  MAX_GAP: 0.45,    // waypoint densification, keeps the spline hugging corners
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
function crossingOffsets(letters) {
  const counts = new Map();
  for (const l of letters) counts.set(l.gen, (counts.get(l.gen) || 0) + 1);
  const seen = new Map();
  return letters.map((l) => {
    const c = counts.get(l.gen);
    const p = seen.get(l.gen) || 0;
    seen.set(l.gen, p + 1);
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
export function buildWordRing(letters, m) {
  const valid = letters.filter((l) => l.gen >= 1 && l.gen <= m);
  if (m <= 0 || valid.length === 0) return idleRing(m);

  const { H, ZM, ZS, DZ, R, XFAR_PAD } = CFG;
  const off = crossingOffsets(valid);
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
  const curve = new THREE.CatmullRomCurve3(dense, true, 'centripetal', 0.5);
  return curve.getSpacedPoints(pointCount(curve.getLength()));
}

/**
 * Full scene geometry for `ringCount` rings and a parsed word.
 * Returns one entry per ring, lowest index first.
 */
export function buildRings(ringCount, letters) {
  if (ringCount <= 0) return [];
  if (ringCount === 1) return [{ index: 1, isWordRing: true, points: idleRing(0) }];

  const m = ringCount - 1;
  const out = [];
  for (let i = 1; i <= m; i++) {
    out.push({ index: i, isWordRing: false, points: buildBaseRing(i, m) });
  }
  out.push({ index: ringCount, isWordRing: true, points: buildWordRing(letters, m) });
  return out;
}
