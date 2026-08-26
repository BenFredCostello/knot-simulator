// ---------------------------------------------------------------------------
// linkdet.js — the determinant of a link, computed from the actual geometry.
//
// This is the test the rest of the debugging kept needing and not having. It is
// an isotopy invariant, so unlike the homotopy class in invariant.js it can see
// a Whitehead-style clasp; and unlike dragging components apart it gives a
// definite answer regardless of how large or tangled the configuration is.
//
//   2-component unlink   0
//   Hopf link            2
//   Whitehead link       8
//
// A non-zero determinant proves the components cannot be separated. Zero is
// strong evidence they can, though not a proof — a handful of genuinely linked
// links also have determinant zero.
//
// Method: project to a plane along a generic direction, read off the crossings
// with their over/under sense, cut each component into arcs at its
// undercrossings, and build the Alexander matrix at t = -1. Deleting one row and
// one column and taking |det| gives the determinant. At t = -1 the two
// under-arcs at a crossing enter with the same coefficient, so crossing signs
// drop out entirely and only the over/under structure is needed.
// ---------------------------------------------------------------------------

/** A fixed generic rotation, so no strand is edge-on to the projection. */
function rotated(flat, i) {
  const A = 0.5731;
  const B = 0.3197;
  const ca = Math.cos(A);
  const sa = Math.sin(A);
  const cb = Math.cos(B);
  const sb = Math.sin(B);
  const x = flat[i];
  const y = flat[i + 1];
  const z = flat[i + 2];
  const x2 = x * ca - z * sa;
  const z2 = x * sa + z * ca;
  const y2 = y * cb - z2 * sb;
  const z3 = y * sb + z2 * cb;
  return [x2, z3, y2]; // (u, v) plane, h height
}

/**
 * Crossings of a set of closed polylines under projection.
 * Each is { over: {c, p}, under: {c, p} } with p a position along the curve.
 */
function findCrossings(curves) {
  const pts = curves.map((f) => {
    const n = f.length / 3;
    const out = [];
    for (let i = 0; i < n; i++) out.push(rotated(f, i * 3));
    return out;
  });
  const crossings = [];
  for (let ca = 0; ca < pts.length; ca++) {
    const A = pts[ca];
    for (let cb = ca; cb < pts.length; cb++) {
      const B = pts[cb];
      for (let i = 0; i < A.length; i++) {
        const a0 = A[i];
        const a1 = A[(i + 1) % A.length];
        const jStart = cb === ca ? i + 1 : 0;
        for (let j = jStart; j < B.length; j++) {
          if (cb === ca) {
            // skip neighbours sharing an endpoint
            const d = Math.min(Math.abs(i - j), A.length - Math.abs(i - j));
            if (d <= 1) continue;
          }
          const b0 = B[j];
          const b1 = B[(j + 1) % B.length];
          const rx = a1[0] - a0[0];
          const ry = a1[1] - a0[1];
          const sx = b1[0] - b0[0];
          const sy = b1[1] - b0[1];
          const den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-12) continue;
          const dx = b0[0] - a0[0];
          const dy = b0[1] - a0[1];
          const t = (dx * sy - dy * sx) / den;
          const u = (dx * ry - dy * rx) / den;
          if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
          const ha = a0[2] + (a1[2] - a0[2]) * t;
          const hb = b0[2] + (b1[2] - b0[2]) * u;
          const onA = { c: ca, p: i + t };
          const onB = { c: cb, p: j + u };
          crossings.push(ha > hb ? { over: onA, under: onB } : { over: onB, under: onA });
        }
      }
    }
  }
  return crossings;
}

/** Exact integer determinant by fraction-free (Bareiss) elimination. */
function detBigInt(M) {
  const n = M.length;
  if (n === 0) return 1n;
  const a = M.map((r) => r.map(BigInt));
  let sign = 1n;
  let prev = 1n;
  for (let k = 0; k < n - 1; k++) {
    if (a[k][k] === 0n) {
      let swap = -1;
      for (let i = k + 1; i < n; i++) {
        if (a[i][k] !== 0n) {
          swap = i;
          break;
        }
      }
      if (swap < 0) return 0n;
      const tmp = a[k];
      a[k] = a[swap];
      a[swap] = tmp;
      sign = -sign;
    }
    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        a[i][j] = (a[i][j] * a[k][k] - a[i][k] * a[k][j]) / prev;
      }
      a[i][k] = 0n;
    }
    prev = a[k][k];
  }
  return sign * a[n - 1][n - 1];
}

/**
 * The determinant of the link formed by `curves` (flat xyz arrays, closed).
 * Returns { det, crossings, arcs, split }.
 */
export function linkDeterminant(curves) {
  const crossings = findCrossings(curves);
  if (crossings.length === 0) {
    // A lone circle is the unknot (determinant 1); several with no crossings
    // between them form a split link (determinant 0).
    return { det: curves.length === 1 ? 1 : 0, crossings: 0, arcs: 0, split: curves.length > 1 };
  }

  // Undercrossing positions along each component, in order.
  const unders = curves.map(() => []);
  for (const x of crossings) unders[x.under.c].push(x.under.p);
  for (const u of unders) u.sort((p, q) => p - q);

  // Arcs run from one undercrossing to the next. A component with no
  // undercrossing at all can be lifted clear of everything, so the link is
  // split and its determinant is zero.
  const arcBase = [];
  let total = 0;
  for (let c = 0; c < curves.length; c++) {
    arcBase.push(total);
    if (unders[c].length === 0) return { det: 0, crossings: crossings.length, arcs: 0, split: true };
    total += unders[c].length;
  }
  if (total !== crossings.length) {
    return { det: 0, crossings: crossings.length, arcs: total, split: true };
  }

  const arcAt = (c, p) => {
    const U = unders[c];
    let k = -1;
    for (let i = 0; i < U.length; i++) if (U[i] <= p) k = i;
    if (k < 0) k = U.length - 1; // before the first: the wrapping arc
    return arcBase[c] + k;
  };
  const indexOfUnder = (c, p) => {
    const U = unders[c];
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < U.length; i++) {
      const d = Math.abs(U[i] - p);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  // Alexander matrix at t = -1: over-arc 2, each under-arc -1.
  const M = crossings.map((x) => {
    const row = new Array(total).fill(0);
    const k = indexOfUnder(x.under.c, x.under.p);
    const nU = unders[x.under.c].length;
    const outArc = arcBase[x.under.c] + k;
    const inArc = arcBase[x.under.c] + ((k - 1 + nU) % nU);
    row[arcAt(x.over.c, x.over.p)] += 2;
    row[inArc] -= 1;
    row[outArc] -= 1;
    return row;
  });

  // Drop one row and one column; |det| of what is left is the determinant.
  const minor = M.slice(1).map((r) => r.slice(1));
  const d = detBigInt(minor);
  return {
    det: Number(d < 0n ? -d : d),
    crossings: crossings.length,
    arcs: total,
    split: false,
  };
}

/** Determinant of the sublink formed by a subset of a simulation's strands. */
export function sublinkDeterminant(sim, indices) {
  return linkDeterminant(indices.map((i) => sim.view(i)));
}
