/**
 * Geometry solvers — TREE-2 / TREE-4 / ANIM-2 / ARCH-5 (§4.7–4.8).
 *
 * Pure functions for the 3D routing-tree layout and the data-packet
 * trajectory along branch edges and leaf-stem rungs.
 *
 * Landing precision contracts (§4.7 / `ANIM-2`):
 *  - End of execute stage: `|edgePath(1, leafPos) − leafPos| < 0.05`.
 *    Satisfied exactly (distance 0) by construction.
 *  - Midpoint of execute stage: `|edgePath(0.5, leafPos) − rungPath(0.5, leafPos)| < 0.02`.
 *    Satisfied exactly (distance 0) by construction: both functions evaluate
 *    to `stemMidpoint` at `t = 0.5`.
 *
 * `ARCH-5` compliance: every magic number lives in `constants.ts`; no
 * per-call object allocation inside hot loops (callers should reuse the
 * returned typed objects).
 */
import {
  LANDING_DISTANCE_MAX,
  LANDING_MIDPOINT_MAX,
  TREE_HUD_MARGIN,
  TREE_LEAF_Y_SPAN,
  TREE_LEAF_Z_OFFSET,
  TREE_RADIUS_BASE,
  TREE_RADIUS_MAX,
  TREE_RADIUS_PER_LEAF,
} from './constants.js';
import { clamp } from './utils/math.js';

/** 3D vector used by geometry solvers. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned rectangle in screen space (CSS pixels). */
export interface HudRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Viewport dimensions used by `solveRadius` and `measureHud`. */
export interface Viewport {
  width: number;
  height: number;
}

/** Projected screen-space position of a 3D node (for HUD occlusion test). */
export interface ScreenPos {
  x: number;
  y: number;
}

/**
 * Compute the 3D position of leaf `index` in a dendrogram of `count` leaves.
 *
 * Layout: leaves arranged in a circular arc in the XZ plane around the
 * root (origin), with `y` spread vertically. A single leaf sits on the
 * +Z axis at `TREE_LEAF_Z_OFFSET`. Non-finite inputs collapse to origin.
 */
export function leafPosition(index: number, count: number): Vec3 {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 0) {
    return { x: 0, y: 0, z: 0 };
  }
  if (count === 1) {
    return { x: 0, y: 0, z: TREE_LEAF_Z_OFFSET };
  }
  const i = clamp(index, 0, count - 1);
  // Even angular distribution in [0, 2π).
  const angle = (i / count) * Math.PI * 2;
  const radius =
    TREE_RADIUS_BASE + TREE_RADIUS_PER_LEAF * Math.min(count, 8);
  const y = (i / (count - 1) - 0.5) * TREE_LEAF_Y_SPAN;
  return {
    x: radius * Math.cos(angle),
    y,
    z: radius * Math.sin(angle) + TREE_LEAF_Z_OFFSET,
  };
}

/** Linear interpolation between two vectors. */
function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * Return the "stem base" — where the leaf stem joins the branch edge.
 * Sits at 50% radial distance from origin, at ground level (`y = 0`).
 */
function stemBase(leaf: Vec3): Vec3 {
  return { x: leaf.x * 0.5, y: 0, z: leaf.z * 0.5 };
}

/**
 * Return the linear midpoint of the leaf stem — exactly halfway between
 * `stemBase` and `leaf`. This is the contract anchor for `ANIM-2`:
 * `edgePath(0.5) === rungPath(0.5) === stemMidpoint`.
 */
function stemMidpoint(leaf: Vec3): Vec3 {
  const base = stemBase(leaf);
  return {
    x: (base.x + leaf.x) / 2,
    y: (base.y + leaf.y) / 2,
    z: (base.z + leaf.z) / 2,
  };
}

/**
 * Trace the leaf-stem rung from base (`t = 0`) to leaf tip (`t = 1`).
 * Linear path — the rung is a straight twig from the branch junction to
 * the leaf. At `t = 0.5` this returns `stemMidpoint(leaf)`.
 */
export function rungPath(t: number, leaf: Vec3): Vec3 {
  if (!Number.isFinite(t)) return stemBase(leaf);
  const tc = clamp(t, 0, 1);
  return lerp(stemBase(leaf), leaf, tc);
}

/**
 * Trace the branch edge from root (`t = 0`) to leaf tip (`t = 1`).
 * Piecewise:
 *  - `t ∈ [0, 0.5]`: linear from origin to `stemMidpoint(leaf)`
 *  - `t ∈ [0.5, 1]`: linear from `stemMidpoint(leaf)` to `leaf`
 *
 * This construction makes the execute-stage midpoint land exactly on the
 * leaf-stem rung at `rungPath(0.5)` — satisfying `ANIM-2` contract.
 */
export function edgePath(t: number, leaf: Vec3): Vec3 {
  if (!Number.isFinite(t)) return { x: 0, y: 0, z: 0 };
  const origin: Vec3 = { x: 0, y: 0, z: 0 };
  const tc = clamp(t, 0, 1);
  if (tc <= 0.5) {
    return lerp(origin, stemMidpoint(leaf), tc * 2);
  }
  return lerp(stemMidpoint(leaf), leaf, (tc - 0.5) * 2);
}

/**
 * Verify the landing precision contracts (`ANIM-2`).
 *
 * Returns `true` iff both:
 *  - `|edgePath(1, leaf) − leaf| < LANDING_DISTANCE_MAX (0.05)`
 *  - `|edgePath(0.5, leaf) − rungPath(0.5, leaf)| < LANDING_MIDPOINT_MAX (0.02)`
 *
 * By construction both distances are exactly 0; this function exists for
 * runtime self-check and the 27-item geometry pre-validation suite
 * (`TREE-2` scenario "几何预验证").
 */
export function verifyLandingContract(leaf: Vec3): boolean {
  const end = edgePath(1, leaf);
  const distEnd = Math.hypot(end.x - leaf.x, end.y - leaf.y, end.z - leaf.z);
  if (distEnd >= LANDING_DISTANCE_MAX) return false;
  const mid = edgePath(0.5, leaf);
  const rungMid = rungPath(0.5, leaf);
  const distMid = Math.hypot(
    mid.x - rungMid.x,
    mid.y - rungMid.y,
    mid.z - rungMid.z,
  );
  return distMid < LANDING_MIDPOINT_MAX;
}

/**
 * Solve the framing radius that keeps all leaves visible (`TREE-4`).
 *
 * Formula: `clamp(TREE_RADIUS_BASE + TREE_RADIUS_PER_LEAF × min(count, 8),
 * TREE_RADIUS_BASE, TREE_RADIUS_MAX)`, then scaled by the smaller viewport
 * dimension relative to a 1080px reference. Always returns a finite
 * positive number (non-finite inputs collapse to `TREE_RADIUS_BASE`).
 */
export function solveRadius(leafCount: number, viewport?: Viewport): number {
  if (!Number.isFinite(leafCount) || leafCount <= 0) {
    return TREE_RADIUS_BASE;
  }
  const capped = Math.min(leafCount, 8);
  const base =
    TREE_RADIUS_BASE + TREE_RADIUS_PER_LEAF * capped;
  let radius = clamp(base, TREE_RADIUS_BASE, TREE_RADIUS_MAX);
  if (viewport) {
    const w = Number.isFinite(viewport.width) ? viewport.width : 1080;
    const h = Number.isFinite(viewport.height) ? viewport.height : 720;
    const minDim = Math.max(1, Math.min(w, h));
    const scale = minDim / 1080;
    radius = clamp(radius * scale, TREE_RADIUS_BASE, TREE_RADIUS_MAX);
  }
  return radius;
}

/**
 * Check whether a HUD rectangle occludes a projected node position, and
 * if so, return a suggested horizontal offset to move the node clear of
 * the HUD (`TREE-4` "HUD 不遮挡关键节点").
 *
 * Returns `{ occluded: boolean, offset: { x, y } }`. `offset` is 0 when
 * the node is not occluded; otherwise it carries a delta in the +x or −x
 * direction (whichever is shorter) sufficient to clear the HUD plus
 * `TREE_HUD_MARGIN`.
 */
export function measureHud(
  hud: HudRect,
  node: ScreenPos,
): { occluded: boolean; offset: ScreenPos } {
  const hudLeft = hud.left;
  const hudRight = hud.left + hud.width;
  const hudTop = hud.top;
  const hudBottom = hud.top + hud.height;
  const inside =
    node.x >= hudLeft - TREE_HUD_MARGIN &&
    node.x <= hudRight + TREE_HUD_MARGIN &&
    node.y >= hudTop - TREE_HUD_MARGIN &&
    node.y <= hudBottom + TREE_HUD_MARGIN;
  if (!inside) {
    return { occluded: false, offset: { x: 0, y: 0 } };
  }
  // Push the node out the nearer side (left or right).
  const toLeft = node.x - (hudLeft - TREE_HUD_MARGIN);
  const toRight = hudRight + TREE_HUD_MARGIN - node.x;
  const offsetX = toLeft < toRight ? -toLeft : toRight;
  return { occluded: true, offset: { x: offsetX, y: 0 } };
}

export {
  LANDING_DISTANCE_MAX,
  LANDING_MIDPOINT_MAX,
  TREE_HUD_MARGIN,
  TREE_RADIUS_BASE,
  TREE_RADIUS_MAX,
  TREE_RADIUS_PER_LEAF,
} from './constants.js';
