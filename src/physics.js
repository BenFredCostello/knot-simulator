// ---------------------------------------------------------------------------
// physics.js — position-based relaxation for a set of point chains.
//
// Every ring is a chain of points held together by distance constraints.
// Shrinking those rest lengths is what "Pull" does: the chains contract,
// unlinked ones shrink away and drift free, linked ones jam against each other
// and lock into a taut configuration.
//
// Strands are packed into one flat position buffer so collision detection can
// run over a single uniform spatial hash. Anything that changes topology
// (adding a ring, retyping the word, cutting, resampling) rebuilds the buffer.
// ---------------------------------------------------------------------------

const DEFAULTS = {
  repel: 0.2, // minimum centre-line separation between strands
  segTarget: 0.13, // preferred arc length between points
  chainGap: 3, // ignore self-collisions closer than this along the chain
  iterations: 6,
  substeps: 2,
  damping: 0.9,
  smoothing: 0.055,
  stiffness: 1.0,
  shrink: 0.9965, // rest-length multiplier per frame while pulling
  spread: 0.004, // how hard separate rings are drawn apart while pulling
  spreadRange: 5.5, // beyond this centre distance rings stop pushing apart
  pegRate: 0.0022, // fractional outward dilation of the pegs per frame
  maxPegStep: 0.015, // cap per frame, so a peg can never sweep through a strand
  strainLimit: 1.12, // peg speed eases to zero as the hoops reach this stretch
  shrinkStrainLimit: 1.03, // never shrink rest length far below reachable length
  minPoints: 20,
  maxPoints: 620,
};

function hashCell(x, y, z) {
  return ((x * 92837111) ^ (y * 689287499) ^ (z * 283923481)) >>> 0;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Closest approach parameters between segments P->P+D1 and Q->Q+D2.
 * Writes [s, t] into `out`. Standard clamped-parameter solution.
 */
function segClosest(px, py, pz, d1x, d1y, d1z, qx, qy, qz, d2x, d2y, d2z, out) {
  const rx = px - qx;
  const ry = py - qy;
  const rz = pz - qz;
  const A = d1x * d1x + d1y * d1y + d1z * d1z;
  const E = d2x * d2x + d2y * d2y + d2z * d2z;
  const F = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s = 0;
  let t = 0;
  if (A <= EPS && E <= EPS) {
    // both degenerate
  } else if (A <= EPS) {
    t = clamp01(F / E);
  } else {
    const C = d1x * rx + d1y * ry + d1z * rz;
    if (E <= EPS) {
      s = clamp01(-C / A);
    } else {
      const B = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = A * E - B * B;
      s = denom > EPS ? clamp01((B * F - C * E) / denom) : 0;
      t = (B * s + F) / E;
      if (t < 0) {
        t = 0;
        s = clamp01(-C / A);
      } else if (t > 1) {
        t = 1;
        s = clamp01((B - C) / A);
      }
    }
  }
  out[0] = s;
  out[1] = t;
}

/** Resample a polyline to `n` points spaced evenly by arc length. */
export function resamplePolyline(flat, n, closed) {
  const m = flat.length / 3;
  const segs = closed ? m : m - 1;
  const cum = new Float64Array(segs + 1);
  for (let k = 0; k < segs; k++) {
    const a = k * 3;
    const b = ((k + 1) % m) * 3;
    cum[k + 1] =
      cum[k] + Math.hypot(flat[b] - flat[a], flat[b + 1] - flat[a + 1], flat[b + 2] - flat[a + 2]);
  }
  const total = cum[segs];
  const out = new Float32Array(n * 3);
  if (total < 1e-9) {
    for (let i = 0; i < n; i++) out.set(flat.subarray(0, 3), i * 3);
    return out;
  }
  const span = closed ? total / n : total / (n - 1);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(i * span, total);
    while (k < segs - 1 && cum[k + 1] < d) k++;
    const segLen = cum[k + 1] - cum[k] || 1e-9;
    const t = (d - cum[k]) / segLen;
    const a = k * 3;
    const b = ((k + 1) % m) * 3;
    out[i * 3] = flat[a] + (flat[b] - flat[a]) * t;
    out[i * 3 + 1] = flat[a + 1] + (flat[b + 1] - flat[a + 1]) * t;
    out[i * 3 + 2] = flat[a + 2] + (flat[b + 2] - flat[a + 2]) * t;
  }
  return out;
}

function flatten(points) {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i].x;
    out[i * 3 + 1] = points[i].y;
    out[i * 3 + 2] = points[i].z;
  }
  return out;
}

export class Sim {
  constructor(params = {}) {
    this.params = { ...DEFAULTS, ...params };
    this.strands = [];
    this.count = 0;
    this.pos = new Float32Array(0);
    this.prev = new Float32Array(0);
    this.scratch = new Float32Array(0);
    this.sid = new Int32Array(0);
    this.lid = new Int32Array(0);
    this.tableSize = 0;
    this.topologyVersion = 0;
    this.pegs = [];
    this.pegClearance = 0.26;
    this.slabLo = null;
    this.slabHi = null;
    this.shrinkable = null;
    this.pegsMoving = false;
  }

  /**
   * Replace all strands.
   * `list` is [{ points: Vector3[] | Float32Array, closed, shrink }].
   * `shrink: false` pins a strand's rest lengths so Pull cannot contract it.
   */
  setStrands(list) {
    const flats = list.map((s) =>
      s.points instanceof Float32Array ? s.points : flatten(s.points)
    );
    this.shrinkable = list.map((s) => s.shrink !== false);
    this.minLen = list.map((s) => s.minLen || 0);
    this.maxLen = list.map((s) => s.maxLen || 0);
    this.equalising = false;
    this._pack(flats, list.map((s) => s.closed !== false));
  }

  _pack(flats, closedFlags, preserve = null) {
    const total = flats.reduce((a, f) => a + f.length / 3, 0);
    this.count = total;
    this.pos = new Float32Array(total * 3);
    this.prev = new Float32Array(total * 3);
    this.scratch = new Float32Array(total * 3);
    this.sid = new Int32Array(total);
    this.lid = new Int32Array(total);
    this.strands = [];

    let off = 0;
    for (let s = 0; s < flats.length; s++) {
      const flat = flats[s];
      const n = flat.length / 3;
      this.pos.set(flat, off * 3);
      for (let i = 0; i < n; i++) {
        this.sid[off + i] = s;
        this.lid[off + i] = i;
      }
      const carried = preserve ? preserve[s] : null;
      const strand = {
        offset: off,
        n,
        closed: closedFlags[s],
        rest: null,
        // Tautness survives resampling — a jammed strand must not start
        // contracting again just because its points were redistributed.
        taut: carried ? carried.taut : false,
        stall: carried ? carried.stall : 0,
        lastLen: carried ? carried.lastLen : undefined,
        targetLen: carried ? carried.targetLen : null,
      };
      this.strands.push(strand);
      strand.rest = this._measure(strand);
      // Rest lengths are re-measured from current positions, so a strand that
      // happens to be stretched when it gets resampled would adopt the stretched
      // length as its new rest and ratchet upward forever. Renormalising to the
      // carried total keeps the intended rest length intact.
      if (carried && carried.restTotal > 0 && strand.rest.length) {
        let sum = 0;
        for (let k = 0; k < strand.rest.length; k++) sum += strand.rest[k];
        if (sum > 1e-9) {
          const k = carried.restTotal / sum;
          for (let q = 0; q < strand.rest.length; q++) strand.rest[q] *= k;
        }
      }
      off += n;
    }
    // Successor of each point. This depends only on topology, so it is built
    // once here rather than being rediscovered on every solver iteration.
    this.nextIdx = new Int32Array(total);
    for (const s of this.strands) {
      for (let i = 0; i < s.n; i++) {
        const g = s.offset + i;
        this.nextIdx[g] = i === s.n - 1 ? (s.closed ? s.offset : -1) : g + 1;
      }
    }

    this.prev.set(this.pos);
    this.topologyVersion++;
  }

  /** Current segment lengths of a strand, adopted as its rest lengths. */
  _measure(s) {
    const segs = s.closed ? s.n : s.n - 1;
    const rest = new Float32Array(Math.max(0, segs));
    const p = this.pos;
    for (let k = 0; k < segs; k++) {
      const a = (s.offset + k) * 3;
      const b = (s.offset + ((k + 1) % s.n)) * 3;
      rest[k] = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    }
    return rest;
  }

  /**
   * Cut a strand open at local point index `idx`. The chain is rotated so the
   * snip becomes the seam, leaving a genuine free end on each side.
   */
  cut(strandIndex, idx) {
    const s = this.strands[strandIndex];
    if (!s || !s.closed) return false;
    const flats = this.strands.map((st, i) => {
      const flat = this.pos.slice(st.offset * 3, (st.offset + st.n) * 3);
      if (i !== strandIndex) return flat;
      const cut = ((idx + 1) % st.n) * 3;
      const out = new Float32Array(flat.length);
      out.set(flat.subarray(cut), 0);
      out.set(flat.subarray(0, cut), flat.length - cut);
      return out;
    });
    const closed = this.strands.map((st, i) => (i === strandIndex ? false : st.closed));
    this._pack(flats, closed);
    this.release();
    return true;
  }

  step(pull, tension = 1) {
    if (this.count === 0) return;
    const pegged = !!(this.pegs && this.pegs.length);
    this.pegsMoving = false;
    if (this.equalising) this._equaliseStep();
    if (pull) {
      this._shrink(tension);
      // Pegs replace the centroid drift entirely: when rings are threaded on
      // pegs, separation comes from the pegs actually moving apart, which is a
      // real mechanism rather than a force invented per component.
      if (pegged) {
        // Two phases, in order. First the word ring contracts until it has
        // taken up the slack in the raw threading, which is what turns the comb
        // into a knot. Only then do the pegs start dragging, and they stop as
        // soon as the hoops they are dragging begin to stretch.
        // Soft limiter rather than a hard stop. A hard cut-off deadlocks: the
        // system parks exactly at the threshold and never moves again, even
        // once a snip has freed the link. Easing the speed to zero as the
        // hoops approach their stretch limit lets a locked link stall while a
        // freed one keeps sliding apart.
        const limit = this.params.strainLimit;
        const head = clamp01((limit - this.strain(true)) / (limit - 1));
        const tight = this._slackTakenUp();
        if (tight && head > 0.02) {
          this.pegsMoving = this.advancePegs(this.params.pegRate * tension * head) > 1e-9;
        }
        // Pegs only push where they touch, which is not enough to work a freed
        // component loose from a jammed tangle. A gentle whole-component drift
        // supplies that; rings held on pegs cannot run away, so it stays tidy.
        // It waits for the slack to be gone, because applied to a loose comb it
        // would simply stretch the slack out instead of testing anything.
        if (tight) this._computeSpread(tension * 0.5);
        else this.spreadVec = null;
      } else {
        this._computeSpread(tension);
      }
    } else {
      this.spreadVec = null;
    }
    // Smoothing runs first so that distance and collision constraints, which
    // are what keep strands from passing through each other, have the final say
    // on where every point ends up this frame.
    this._smooth();
    for (let i = 0; i < this.params.substeps; i++) this._substep();
    if (pull || this.equalising) this._maybeResample();
  }

  /**
   * A gentle outward drift between rings, applied only while pulling.
   *
   * This is what makes the whole thing legible: rings that are genuinely linked
   * cannot separate, so the drift just draws them taut against one another,
   * while rings that are free of each other visibly come apart. Snip one ring
   * of a Brunnian link and the rest fall away on their own.
   *
   * It is applied as a nudge during integration, never as a final position, so
   * the collision constraints still get the last word and it can never shove a
   * strand through another.
   */
  _computeSpread(tension) {
    const k = this.strands.length;
    if (k < 2) {
      this.spreadVec = null;
      return;
    }
    const cent = [];
    for (let i = 0; i < k; i++) {
      const f = this.view(i);
      let x = 0;
      let y = 0;
      let z = 0;
      const n = f.length / 3;
      for (let p = 0; p < f.length; p += 3) {
        x += f[p];
        y += f[p + 1];
        z += f[p + 2];
      }
      cent.push([x / n, y / n, z / n]);
    }
    const strength = this.params.spread * Math.max(0.05, tension);
    const out = new Float32Array(k * 3);
    for (let i = 0; i < k; i++) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let j = 0; j < k; j++) {
        if (i === j) continue;
        let dx = cent[i][0] - cent[j][0];
        let dy = cent[i][1] - cent[j][1];
        let dz = cent[i][2] - cent[j][2];
        const d = Math.hypot(dx, dy, dz);
        // Once two rings are clearly apart, stop pushing — otherwise freed
        // components accelerate off-screen instead of settling where you can
        // see that they came apart.
        if (d > this.params.spreadRange) continue;
        if (d < 1e-6) {
          dx = (i - j) * 1e-3;
          dy = 1e-3;
          dz = 0;
        }
        const inv = 1 / Math.max(d, 0.5);
        ax += dx * inv * inv;
        ay += dy * inv * inv;
        az += dz * inv * inv;
      }
      const m = Math.hypot(ax, ay, az);
      if (m > 1e-9) {
        const s = strength / m;
        out[i * 3] = ax * s;
        out[i * 3 + 1] = ay * s;
        out[i * 3 + 2] = az * s;
      }
    }
    this.spreadVec = out;
  }

  /**
   * Contract rest lengths, but never past what the link can physically hold.
   *
   * Two guards, both needed. A closed loop whose own strands must stay `repel`
   * apart cannot have a circumference below pi*repel, so that is a hard floor.
   * And a strand jammed against its neighbours stops getting shorter no matter
   * how hard you pull — once we detect that stall we mark it taut and stop.
   * Without these the solver ends up in a permanent tug of war between distance
   * and collision constraints, and eventually squeezes a strand clean through
   * another, silently changing the link type.
   */
  _shrink(tension) {
    const rate = Math.pow(this.params.shrink, Math.max(0.05, tension));
    const { repel } = this.params;
    for (let si = 0; si < this.strands.length; si++) {
      const s = this.strands[si];
      // A ring held open on a peg must keep a hole big enough for whatever is
      // threaded through it, so in peg mode only the word ring contracts.
      if (this.shrinkable && this.shrinkable[si] === false) continue;
      const len = this._length(s);
      if (s.lastLen !== undefined) {
        const drop = (s.lastLen - len) / Math.max(len, 1e-6);
        s.stall = drop < 0.0006 ? s.stall + 1 : 0;
        if (s.stall > 25) s.taut = true;
      }
      s.lastLen = len;
      if (s.taut) continue;

      let restSum = 0;
      for (let k = 0; k < s.rest.length; k++) restSum += s.rest[k];
      // Never pull the rest length far below what the strand can actually
      // reach. Otherwise rest keeps falling while the real length cannot
      // follow, and the strand ends up permanently over-tensioned — which is
      // exactly the state that squeezes strands through each other.
      if (restSum > 1e-6 && len / restSum > this.params.shrinkStrainLimit) continue;

      const floor = s.closed ? Math.PI * repel * 1.08 : repel * 1.5;
      let sum = 0;
      for (let k = 0; k < s.rest.length; k++) sum += s.rest[k];
      if (sum * rate < floor) {
        s.taut = true;
        continue;
      }
      for (let k = 0; k < s.rest.length; k++) s.rest[k] *= rate;
    }
  }

  // -------------------------------------------------------------------------
  // Pegs and bounds (rod mode)
  // -------------------------------------------------------------------------

  /**
   * Install vertical pegs. Each is a capsule from (x, ylo, z) to (x, yhi, z)
   * that no strand may pass through, so a ring threaded onto one is genuinely
   * captured: it cannot escape without being cut. Passing an empty list, or
   * clearing the bounds, returns the sim to free mode.
   */
  setPegs(pegs, clearance) {
    this.pegs = pegs.map((p) => ({ x: p.x, z: p.z, ylo: p.ylo, yhi: p.yhi }));
    this.pegClearance = clearance;
    // Once a link comes free nothing resists the pegs any more, so without a
    // ceiling they accelerate off-screen. Stopping at a few times the starting
    // radius is well past the point where it is obvious what happened.
    let r0 = 0;
    for (const p of this.pegs) r0 = Math.max(r0, Math.hypot(p.x, p.z));
    this.pegLimit = Math.max(1, r0) * 3.2;
  }

  /** Confine every point to the horizontal slab ylo..yhi. Null disables. */
  setSlab(ylo, yhi) {
    this.slabLo = ylo;
    this.slabHi = yhi;
  }

  /**
   * Dilate the pegs outward from the origin. Velocity is proportional to
   * distance, so a peg sitting at the origin does not move at all and the
   * spacing between every pair grows in proportion.
   */
  advancePegs(rate) {
    if (!this.pegs || !this.pegs.length) return 0;
    const cap = this.params.maxPegStep;
    let far = 0;
    for (const p of this.pegs) far = Math.max(far, Math.hypot(p.x, p.z));
    if (far >= this.pegLimit) return 0;
    let moved = 0;
    for (const p of this.pegs) {
      let dx = p.x * rate;
      let dz = p.z * rate;
      const m = Math.hypot(dx, dz);
      if (m > cap) {
        const k = cap / m;
        dx *= k;
        dz *= k;
      }
      p.x += dx;
      p.z += dz;
      moved += Math.abs(dx) + Math.abs(dz);
    }
    return moved;
  }

  /**
   * Worst ratio of actual length to rest length across all strands. Above 1
   * something is being stretched, which is the signal that the link has gone
   * taut and the pegs should stop pulling.
   */
  /** True once every contracting strand has stopped getting shorter. */
  _slackTakenUp() {
    for (let i = 0; i < this.strands.length; i++) {
      if (this.shrinkable && this.shrinkable[i] === false) continue;
      if (!this.strands[i].taut) return false;
    }
    return true;
  }

  strain(pinnedOnly = false) {
    let worst = 0;
    let seen = false;
    for (let i = 0; i < this.strands.length; i++) {
      // A strand that is deliberately contracting always reads as strained, so
      // gating the pegs on it would stop them instantly. The rings the pegs
      // actually drag are the pinned ones; their stretch is the real signal.
      if (pinnedOnly && this.shrinkable && this.shrinkable[i] !== false) continue;
      const s = this.strands[i];
      let rest = 0;
      for (let k = 0; k < s.rest.length; k++) rest += s.rest[k];
      if (rest < 1e-6) continue;
      seen = true;
      const r = this._length(s) / rest;
      if (r > worst) worst = r;
    }
    if (pinnedOnly && !seen) return this.strain(false);
    return worst;
  }

  _solvePegs() {
    if (!this.pegs || !this.pegs.length) return;
    const clearance = this.pegClearance;
    const nextIdx = this.nextIdx;
    for (let i = 0; i < this.count; i++) {
      const i2 = nextIdx[i];
      if (i2 < 0) continue;
      for (let p = 0; p < this.pegs.length; p++) {
        this._separateFromPeg(i, i2, this.pegs[p], clearance);
      }
    }
  }

  /** Push one strand segment clear of a peg. The peg never moves. */
  _separateFromPeg(a1, a2, peg, clearance) {
    const pos = this.pos;
    const oa = a1 * 3;
    const oa2 = a2 * 3;
    // Cheap horizontal reject: a peg is a vertical line, so anything far from
    // it in plan view cannot touch it whatever its height.
    const hx = pos[oa] - peg.x;
    const hz = pos[oa + 2] - peg.z;
    const reach = clearance + (this.maxSeg || this.params.segTarget);
    if (hx * hx + hz * hz > reach * reach) return;
    const d1x = pos[oa2] - pos[oa];
    const d1y = pos[oa2 + 1] - pos[oa + 1];
    const d1z = pos[oa2 + 2] - pos[oa + 2];

    const st = this._st || (this._st = new Float64Array(2));
    segClosest(pos[oa], pos[oa + 1], pos[oa + 2], d1x, d1y, d1z,
      peg.x, peg.ylo, peg.z, 0, peg.yhi - peg.ylo, 0, st);
    const s = st[0];
    const t = st[1];

    const px = peg.x;
    const py = peg.ylo + (peg.yhi - peg.ylo) * t;
    const pz = peg.z;
    let vx = pos[oa] + d1x * s - px;
    let vy = pos[oa + 1] + d1y * s - py;
    let vz = pos[oa + 2] + d1z * s - pz;
    let dd = vx * vx + vy * vy + vz * vz;
    if (dd >= clearance * clearance) return;
    if (dd < 1e-14) {
      vx = 1e-4;
      vz = 1e-4;
      vy = 0;
      dd = vx * vx + vz * vz;
    }
    const d = Math.sqrt(dd);
    const push = (clearance - d) / d;
    const cx = vx * push;
    const cy = vy * push;
    const cz = vz * push;
    const w = 1 / ((1 - s) * (1 - s) + s * s);
    pos[oa] += cx * (1 - s) * w;
    pos[oa + 1] += cy * (1 - s) * w;
    pos[oa + 2] += cz * (1 - s) * w;
    pos[oa2] += cx * s * w;
    pos[oa2 + 1] += cy * s * w;
    pos[oa2 + 2] += cz * s * w;
  }

  _solveSlab() {
    if (this.slabLo == null) return;
    const pos = this.pos;
    const lo = this.slabLo;
    const hi = this.slabHi;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3 + 1;
      if (pos[o] < lo) pos[o] = lo;
      else if (pos[o] > hi) pos[o] = hi;
    }
  }

  // -------------------------------------------------------------------------
  // Equalising
  // -------------------------------------------------------------------------

  /**
   * Drive every strand toward a common length.
   *
   * Left alone, the word ring ends up far longer than the base rings because it
   * has to weave through all of them, which reads as one rope threaded through
   * some hoops rather than as a symmetric link. Equalising aims them all at the
   * mean, letting the short ones grow and the long one contract, so the knot
   * comes out even. Per-strand minimums still apply: a ring on a peg must keep
   * a hole wide enough for whatever passes through it.
   */
  equalise() {
    if (!this.strands.length) return;
    // Median, not mean. The word ring can start out an order of magnitude
    // longer than the hoops, and a mean dominated by that outlier would inflate
    // every hoop to match it instead of reeling the long one in.
    const lens = this.strands.map((_, i) => this.strandLength(i)).sort((a, b) => a - b);
    const mid = lens.length >> 1;
    const target = lens.length % 2 ? lens[mid] : (lens[mid - 1] + lens[mid]) / 2;
    for (let i = 0; i < this.strands.length; i++) {
      const s = this.strands[i];
      const min = this.minLen ? this.minLen[i] || 0 : 0;
      const max = this.maxLen && this.maxLen[i] ? this.maxLen[i] : Infinity;
      s.targetLen = Math.min(max, Math.max(target, min));
      s.taut = false;
      s.stall = 0;
      s.lastLen = undefined;
    }
    this.equalising = true;
  }

  _equaliseStep() {
    let done = true;
    for (const s of this.strands) {
      if (s.targetLen == null) continue;
      let sum = 0;
      for (let k = 0; k < s.rest.length; k++) sum += s.rest[k];
      if (sum < 1e-6) continue;
      const ratio = s.targetLen / sum;
      if (Math.abs(ratio - 1) < 0.003) continue;
      done = false;
      // Bounded rate, so equalising is something you watch rather than a jump.
      const step = ratio > 1 ? Math.min(ratio, 1.006) : Math.max(ratio, 0.994);
      for (let k = 0; k < s.rest.length; k++) s.rest[k] *= step;
    }
    if (done) {
      this.equalising = false;
      for (const s of this.strands) s.targetLen = null;
    }
  }

  /** Let every strand contract again — after a cut, the link has slack. */
  release() {
    for (const s of this.strands) {
      s.taut = false;
      s.stall = 0;
      s.lastLen = undefined;
    }
  }

  _substep() {
    const { damping, repel, iterations, stiffness } = this.params;
    const pos = this.pos;
    const prev = this.prev;
    const sp = this.spreadVec;
    const maxDisp = repel * 0.35;

    // Verlet integration with heavy damping. Displacement is capped so a fast
    // strand can never jump clean through another between collision checks.
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      let dx = (pos[o] - prev[o]) * damping;
      let dy = (pos[o + 1] - prev[o + 1]) * damping;
      let dz = (pos[o + 2] - prev[o + 2]) * damping;
      const mag = Math.hypot(dx, dy, dz);
      if (mag > maxDisp) {
        const k = maxDisp / mag;
        dx *= k;
        dy *= k;
        dz *= k;
      }
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      pos[o] += dx;
      pos[o + 1] += dy;
      pos[o + 2] += dz;
      if (sp) {
        const c = this.sid[i] * 3;
        pos[o] += sp[c];
        pos[o + 1] += sp[c + 1];
        pos[o + 2] += sp[c + 2];
      }
    }

    this._buildHash();
    for (let it = 0; it < iterations; it++) {
      this._solveDistance(stiffness);
      this._solveDistance(stiffness);
      this._solveCollision();
      this._solvePegs();
      this._solveSlab();
    }
  }

  _solveDistance(stiff) {
    const pos = this.pos;
    for (const s of this.strands) {
      const segs = s.closed ? s.n : s.n - 1;
      const rest = s.rest;
      for (let k = 0; k < segs; k++) {
        const a = (s.offset + k) * 3;
        const b = (s.offset + ((k + 1) % s.n)) * 3;
        const dx = pos[b] - pos[a];
        const dy = pos[b + 1] - pos[a + 1];
        const dz = pos[b + 2] - pos[a + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-9) continue;
        const w = ((d - rest[k]) / d) * 0.5 * stiff;
        const cx = dx * w;
        const cy = dy * w;
        const cz = dz * w;
        pos[a] += cx;
        pos[a + 1] += cy;
        pos[a + 2] += cz;
        pos[b] -= cx;
        pos[b + 1] -= cy;
        pos[b + 2] -= cz;
      }
    }
  }

  /**
   * Cache each segment's midpoint and length.
   *
   * Collision works on segments, so the broad phase indexes segment midpoints
   * rather than endpoints. Two segments can only be within `repel` if their
   * midpoints are within `repel + (lenA + lenB)/2`, which keeps the search cell
   * small — indexing endpoints instead would need a cell nearly twice as wide
   * and roughly an order of magnitude more candidate pairs.
   */
  _computeMidpoints() {
    const n = this.count;
    if (!this.mid || this.mid.length !== n * 3) {
      this.mid = new Float32Array(n * 3);
      this.segLen = new Float32Array(n);
    }
    const { pos, mid, segLen, nextIdx } = this;
    let maxSeg = 0;
    for (let i = 0; i < n; i++) {
      const a = i * 3;
      const j = nextIdx[i];
      if (j < 0) {
        mid[a] = pos[a];
        mid[a + 1] = pos[a + 1];
        mid[a + 2] = pos[a + 2];
        segLen[i] = -1;
        continue;
      }
      const b = j * 3;
      mid[a] = (pos[a] + pos[b]) * 0.5;
      mid[a + 1] = (pos[a + 1] + pos[b + 1]) * 0.5;
      mid[a + 2] = (pos[a + 2] + pos[b + 2]) * 0.5;
      const L = Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
      segLen[i] = L;
      if (L > maxSeg) maxSeg = L;
    }
    this.maxSeg = maxSeg;
  }

  _buildHash() {
    const n = this.count;
    this._computeMidpoints();
    // Slack absorbs the drift that constraint solving introduces between the
    // moment the hash is built and the moment it is queried.
    this.invCell = 1 / ((this.params.repel + this.maxSeg) * 1.15);
    let T = 1;
    while (T < n * 2) T <<= 1;
    if (this.tableSize !== T) {
      this.tableSize = T;
      this.cellStart = new Int32Array(T + 1);
      this.cursor = new Int32Array(T);
    }
    if (!this.entries || this.entries.length !== n) {
      this.entries = new Int32Array(n);
      this.keys = new Int32Array(n);
    }
    const { cellStart, cursor, entries, keys, mid, invCell } = this;
    cellStart.fill(0);
    const mask = T - 1;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const k =
        hashCell(
          Math.floor(mid[o] * invCell),
          Math.floor(mid[o + 1] * invCell),
          Math.floor(mid[o + 2] * invCell)
        ) & mask;
      keys[i] = k;
      cellStart[k]++;
    }
    let sum = 0;
    for (let i = 0; i < T; i++) {
      const c = cellStart[i];
      cellStart[i] = sum;
      sum += c;
    }
    cellStart[T] = sum;
    cursor.set(cellStart.subarray(0, T));
    for (let i = 0; i < n; i++) entries[cursor[keys[i]]++] = i;
  }

  /**
   * Keep every pair of strand segments at least `repel` apart.
   *
   * This is deliberately segment-to-segment rather than point-to-point: with
   * only point repulsion, a strand under compression can slip between two of
   * another strand's points without ever violating a point constraint, which
   * changes the link type. Comparing closest approach of the segments
   * themselves leaves no such gap.
   */
  _solveCollision() {
    const n = this.count;
    if (n === 0) return;
    const { repel, chainGap } = this.params;
    this._computeMidpoints();
    const { mid, nextIdx, cellStart, entries, sid, lid, invCell, tableSize } = this;
    const mask = tableSize - 1;
    const nk = this._nk || (this._nk = new Int32Array(27));
    // Conservative: segments further apart than this cannot be in contact.
    const thr = repel + this.maxSeg;
    const thr2 = thr * thr;

    for (let i = 0; i < n; i++) {
      const i2 = nextIdx[i];
      if (i2 < 0) continue;
      const oi = i * 3;
      const cx = Math.floor(mid[oi] * invCell);
      const cy = Math.floor(mid[oi + 1] * invCell);
      const cz = Math.floor(mid[oi + 2] * invCell);
      let nkc = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = hashCell(cx + dx, cy + dy, cz + dz) & mask;
            let dup = false;
            for (let q = 0; q < nkc; q++) {
              if (nk[q] === key) {
                dup = true;
                break;
              }
            }
            if (dup) continue;
            nk[nkc++] = key;

            for (let e = cellStart[key]; e < cellStart[key + 1]; e++) {
              const j = entries[e];
              if (j <= i) continue;
              const j2 = nextIdx[j];
              if (j2 < 0) continue;
              // Cheap midpoint reject before the closest-approach solve.
              const oj = j * 3;
              const mx = mid[oj] - mid[oi];
              const my = mid[oj + 1] - mid[oi + 1];
              const mz = mid[oj + 2] - mid[oi + 2];
              if (mx * mx + my * my + mz * mz > thr2) continue;
              if (sid[i] === sid[j]) {
                const s = this.strands[sid[i]];
                let gap = Math.abs(lid[i] - lid[j]);
                if (s.closed) gap = Math.min(gap, s.n - gap);
                if (gap <= chainGap) continue;
              }
              this._separate(i, i2, j, j2, repel);
            }
          }
        }
      }
    }
  }

  /** Push segments (a1,a2) and (b1,b2) apart to at least `repel`. */
  _separate(a1, a2, b1, b2, repel) {
    const pos = this.pos;
    const oa = a1 * 3;
    const oa2 = a2 * 3;
    const ob = b1 * 3;
    const ob2 = b2 * 3;

    const d1x = pos[oa2] - pos[oa];
    const d1y = pos[oa2 + 1] - pos[oa + 1];
    const d1z = pos[oa2 + 2] - pos[oa + 2];
    const d2x = pos[ob2] - pos[ob];
    const d2y = pos[ob2 + 1] - pos[ob + 1];
    const d2z = pos[ob2 + 2] - pos[ob + 2];

    const st = this._st || (this._st = new Float64Array(2));
    segClosest(pos[oa], pos[oa + 1], pos[oa + 2], d1x, d1y, d1z,
      pos[ob], pos[ob + 1], pos[ob + 2], d2x, d2y, d2z, st);
    const s = st[0];
    const t = st[1];

    let vx = pos[ob] + d2x * t - (pos[oa] + d1x * s);
    let vy = pos[ob + 1] + d2y * t - (pos[oa + 1] + d1y * s);
    let vz = pos[ob + 2] + d2z * t - (pos[oa + 2] + d1z * s);
    let dd = vx * vx + vy * vy + vz * vz;
    if (dd >= repel * repel) return;
    if (dd < 1e-14) {
      // Exactly coincident: nudge deterministically so the pair can separate.
      vx = ((a1 % 7) - 3) * 1e-4 + 1e-5;
      vy = ((b1 % 5) - 2) * 1e-4;
      vz = ((a1 + b1) % 3 === 0 ? 1 : -1) * 1e-4;
      dd = vx * vx + vy * vy + vz * vz;
    }
    const d = Math.sqrt(dd);
    const push = (repel - d) / d * 0.5;
    const cx = vx * push;
    const cy = vy * push;
    const cz = vz * push;

    // Spread each segment's correction over its endpoints so the interpolated
    // closest point moves by exactly the intended amount.
    const wa = (1 - s) * (1 - s) + s * s;
    const wb = (1 - t) * (1 - t) + t * t;
    const ka = 1 / wa;
    const kb = 1 / wb;

    pos[oa] -= cx * (1 - s) * ka;
    pos[oa + 1] -= cy * (1 - s) * ka;
    pos[oa + 2] -= cz * (1 - s) * ka;
    pos[oa2] -= cx * s * ka;
    pos[oa2 + 1] -= cy * s * ka;
    pos[oa2 + 2] -= cz * s * ka;

    pos[ob] += cx * (1 - t) * kb;
    pos[ob + 1] += cy * (1 - t) * kb;
    pos[ob + 2] += cz * (1 - t) * kb;
    pos[ob2] += cx * t * kb;
    pos[ob2 + 1] += cy * t * kb;
    pos[ob2 + 2] += cz * t * kb;
  }

  /** Light Laplacian smoothing so tightened strands read as smooth curves. */
  _smooth() {
    const lam = this.params.smoothing;
    if (lam <= 0) return;
    const pos = this.pos;
    const tmp = this.scratch;
    tmp.set(pos);
    for (const s of this.strands) {
      const { offset: o, n, closed } = s;
      const lo = closed ? 0 : 1;
      const hi = closed ? n : n - 1;
      for (let i = lo; i < hi; i++) {
        const a = (o + ((i - 1 + n) % n)) * 3;
        const b = (o + i) * 3;
        const c = (o + ((i + 1) % n)) * 3;
        tmp[b] += lam * ((pos[a] + pos[c]) * 0.5 - pos[b]);
        tmp[b + 1] += lam * ((pos[a + 1] + pos[c + 1]) * 0.5 - pos[b + 1]);
        tmp[b + 2] += lam * ((pos[a + 2] + pos[c + 2]) * 0.5 - pos[b + 2]);
      }
    }
    pos.set(tmp);
  }

  /**
   * As strands contract their points bunch up. Decimating keeps segment lengths
   * near the target, which keeps the solver well conditioned and lets a free
   * ring shrink right down instead of jamming on its own points.
   */
  _maybeResample() {
    const { segTarget, minPoints, maxPoints } = this.params;
    let needed = false;
    const plan = this.strands.map((s) => {
      const len = this._length(s);
      const segs = s.closed ? s.n : s.n - 1;
      const mean = len / Math.max(1, segs);
      // Too bunched, or (when a strand has been grown) too sparse. Sparse
      // matters: segments longer than `repel` would let strands slip past.
      const tooDense = mean < segTarget * 0.55 && s.n > minPoints;
      const tooSparse = mean > segTarget * 1.55 && s.n < maxPoints;
      if (tooDense || tooSparse) {
        const target = Math.max(minPoints, Math.min(maxPoints, Math.round(len / segTarget)));
        if (target !== s.n) {
          needed = true;
          return target;
        }
      }
      return s.n;
    });
    if (!needed) return;

    const flats = this.strands.map((s, i) => {
      const flat = this.pos.slice(s.offset * 3, (s.offset + s.n) * 3);
      return plan[i] === s.n ? flat : resamplePolyline(flat, plan[i], s.closed);
    });
    const carry = this.strands.map((s) => {
      let restTotal = 0;
      for (let k = 0; k < s.rest.length; k++) restTotal += s.rest[k];
      return { taut: s.taut, stall: s.stall, lastLen: s.lastLen, targetLen: s.targetLen, restTotal };
    });
    this._pack(flats, this.strands.map((s) => s.closed), carry);
  }

  _length(s) {
    const segs = s.closed ? s.n : s.n - 1;
    const p = this.pos;
    let len = 0;
    for (let k = 0; k < segs; k++) {
      const a = (s.offset + k) * 3;
      const b = (s.offset + ((k + 1) % s.n)) * 3;
      len += Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
    }
    return len;
  }

  strandLength(i) {
    return this.strands[i] ? this._length(this.strands[i]) : 0;
  }

  /** Flat xyz view of one strand's current positions (no copy). */
  view(i) {
    const s = this.strands[i];
    return this.pos.subarray(s.offset * 3, (s.offset + s.n) * 3);
  }

  bounds() {
    if (this.count === 0) return null;
    const p = this.pos;
    let mnx = Infinity;
    let mny = Infinity;
    let mnz = Infinity;
    let mxx = -Infinity;
    let mxy = -Infinity;
    let mxz = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      if (p[o] < mnx) mnx = p[o];
      if (p[o] > mxx) mxx = p[o];
      if (p[o + 1] < mny) mny = p[o + 1];
      if (p[o + 1] > mxy) mxy = p[o + 1];
      if (p[o + 2] < mnz) mnz = p[o + 2];
      if (p[o + 2] > mxz) mxz = p[o + 2];
    }
    return { min: [mnx, mny, mnz], max: [mxx, mxy, mxz] };
  }
}
