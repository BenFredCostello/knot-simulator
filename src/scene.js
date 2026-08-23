// ---------------------------------------------------------------------------
// scene.js — renderer, camera, lighting and view presets.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BG = 0x0a0d13;

export const VIEW_DIRS = {
  three: new THREE.Vector3(0.52, 0.66, 0.92).normalize(),
  top: new THREE.Vector3(0.0, 1.0, 0.035).normalize(),
  front: new THREE.Vector3(0.0, 0.07, 1.0).normalize(),
};

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(BG, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(BG, 26, 96);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400);
  camera.position.set(6, 8, 12);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.85;
  controls.minDistance = 1.2;
  controls.maxDistance = 160;

  scene.add(new THREE.HemisphereLight(0x8fc4ff, 0x0b1018, 0.85));

  const key = new THREE.DirectionalLight(0xffffff, 1.35);
  key.position.set(5, 9, 7);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x7ea8ff, 0.65);
  rim.position.set(-7, -4, -5);
  scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffc9a0, 0.32);
  fill.position.set(-4, 3, 8);
  scene.add(fill);

  const grid = new THREE.GridHelper(48, 48, 0x1d2635, 0x141b27);
  grid.position.y = -3.2;
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);

  // Floor and ceiling of the slab, shown only in peg mode so the hard bounds
  // are visible rather than mysterious.
  const makeBound = (opacity) => {
    const g = new THREE.GridHelper(40, 40, 0x27354a, 0x18202e);
    g.material.transparent = true;
    g.material.opacity = opacity;
    g.visible = false;
    scene.add(g);
    return g;
  };
  const slabFloor = makeBound(0.75);
  const slabCeil = makeBound(0.25);

  const pegMat = new THREE.MeshStandardMaterial({
    color: 0x6d7a8d,
    roughness: 0.42,
    metalness: 0.65,
    emissive: 0x0d1219,
  });
  const pegGroup = new THREE.Group();
  scene.add(pegGroup);

  /** Show `pegs` as upright rods spanning the slab, or hide them entirely. */
  function setPegs(pegs, radius) {
    while (pegGroup.children.length > pegs.length) {
      const m = pegGroup.children.pop();
      m.geometry.dispose();
    }
    while (pegGroup.children.length < pegs.length) {
      pegGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 14), pegMat));
    }
    pegs.forEach((p, i) => {
      const mesh = pegGroup.children[i];
      mesh.geometry.dispose();
      mesh.geometry = new THREE.CylinderGeometry(radius, radius, p.yhi - p.ylo, 14);
      mesh.position.set(p.x, (p.ylo + p.yhi) / 2, p.z);
    });
    const on = pegs.length > 0;
    grid.visible = !on;
    slabFloor.visible = on;
    slabCeil.visible = on;
    if (on) {
      slabFloor.position.y = pegs[0].ylo;
      slabCeil.position.y = pegs[0].yhi;
    }
  }

  /** Track peg positions as they dilate outward. */
  function updatePegs(pegs) {
    pegs.forEach((p, i) => {
      const mesh = pegGroup.children[i];
      if (mesh) mesh.position.set(p.x, (p.ylo + p.yhi) / 2, p.z);
    });
  }

  // Camera fly-to state, tweened in the render loop.
  const tween = {
    active: false,
    pos: new THREE.Vector3(),
    target: new THREE.Vector3(),
  };

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    if (canvas.width === w && canvas.height === h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  /** Frame `bounds` from direction `dir`. Set `immediate` to skip the tween. */
  function frame(bounds, dir, immediate = false) {
    if (!bounds) return;
    const c = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2
    );
    const r = Math.max(
      1.4,
      0.5 *
        Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2]
        )
    );
    const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.06;
    tween.target.copy(c);
    tween.pos.copy(c).addScaledVector(dir, dist);
    if (immediate) {
      camera.position.copy(tween.pos);
      controls.target.copy(tween.target);
      controls.update();
      tween.active = false;
    } else {
      tween.active = true;
    }
  }

  /**
   * Keep the link filling the frame while it contracts, without stealing the
   * user's orbit: only the distance and the look-at point are adjusted, along
   * whatever direction the camera is already viewing from.
   */
  function follow(bounds, lerp = 0.06) {
    if (!bounds || tween.active) return;
    const c = new THREE.Vector3(
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2
    );
    const r = Math.max(
      0.6,
      0.5 *
        Math.hypot(
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
          bounds.max[2] - bounds.min[2]
        )
    );
    const dist = (r / Math.sin((camera.fov * Math.PI) / 360)) * 1.25;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-8) return;
    dir.normalize();
    camera.position.lerp(c.clone().addScaledVector(dir, dist), lerp);
    controls.target.lerp(c, lerp);
  }

  function updateCamera() {
    if (tween.active) {
      camera.position.lerp(tween.pos, 0.14);
      controls.target.lerp(tween.target, 0.14);
      if (camera.position.distanceTo(tween.pos) < 0.02) tween.active = false;
    }
    controls.update();
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  /** Nearest intersected object for a pointer event, or null. */
  function pick(event, objects) {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(objects, false);
    return hits.length ? hits[0] : null;
  }

  return {
    renderer, scene, camera, controls,
    resize, frame, follow, updateCamera, pick,
    grid, setPegs, updatePegs,
  };
}
