// ---------------------------------------------------------------------------
// tube.js — a swept tube whose vertices are rewritten in place every frame.
//
// THREE.TubeGeometry rebuilds buffers from scratch, which is far too much
// allocation for a per-frame simulation. This keeps one static index buffer and
// only touches positions and normals, using parallel-transport frames so the
// tube does not spin as the centre line twists.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const TMP = {
  t: new THREE.Vector3(),
  n: new THREE.Vector3(),
  b: new THREE.Vector3(),
};

export class Tube {
  /**
   * @param {number} n      number of centre-line points
   * @param {boolean} closed
   * @param {number} radius
   * @param {number} radial number of vertices around the tube
   * @param {THREE.Material} material
   */
  constructor(n, closed, radius, radial, material) {
    this.n = n;
    this.closed = closed;
    this.radius = radius;
    this.radial = radial;
    this.hasCaps = !closed;

    const verts = n * radial + (this.hasCaps ? 2 : 0);
    this.geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.normal = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.normal.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.position);
    this.geometry.setAttribute('normal', this.normal);
    this.geometry.setIndex(this._buildIndex());

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
  }

  _buildIndex() {
    const { n, radial, closed, hasCaps } = this;
    const verts = n * radial + (hasCaps ? 2 : 0);
    const rows = closed ? n : n - 1;
    const idx = [];
    for (let i = 0; i < rows; i++) {
      const a = i * radial;
      const b = ((i + 1) % n) * radial;
      for (let k = 0; k < radial; k++) {
        const k2 = (k + 1) % radial;
        idx.push(a + k, b + k, a + k2);
        idx.push(a + k2, b + k, b + k2);
      }
    }
    if (hasCaps) {
      const capA = n * radial;
      const capB = capA + 1;
      const last = (n - 1) * radial;
      for (let k = 0; k < radial; k++) {
        const k2 = (k + 1) % radial;
        idx.push(capA, k2, k);
        idx.push(capB, last + k, last + k2);
      }
    }
    const Arr = verts > 65535 ? Uint32Array : Uint16Array;
    return new THREE.BufferAttribute(new Arr(idx), 1);
  }

  /** Rewrite the surface from a flat xyz centre line of length n*3. */
  update(flat) {
    const { n, radial, closed, radius, hasCaps } = this;
    const pos = this.position.array;
    const nor = this.normal.array;
    const t = TMP.t;
    const nrm = TMP.n;
    const bin = TMP.b;

    // Seed a normal perpendicular to the first tangent.
    tangentAt(flat, 0, n, closed, t);
    seedPerpendicular(t, nrm);

    for (let i = 0; i < n; i++) {
      tangentAt(flat, i, n, closed, t);
      // Parallel transport: project the previous normal off the new tangent.
      const dot = nrm.dot(t);
      nrm.addScaledVector(t, -dot);
      if (nrm.lengthSq() < 1e-10) seedPerpendicular(t, nrm);
      else nrm.normalize();
      bin.crossVectors(t, nrm).normalize();

      // Free ends of a cut strand taper off, so a snip reads as a snip.
      let r = radius;
      if (hasCaps) {
        const edge = Math.min(i, n - 1 - i);
        if (edge < 3) r = radius * (0.45 + 0.185 * edge);
      }

      const px = flat[i * 3];
      const py = flat[i * 3 + 1];
      const pz = flat[i * 3 + 2];
      const base = i * radial * 3;
      for (let k = 0; k < radial; k++) {
        const a = (2 * Math.PI * k) / radial;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const nx = ca * nrm.x + sa * bin.x;
        const ny = ca * nrm.y + sa * bin.y;
        const nz = ca * nrm.z + sa * bin.z;
        const o = base + k * 3;
        pos[o] = px + r * nx;
        pos[o + 1] = py + r * ny;
        pos[o + 2] = pz + r * nz;
        nor[o] = nx;
        nor[o + 1] = ny;
        nor[o + 2] = nz;
      }
    }

    if (hasCaps) {
      const capA = n * radial * 3;
      const capB = capA + 3;
      tangentAt(flat, 0, n, closed, t);
      pos[capA] = flat[0];
      pos[capA + 1] = flat[1];
      pos[capA + 2] = flat[2];
      nor[capA] = -t.x;
      nor[capA + 1] = -t.y;
      nor[capA + 2] = -t.z;
      tangentAt(flat, n - 1, n, closed, t);
      const l = (n - 1) * 3;
      pos[capB] = flat[l];
      pos[capB + 1] = flat[l + 1];
      pos[capB + 2] = flat[l + 2];
      nor[capB] = t.x;
      nor[capB + 1] = t.y;
      nor[capB + 2] = t.z;
    }

    this.position.needsUpdate = true;
    this.normal.needsUpdate = true;
    this.geometry.computeBoundingSphere();
  }

  dispose() {
    this.geometry.dispose();
  }
}

function tangentAt(flat, i, n, closed, out) {
  let a;
  let b;
  if (closed) {
    a = ((i - 1 + n) % n) * 3;
    b = ((i + 1) % n) * 3;
  } else {
    a = Math.max(0, i - 1) * 3;
    b = Math.min(n - 1, i + 1) * 3;
  }
  out.set(flat[b] - flat[a], flat[b + 1] - flat[a + 1], flat[b + 2] - flat[a + 2]);
  if (out.lengthSq() < 1e-12) out.set(0, 0, 1);
  else out.normalize();
  return out;
}

function seedPerpendicular(t, out) {
  // Pick the axis least aligned with the tangent, then orthogonalise.
  const ax = Math.abs(t.x);
  const ay = Math.abs(t.y);
  const az = Math.abs(t.z);
  if (ax <= ay && ax <= az) out.set(1, 0, 0);
  else if (ay <= az) out.set(0, 1, 0);
  else out.set(0, 0, 1);
  out.addScaledVector(t, -out.dot(t)).normalize();
  return out;
}
