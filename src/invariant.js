// ---------------------------------------------------------------------------
// invariant.js — read the link's topology back out of the simulated geometry.
//
// Distance checks cannot detect a strand passing through another: the two are
// never observed close together, because the passage happens between position
// updates. What does detect it is a quantity that can only change when a
// passage occurs.
//
// For each hoop we build a spanning surface — a triangle fan from its centroid
// out to its own edges — and then walk the word ring from start to finish,
// recording every crossing of every surface in the order they happen, with
// sign. That sequence is a word in the free group on the hoops, and it is
// exactly the class of the word ring in pi_1 of their complement. It does not
// care how large or tangled the configuration is, which is what makes it usable
// where dragging components apart is not.
//
// Caveat worth stating: this is a homotopy invariant, not an isotopy one. It
// cannot tell an unlink from a Whitehead-style clasp. It is sharp enough for
// what it is used for here — catching the frame on which the link stops being
// the link that was built.
// ---------------------------------------------------------------------------

const EPS = 1e-12;

/** Triangle fan spanning a closed polyline, wound consistently with it. */
export function spanningFan(flat) {
  const n = flat.length / 3;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < flat.length; i += 3) {
    cx += flat[i];
    cy += flat[i + 1];
    cz += flat[i + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const tris = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) {
    const a = i * 3;
    const b = ((i + 1) % n) * 3;
    const o = i * 9;
    tris[o] = cx;
    tris[o + 1] = cy;
    tris[o + 2] = cz;
    tris[o + 3] = flat[a];
    tris[o + 4] = flat[a + 1];
    tris[o + 5] = flat[a + 2];
    tris[o + 6] = flat[b];
    tris[o + 7] = flat[b + 1];
    tris[o + 8] = flat[b + 2];
  }
  return tris;
}

/**
 * Möller–Trumbore, restricted to the segment. Returns the parameter along the
 * segment and the sign of the crossing, or null.
 */
function hit(px, py, pz, dx, dy, dz, t, o) {
  const e1x = t[o + 3] - t[o];
  const e1y = t[o + 4] - t[o + 1];
  const e1z = t[o + 5] - t[o + 2];
  const e2x = t[o + 6] - t[o];
  const e2y = t[o + 7] - t[o + 1];
  const e2z = t[o + 8] - t[o + 2];

  const hx = dy * e2z - dz * e2y;
  const hy = dz * e2x - dx * e2z;
  const hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (det > -EPS && det < EPS) return null; // parallel

  const inv = 1 / det;
  const sx = px - t[o];
  const sy = py - t[o + 1];
  const sz = pz - t[o + 2];
  const u = inv * (sx * hx + sy * hy + sz * hz);
  if (u < 0 || u > 1) return null;

  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = inv * (dx * qx + dy * qy + dz * qz);
  if (v < 0 || u + v > 1) return null;

  const s = inv * (e2x * qx + e2y * qy + e2z * qz);
  if (s < 0 || s > 1) return null;

  // Sign from which way the segment pierces the surface.
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  return { s, sign: dx * nx + dy * ny + dz * nz > 0 ? 1 : -1 };
}

/**
 * The word traced by `path` through the spanning surfaces in `fans`.
 * `fans` is [{ gen, tris }]. Returns [{ gen, inv }] in traversal order.
 */
export function traceWord(path, fans, closed = true) {
  const n = path.length / 3;
  const segs = closed ? n : n - 1;
  const out = [];
  const found = [];
  for (let i = 0; i < segs; i++) {
    const a = i * 3;
    const b = ((i + 1) % n) * 3;
    const px = path[a];
    const py = path[a + 1];
    const pz = path[a + 2];
    const dx = path[b] - px;
    const dy = path[b + 1] - py;
    const dz = path[b + 2] - pz;
    found.length = 0;
    for (const fan of fans) {
      const t = fan.tris;
      for (let o = 0; o < t.length; o += 9) {
        const h = hit(px, py, pz, dx, dy, dz, t, o);
        if (h) found.push({ s: h.s, gen: fan.gen, inv: h.sign < 0 });
      }
    }
    // One segment can pierce several surfaces; take them in the order the
    // segment actually meets them.
    if (found.length > 1) found.sort((x, y) => x.s - y.s);
    for (const f of found) out.push({ gen: f.gen, inv: f.inv });
  }
  return out;
}

/** Cancel adjacent inverse pairs, then cancel across the closing seam. */
export function cyclicReduce(word) {
  const out = [];
  for (const l of word) {
    const top = out[out.length - 1];
    if (top && top.gen === l.gen && top.inv !== l.inv) out.pop();
    else out.push({ gen: l.gen, inv: l.inv });
  }
  while (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (a.gen === b.gen && a.inv !== b.inv) {
      out.shift();
      out.pop();
    } else break;
  }
  return out;
}

export function wordText(word) {
  return word.map((l) => String.fromCharCode(96 + l.gen) + (l.inv ? "'" : '')).join('') || '1';
}

/** True if `a` is a cyclic rotation of `b` (both already cyclically reduced). */
export function sameCyclic(a, b) {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const A = wordText(a);
  const B = wordText(b);
  return (B + B).includes(A);
}

/**
 * Read the word ring's class out of a live simulation.
 * `hoops` are strand indices to span; `word` is the strand to trace.
 */
export function classOf(sim, hoops, wordIndex) {
  const fans = hoops.map((i, k) => ({ gen: k + 1, tris: spanningFan(sim.view(i)) }));
  const traced = traceWord(sim.view(wordIndex), fans, sim.strands[wordIndex].closed);
  return cyclicReduce(traced);
}
