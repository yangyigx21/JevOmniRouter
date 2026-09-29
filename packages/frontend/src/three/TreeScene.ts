/**
 * TreeScene — Sphere-based 3D routing visualization
 *
 * Reconstructed from jev-demo.html's visual style:
 *   - Sphere core + wireframe icosahedron shell + torus status ring + glow sprite per node
 *   - Icosahedron hub with question rings
 *   - Tree branching pipe system (shared trunk + per-model leaf stems)
 *   - Input/output portal gates
 *   - Data packet with glow + trail
 *   - InstancedMesh flow particles along edge curves
 *   - Score wave + select ring
 *   - Star field + grid + fog atmosphere
 *
 * Driven purely by computeRun() output (ARCH-3: animation decoupled from state).
 * All node/edge states driven by RouteEvent (ANIM-6: no self-inference).
 */
import * as THREE from 'three';
import { computeRun, type ComputeRunResult } from './computeRunFrontend.js';
import type { NodeVisualState } from '../store/routeEventReducer.js';

// ── Layout constants (matching jev-demo.html) ──

const HUB_POS = new THREE.Vector3(0, 0, 0);
const GATE_IN_POS: [number, number, number] = [-7.4, 0, 0];
const GATE_OUT_POS: [number, number, number] = [0, -6.2, 0];

const TRUNK_X = 1.55;
const ARM_X = 3.05;
const ARM_DY = 2.55;
const LEAF_X = 5.85;
const ROW_DY = 2.10;
const CORNER_R = 0.42;
const LEAF_Z = 0.52;
const NODE_GLOW = 1.30;
const EDGE_PARTICLES = 5;
const TRAIL_LEN = 20;

// ── Exported position constants ──

export const PROMPT_POS: [number, number, number] = GATE_IN_POS;
export const JEV_POS: [number, number, number] = [0, 0, 0];
export const OUTPUT_POS: [number, number, number] = GATE_OUT_POS;
export const KNOWLEDGE_POS: [number, number, number] = [9.0, 0, 0];

/** Index of the first candidate node (prompt=0, jev-hub=1; candidates start at 2) */
export const CANDIDATE_OFFSET = 2;

// ── Candidate planet definitions ──

/**
 * 一颗星球 = 一个模型厂商。
 *
 * 星球列表由 LLM 模型服务动态下发（`GET /v1/models/vendors`），
 * 节点数量、顺序、颜色均随之变化，前端不再硬编码模型清单。
 */
export interface PlanetDef {
  /** 节点 id：`vendor:<vendor>`，与 store 中的 NodeVisualState.id 对齐。 */
  id: string;
  vendor: string;
  /** 星球标签（厂商展示名，如 `DeepSeek`）。 */
  label: string;
  /** 该厂商提供的模型 id 列表。 */
  modelIds: readonly string[];
  modelCount: number;
  color: number;
}

/** 厂商分组 → 星球定义。 */
export function toPlanetDefs(
  groups: readonly {
    vendor: string;
    vendorLabel: string;
    modelIds: readonly string[];
    modelCount: number;
    color: number;
  }[],
): PlanetDef[] {
  return groups.map((g) => ({
    id: `vendor:${g.vendor}`,
    vendor: g.vendor,
    label: g.vendorLabel,
    modelIds: [...g.modelIds],
    modelCount: g.modelCount,
    color: g.color,
  }));
}

// ── 场景包围盒（相机取景依据）──

/** 透视相机 FOV —— StageView 建相机与取景计算共用同一份，避免两处漂移。 */
export const CAM_FOV = 50;
export const CAM_NEAR = 0.1;
/** 远裁剪面：星球数极多时相机需要退得很远，留足余量避免整场被裁掉。 */
export const CAM_FAR = 400;
/** 视口边距系数：>1 表示在包围盒外再留出呼吸空间，避免节点贴边。 */
const FIT_PADDING = 1.16;

/** 雾的目标光学厚度（density × 相机距离），使雾感与取景距离无关。 */
const FOG_OPTICAL_DEPTH = 0.31;

/** 场景在 XY 平面上的轴对齐包围盒。 */
export interface SceneBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 包围盒中心（相机 lookAt / position 的 x、y）。 */
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

/**
 * 节点视觉半径的额外余量：球体 + 线框壳 + 光晕 + 文字标签。
 * 决策库/星球标签是精灵（始终面向相机），按其半宽留出安全边距。
 */
const LABEL_PAD_X = 1.35;
const LABEL_PAD_Y = 1.55;

/**
 * 依据实际的星球列表计算场景包围盒。
 *
 * 星球数量由 LLM 模型服务动态下发（此前固定 6 个），相机若继续用硬编码
 * 取景会随厂商数变化而裁掉两端节点，因此取景必须由几何推导。
 */
export function computeSceneBounds(planets: readonly PlanetDef[]): SceneBounds {
  const n = planets.length;
  const xs: number[] = [GATE_IN_POS[0], KNOWLEDGE_POS[0]];
  const ys: number[] = [0];

  for (let k = 0; k < n; k++) {
    xs.push(LEAF_X);
    ys.push(leafY(k, n));
  }

  const minX = Math.min(...xs) - LABEL_PAD_X;
  const maxX = Math.max(...xs) + LABEL_PAD_X;
  const minY = Math.min(...ys) - LABEL_PAD_Y;
  const maxY = Math.max(...ys) + LABEL_PAD_Y;

  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** 视口描述：画布尺寸 + 上下被 HUD 覆盖的像素带。 */
export interface ViewportSpec {
  width: number;
  height: number;
  /** 画布顶部被标题条覆盖的高度（px）。 */
  topInset: number;
  /** 画布底部被步骤/控制条覆盖的高度（px）。 */
  bottomInset: number;
}

/** 相机取景结果。 */
export interface CameraFit {
  /** 相机沿 +Z 的后退距离。 */
  distance: number;
  /** lookAt 的 x（未叠加横向让位偏移）。 */
  centerX: number;
  /** lookAt 的 y（已补偿上下 HUD 覆盖带，包围盒落在净空带正中）。 */
  centerY: number;
}

/**
 * 依据场景包围盒与视口推算相机位置，使「Prompt输入 → Jev中枢 → 星球 → 决策库」
 * 恰好落在**净空区**内。
 *
 * 关键点是纵向：画布满高，但顶部标题条与底部步骤/控制条是浮在画布上的 overlay
 * （`#stage > .hud-tl` / `.hud-bottom` / `.hint`）。若按整幅画布取景，星球数量
 * 变多、相机后退到纵向由高度主导时，上下两排星球会被这两条带子压住。
 * 因此纵向净空比例 = 净空高 / 画布高，并按净空带中心（而非画布中心）对齐。
 */
export function computeCameraFit(b: SceneBounds, view: ViewportSpec): CameraFit {
  const aspect = view.width / view.height;
  const halfFovTan = Math.tan((CAM_FOV * Math.PI) / 360);

  // 纵向净空带高度；overlay 异常高时至少保留半幅画布，避免距离爆炸。
  const freeH = Math.max(
    view.height * 0.5,
    view.height - view.topInset - view.bottomInset,
  );
  const freeRatio = freeH / view.height;

  const distForHeight = b.height / 2 / (halfFovTan * freeRatio);
  const distForWidth = b.width / 2 / (halfFovTan * aspect);
  const distance = Math.max(distForHeight, distForWidth) * FIT_PADDING;

  // 画布中心（屏幕 y 向下为正）相对净空带中心的偏移，换算成世界单位补偿 lookAt。
  // 净空带中心高于画布中心时（顶部带更宽），相机需下移才能把内容顶上去，故取负号。
  const worldPerPx = (2 * distance * halfFovTan) / view.height;
  const centerOffsetPx = view.height / 2 - (view.topInset + freeH / 2);

  return {
    distance,
    centerX: b.centerX,
    centerY: b.centerY - centerOffsetPx * worldPerPx,
  };
}

/**
 * 相机后退时同步稀释雾密度。
 *
 * `FogExp2` 按到相机的距离衰减，相机因星球变多而后退时，原本合适的雾密度会
 * 让整场发灰。这里固定「光学厚度 = density × 距离」，使雾感不随取景距离变化。
 */
export function fitFogToDistance(objs: TreeSceneObjects, cameraDistance: number): void {
  const fog = objs.scene.fog;
  if (fog instanceof THREE.FogExp2) {
    fog.density = FOG_OPTICAL_DEPTH / Math.max(cameraDistance, 1e-3);
  }
}

// ── Question ring colors (5 typed questions) ──

const QUESTION_COLORS = [0x4ea1ff, 0x22d39a, 0xffb547, 0x8b5cff, 0x31d0d8];

// ── Tree layout geometry helpers ──

/** Y position of k-th model leaf node (k=0 at top) */
function leafY(k: number, n: number): number {
  return ((n - 1) * 0.5 - k) * ROW_DY;
}

/** Z stagger: alternate rows front/back */
function leafZ(k: number): number {
  return ((k % 2) ? -1 : 1) * LEAF_Z;
}

/** Which side of the tree: +1 = upper half, -1 = lower half */
function leafSide(k: number, n: number): number {
  return leafY(k, n) >= 0 ? 1 : -1;
}

/** Direction along the vertical stem toward the leaf: +1 = up, -1 = down */
function leafApproach(k: number, n: number): number {
  const y = leafY(k, n);
  const s = leafSide(k, n);
  return (y > s * ARM_DY) ? 1 : -1;
}

/** 3D position of k-th leaf node */
function nodePos(k: number, n: number): THREE.Vector3 {
  return new THREE.Vector3(LEAF_X, leafY(k, n), leafZ(k));
}

/** Leaf stem path: corner bezier + straight leaf stem (per-model colored tube) */
function rungPath(k: number, n: number): THREE.CurvePath<THREE.Vector3> {
  const y = leafY(k, n);
  const z = leafZ(k);
  const ap = leafApproach(k, n);
  const p = new THREE.CurvePath<THREE.Vector3>();
  p.add(new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(ARM_X, y - ap * CORNER_R, 0),
    new THREE.Vector3(ARM_X, y, 0),
    new THREE.Vector3(ARM_X + CORNER_R, y, 0),
  ));
  p.add(new THREE.LineCurve3(
    new THREE.Vector3(ARM_X + CORNER_R, y, 0),
    new THREE.Vector3(LEAF_X, y, z),
  ));
  return p;
}

/** Full edge path: hub → trunk → arm bezier → vertical stem → corner bezier → leaf stem */
function edgePath(k: number, n: number): THREE.CurvePath<THREE.Vector3> {
  const y = leafY(k, n);
  const s = leafSide(k, n);
  const ap = leafApproach(k, n);
  const P0 = new THREE.Vector3(TRUNK_X, 0, 0);
  const P1 = new THREE.Vector3(ARM_X, s * ARM_DY, 0);
  const P2 = new THREE.Vector3(ARM_X, y - ap * CORNER_R, 0);
  const p = new THREE.CurvePath<THREE.Vector3>();
  p.add(new THREE.LineCurve3(HUB_POS.clone(), P0.clone()));
  p.add(new THREE.QuadraticBezierCurve3(
    P0.clone(),
    new THREE.Vector3((TRUNK_X + ARM_X) * 0.5, s * ARM_DY * 0.10, 0),
    P1.clone(),
  ));
  p.add(new THREE.LineCurve3(P1.clone(), P2.clone()));
  const rp = rungPath(k, n);
  for (let i = 0; i < rp.curves.length; i++) p.add(rp.curves[i]);
  return p;
}

// ── Procedural glow texture ──

function makeGlowTexture(c0: string, c1: string, c2: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, c0);
  grad.addColorStop(0.20, c1);
  grad.addColorStop(0.52, c2);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ── Procedural label texture for sprite ──

/**
 * 文字贴图超采样倍率。
 *
 * 由 `computeCameraFit` 反推的 world→px 约 43.7 CSS px/世界单位，而标签 sprite
 * 宽 2.0 世界单位 ≈ 87 CSS px；画布 2x 超采样后约 175 设备像素。贴图取 256
 * 与之接近，缩小比例仅约 1.5x。放大到 3x（768px）反而会因降采样倍数过大而更糊。
 */
const TEXT_SS = 1;

/** 中文字体栈 —— Canvas 不支持 fallback 简写，需显式列出。 */
const CJK_FONT = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';

/**
 * 文字贴图使用**无 mipmap 的单次线性采样**。
 *
 * 标签在屏幕上只占约 175 设备像素，若开启 mipmap，GPU 会在 mip0(256) 与
 * mip1(128) 之间做三线性混合，把笔画糊掉；文字贴图也不需要各向异性过滤。
 */
function configureTextTexture(tex: THREE.CanvasTexture): THREE.CanvasTexture {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 自动收缩字号直到文字填满贴图的可用区。
 *
 * 固定字号会浪费贴图像素（如 28px 文字只占 256 宽的 40%），使字形有效分辨率
 * 偏低。这里从上限逐档下探，取**恰好装得下**的最大字号，让文字撑满宽度。
 */
function fitFontSize(
  g: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxH: number,
  weight: number,
  fontFamily: string,
  maxSize: number,
): number {
  let size = maxSize;
  while (size > 8) {
    g.font = `${weight} ${size}px ${fontFamily}`;
    if (g.measureText(text).width <= maxW && size <= maxH) return size;
    size -= 1;
  }
  return 8;
}

function makeLabelTexture(label: string, color: number): THREE.CanvasTexture {
  const W = 256 * TEXT_SS;
  const H = 64 * TEXT_SS;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const hex = '#' + color.toString(16).padStart(6, '0');
  // 星球区域统一使用 CJK_FONT，与说明文字 / 中枢标签保持一致；
  // 等宽字体对中文（厂商名常含中文）回退后宽度不均，sans-serif 更协调。
  const fontSize = fitFontSize(g, label, W * 0.88, H * 0.72, 700, CJK_FONT, 46);
  g.font = `700 ${fontSize}px ${CJK_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = hex;
  g.shadowBlur = 8 * TEXT_SS;
  g.fillStyle = '#f0f6ff';
  g.fillText(label, W / 2, H / 2);
  return configureTextTexture(new THREE.CanvasTexture(c));
}

/** 副标签纹理（比主标签更小更淡，用于补充说明文字）。 */
function makeCaptionTexture(text: string, color: number): THREE.CanvasTexture {
  const W = 256 * TEXT_SS;
  const H = 64 * TEXT_SS;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const hex = '#' + color.toString(16).padStart(6, '0');
  const fontSize = fitFontSize(g, text, W * 0.86, H * 0.6, 600, CJK_FONT, 40);
  g.font = `600 ${fontSize}px ${CJK_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = hex;
  g.shadowBlur = 6 * TEXT_SS;
  g.fillStyle = '#cfe0f5';
  g.fillText(text, W / 2, H / 2);
  return configureTextTexture(new THREE.CanvasTexture(c));
}

/** 中枢大星球的主标注（中文，用 CJK 字体栈渲染）。 */
function makeHubLabelTexture(text: string, color: number): THREE.CanvasTexture {
  const W = 512 * TEXT_SS;
  const H = 128 * TEXT_SS;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  const hex = '#' + color.toString(16).padStart(6, '0');
  const mainSize = fitFontSize(g, text, W * 0.9, H * 0.46, 800, CJK_FONT, 60);
  g.font = `800 ${mainSize}px ${CJK_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = hex;
  g.shadowBlur = 18 * TEXT_SS;
  g.fillStyle = '#ffffff';
  g.fillText(text, W / 2, H * 0.4);
  g.shadowBlur = 8 * TEXT_SS;
  g.font = `600 ${22 * TEXT_SS}px ${CJK_FONT}`;
  g.fillStyle = hex;
  g.fillText('JEV ROUTING HUB', W / 2, H * 0.75);
  return configureTextTexture(new THREE.CanvasTexture(c));
}

// ── Seeded random for star field ──
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ── Node definitions ──

export interface TreeNodeDef {
  id: string;
  label: string;
  type: 'prompt' | 'jev-hub' | 'candidate' | 'knowledge';
  pos: [number, number, number];
  color: number;
  radius: number;
}

export function buildNodeDefs(planets: readonly PlanetDef[]): TreeNodeDef[] {
  const n = planets.length;
  const nodes: TreeNodeDef[] = [
    { id: 'prompt', label: 'Prompt输入', type: 'prompt', pos: GATE_IN_POS, color: 0x4ea1ff, radius: 0.52 },
    { id: 'jev-hub', label: 'Jev智能路由中枢', type: 'jev-hub', pos: [0, 0, 0], color: 0x8b5cff, radius: 0.72 },
  ];
  for (let k = 0; k < n; k++) {
    const c = planets[k];
    nodes.push({
      id: c.id,
      label: c.label,
      type: 'candidate',
      pos: [LEAF_X, leafY(k, n), leafZ(k)],
      color: c.color,
      radius: 0.52,
    });
  }
  nodes.push(
    { id: 'knowledge', label: '决策库', type: 'knowledge', pos: [9.0, 0, 0], color: 0x22d39a, radius: 0.52 },
  );
  return nodes;
}

// ── Edge definitions ──

export interface TreeEdgeDef {
  from: number;
  to: number;
  color: number;
  stage: 'ingest' | 'analyze' | 'execute' | 'return';
}

export function buildEdgeDefs(nodeCount: number, planets: readonly PlanetDef[]): TreeEdgeDef[] {
  const edges: TreeEdgeDef[] = [];
  const candidateCount = planets.length;

  // prompt → jev-hub (0 → 1) — ingest
  edges.push({ from: 0, to: 1, color: 0x4ea1ff, stage: 'ingest' });

  // jev-hub → each candidate — analyze (hub→leaf tree paths)
  for (let i = 0; i < candidateCount; i++) {
    edges.push({ from: 1, to: CANDIDATE_OFFSET + i, color: planets[i].color, stage: 'analyze' });
  }

  // winner candidate → knowledge — execute (knowledge is the end node, last index)
  for (let i = 0; i < candidateCount; i++) {
    edges.push({ from: CANDIDATE_OFFSET + i, to: nodeCount - 1, color: planets[i].color, stage: 'execute' });
  }

  return edges;
}

// ── Scene objects interface ──

export interface DashedEdge {
  group: THREE.Group;
  line: THREE.Line;
  material: THREE.LineDashedMaterial;
  /** true for prompt→hub, false for candidate→knowledge */
  isPrompt: boolean;
}

export interface TreeSceneObjects {
  scene: THREE.Scene;
  nodes: THREE.Group[];
  edges: THREE.Mesh[];
  edgeCurves: THREE.CurvePath<THREE.Vector3>[];
  treeGroup: THREE.Group;
  treeMaterial: THREE.MeshBasicMaterial;
  hub: THREE.Group;
  hubCore: THREE.Mesh;
  hubShell: THREE.Mesh;
  qRings: THREE.Mesh[];
  packet: THREE.Mesh;
  packetGlow: THREE.Sprite;
  packetTrail: THREE.InstancedMesh;
  trailBuf: THREE.Vector3[];
  trailHead: number;
  particleMesh: THREE.InstancedMesh;
  particleData: { edge: number; off: number; speed: number }[];
  scoreWave: THREE.Mesh;
  selectRing: THREE.Mesh;
  gates: THREE.Group[];
  gateRings: THREE.Mesh[];
  stars: THREE.Points;
  grid: THREE.GridHelper;
  nodeDefs: TreeNodeDef[];
  edgeDefs: TreeEdgeDef[];
  dashedEdges: DashedEdge[];
  /** 星球（厂商）定义，renderFrame 按索引取用。 */
  planets: PlanetDef[];
}

// ── Build scene ──

export function buildTreeScene(planets: readonly PlanetDef[]): TreeSceneObjects {
  const scene = new THREE.Scene();
  const nodeDefs = buildNodeDefs(planets);
  const edgeDefs = buildEdgeDefs(nodeDefs.length, planets);
  const n = planets.length;

  // ── Atmosphere ──
  scene.fog = new THREE.FogExp2(0x060a12, 0.0165);
  scene.add(new THREE.AmbientLight(0x3a5480, 0.4));
  const p1 = new THREE.PointLight(0x4ea1ff, 0.8, 70, 2);
  p1.position.set(11, 9, 8);
  scene.add(p1);
  const p2 = new THREE.PointLight(0x8b5cff, 0.6, 70, 2);
  p2.position.set(-11, -6, -9);
  scene.add(p2);
  const p3 = new THREE.PointLight(0x31d0d8, 0.4, 60, 2);
  p3.position.set(0, -12, 5);
  scene.add(p3);

  // ── Star field ──
  const rnd = mulberry32(20260924);
  const starN = 420;
  const sp = new Float32Array(starN * 3);
  for (let i = 0; i < starN; i++) {
    const r = 26 + rnd() * 44;
    const th = rnd() * Math.PI * 2;
    const ph = Math.acos(2 * rnd() - 1);
    sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
    sp[i * 3 + 1] = r * Math.cos(ph) * 0.7;
    sp[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({
    color: 0x3a5c8f, size: 0.34, sizeAttenuation: true, transparent: true, opacity: 0.75,
  }));
  scene.add(stars);

  // ── Grid ──
  // 地面网格跟随场景横向中心，保证网格在取景框内对称铺开。
  const gridBounds = computeSceneBounds(planets);
  const grid = new THREE.GridHelper(44, 22, 0x1d3355, 0x14243d);
  grid.position.set(gridBounds.centerX, gridBounds.minY - 0.4, 0);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.5;
  scene.add(grid);

  // ── Textures ──
  const texHub = makeGlowTexture('rgba(205,228,255,0.78)', 'rgba(78,161,255,0.28)', 'rgba(60,120,220,0.06)');
  const texNode = makeGlowTexture('rgba(255,255,255,0.46)', 'rgba(185,215,255,0.17)', 'rgba(120,180,255,0.045)');
  const texPacket = makeGlowTexture('rgba(255,255,255,0.95)', 'rgba(165,208,255,0.40)', 'rgba(90,150,240,0.08)');

  // ── Hub (JEV CORE) ──
  const hub = new THREE.Group();
  const hubCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.66, 2),
    new THREE.MeshStandardMaterial({
      color: 0x7fb4ff, emissive: 0x3f8fe8, emissiveIntensity: 1.25,
      roughness: 0.4, metalness: 0.0,
    }),
  );
  hub.add(hubCore);

  const hubShell = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.38, 1),
    new THREE.MeshBasicMaterial({ color: 0x6fb4ff, wireframe: true, transparent: true, opacity: 0.32 }),
  );
  hub.add(hubShell);

  // Question rings
  const qRings: THREE.Mesh[] = [];
  for (let d = 0; d < 5; d++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.02 + d * 0.17, 0.019, 6, 88),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(QUESTION_COLORS[d]),
        transparent: true, opacity: 0.14,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ring.rotation.set(d * 0.72 + 0.3, d * 1.08, d * 0.35);
    ring.userData.q = d;
    hub.add(ring);
    qRings.push(ring);
  }

  // Hub glow sprite
  const hubGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texHub, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.62,
  }));
  hubGlow.scale.set(5.2, 5.2, 1);
  hub.add(hubGlow);
  hub.userData.glow = hubGlow;

  // 大星球节点标注：Jev智能路由中枢
  const hubLabelTex = makeHubLabelTexture('Jev智能路由中枢', 0x8b5cff);
  const hubLabel = new THREE.Sprite(new THREE.SpriteMaterial({
    map: hubLabelTex, transparent: true, depthWrite: false, opacity: 0.98,
  }));
  hubLabel.scale.set(3.4, 0.85, 1);
  hubLabel.position.set(0, -2.05, 0);
  hub.add(hubLabel);
  hub.userData.hubLabel = hubLabel;

  scene.add(hub);

  // ── Model leaf nodes (sphere-based) ──
  const nodes: THREE.Group[] = [];
  const coreGeo = new THREE.SphereGeometry(0.40, 26, 20);
  const shellGeo = new THREE.IcosahedronGeometry(0.62, 1);
  const ringGeo = new THREE.TorusGeometry(0.58, 0.028, 6, 52);

  for (let k = 0; k < n; k++) {
    const c = planets[k];
    const g = new THREE.Group();
    g.position.copy(nodePos(k, n));

    const core = new THREE.Mesh(coreGeo, new THREE.MeshStandardMaterial({
      color: new THREE.Color(c.color), emissive: new THREE.Color(c.color),
      emissiveIntensity: 0.72, roughness: 0.55, metalness: 0.0,
    }));
    core.userData.nodeIdx = k;
    g.add(core);
    g.userData.core = core;

    const shell = new THREE.Mesh(shellGeo, new THREE.MeshBasicMaterial({
      color: new THREE.Color(c.color), wireframe: true, transparent: true, opacity: 0.22,
    }));
    g.add(shell);
    g.userData.shell = shell;

    const sring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0x22d39a, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    g.add(sring);
    g.userData.statusRing = sring;

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texNode, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.3, color: new THREE.Color(c.color),
    }));
    glow.scale.set(NODE_GLOW, NODE_GLOW, 1);
    g.add(glow);
    g.userData.glow = glow;

    // Label sprite below the sphere: 厂商名 + 模型数量
    const labelTex = makeLabelTexture(c.label, c.color);
    const labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: labelTex, transparent: true, depthWrite: false, opacity: 0.95,
    }));
    labelSprite.scale.set(2.0, 0.5, 1);
    labelSprite.position.y = -0.78;
    g.add(labelSprite);
    g.userData.labelSprite = labelSprite;

    // Model-count caption under the vendor label
    const countTex = makeCaptionTexture(`${c.modelCount} 个模型`, c.color);
    const countSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: countTex, transparent: true, depthWrite: false, opacity: 0.72,
    }));
    countSprite.scale.set(1.7, 0.42, 1);
    countSprite.position.y = -1.16;
    g.add(countSprite);
    g.userData.countSprite = countSprite;

    scene.add(g);
    nodes.push(g);
  }

  // ── Tree branching pipe system ──
  const trunkMat = new THREE.MeshBasicMaterial({
    color: 0x6d90c8, transparent: true, opacity: 0.20,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const treeGroup = new THREE.Group();

  function addTrunk(curve: THREE.Curve<THREE.Vector3>, radius: number, segs: number): void {
    treeGroup.add(new THREE.Mesh(
      new THREE.TubeGeometry(curve, segs, radius, 5, false), trunkMat,
    ));
  }

  const halfN = (n - 1) * 0.5;
  const innerRow = Math.floor((n - 1) / 2);

  // Main trunk: hub → fork point
  addTrunk(new THREE.LineCurve3(HUB_POS.clone(), new THREE.Vector3(TRUNK_X, 0, 0)), 0.046, 8);

  for (let sd = -1; sd <= 1; sd += 2) {
    // Left/right arms: fork → vertical stem junction
    addTrunk(new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(TRUNK_X, 0, 0),
      new THREE.Vector3((TRUNK_X + ARM_X) * 0.5, sd * ARM_DY * 0.10, 0),
      new THREE.Vector3(ARM_X, sd * ARM_DY, 0),
    ), 0.038, 20);

    // Vertical stems
    addTrunk(new THREE.LineCurve3(
      new THREE.Vector3(ARM_X, sd * ROW_DY * halfN, 0),
      new THREE.Vector3(ARM_X, sd * ROW_DY * (halfN - innerRow), 0),
    ), 0.032, 8);
  }
  scene.add(treeGroup);

  // ── Leaf stem tubes (per-model colored) + full edge curves ──
  const edges: THREE.Mesh[] = [];
  const edgeCurves: THREE.CurvePath<THREE.Vector3>[] = [];

  for (let e = 0; e < n; e++) {
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(rungPath(e, n), 20, 0.024, 5, false),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(planets[e].color), transparent: true,
        opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    scene.add(tube);
    edges.push(tube);

    const curve = edgePath(e, n);
    edgeCurves.push(curve);
  }

  // Warm arc-length caches
  const _warmV = new THREE.Vector3();
  for (let w = 0; w < n; w++) edgeCurves[w].getPointAt(0.5, _warmV);

  // ── Flow particles (InstancedMesh) ──
  const totalParticles = n * EDGE_PARTICLES;
  const particleMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.062, 6, 5),
    new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    totalParticles,
  );
  particleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  particleMesh.frustumCulled = false;
  const _initCol = new THREE.Color();
  for (let p = 0; p < totalParticles; p++) particleMesh.setColorAt(p, _initCol.setHex(0x4ea1ff));
  scene.add(particleMesh);

  const particleData: { edge: number; off: number; speed: number }[] = [];
  for (let e2 = 0; e2 < n; e2++) {
    for (let q = 0; q < EDGE_PARTICLES; q++) {
      particleData.push({ edge: e2, off: q / EDGE_PARTICLES, speed: 0.16 + (q % 3) * 0.045 });
    }
  }

  // ── Data packet ──
  const packet = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 18, 14),
    new THREE.MeshBasicMaterial({ color: 0xf2f8ff }),
  );
  packet.visible = false;
  scene.add(packet);

  const packetGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texPacket, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  packetGlow.scale.set(2.2, 2.2, 1);
  packet.add(packetGlow);

  const packetTrail = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.085, 5, 4),
    new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    TRAIL_LEN,
  );
  packetTrail.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  packetTrail.frustumCulled = false;
  packetTrail.visible = false;
  const _trailCol = new THREE.Color();
  for (let ti = 0; ti < TRAIL_LEN; ti++) packetTrail.setColorAt(ti, _trailCol.setRGB(0.5, 0.75, 1));
  scene.add(packetTrail);

  const trailBuf: THREE.Vector3[] = [];
  for (let tb = 0; tb < TRAIL_LEN; tb++) trailBuf.push(new THREE.Vector3());
  let trailHead = 0;

  // ── Score wave ──
  const scoreWave = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.028, 6, 96),
    new THREE.MeshBasicMaterial({
      color: 0x8b5cff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  scoreWave.visible = false;
  scene.add(scoreWave);

  // ── Select ring ──
  const selectRing = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.05, 6, 72),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  selectRing.visible = false;
  scene.add(selectRing);

  // ── End nodes: prompt (start) + knowledge (end) as solid spheres ──
  const gates: THREE.Group[] = [];
  const gateRings: THREE.Mesh[] = [];

  const endNodeGeo = new THREE.SphereGeometry(0.40, 26, 20);
  const endNodeShellGeo = new THREE.IcosahedronGeometry(0.62, 1);
  const endNodeDefs = [
    { pos: new THREE.Vector3(...GATE_IN_POS), color: 0x4ea1ff, label: 'Prompt输入' },
    { pos: new THREE.Vector3(...KNOWLEDGE_POS), color: 0x22d39a, label: '决策库' },
  ];
  for (const en of endNodeDefs) {
    const g = new THREE.Group();
    g.position.copy(en.pos);

    const core = new THREE.Mesh(endNodeGeo, new THREE.MeshStandardMaterial({
      color: en.color, emissive: en.color, emissiveIntensity: 0.72,
      roughness: 0.55, metalness: 0.0,
    }));
    g.add(core);

    const shell = new THREE.Mesh(endNodeShellGeo, new THREE.MeshBasicMaterial({
      color: en.color, wireframe: true, transparent: true, opacity: 0.22,
    }));
    g.add(shell);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texNode, blending: THREE.AdditiveBlending, depthWrite: false,
      transparent: true, opacity: 0.3, color: en.color,
    }));
    glow.scale.set(NODE_GLOW, NODE_GLOW, 1);
    g.add(glow);

    const labelTex = makeLabelTexture(en.label, en.color);
    const labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: labelTex, transparent: true, depthWrite: false, opacity: 0.95,
    }));
    labelSprite.scale.set(2.0, 0.5, 1);
    labelSprite.position.y = -0.78;
    g.add(labelSprite);

    scene.add(g);
  }

  // ── Dashed logical connections ──
  // prompt → hub (Prompt输入 → Jev智能路由中枢)
  // candidate → knowledge (每个模型 → 决策库)
  // These represent "logical paths" (not the data packet route) and are
  // visually distinguished from the solid trunk/leaf-stem pipe system.
  const dashedEdges: DashedEdge[] = [];
  const dashedInMat = new THREE.LineDashedMaterial({
    color: 0x4ea1ff,
    dashSize: 0.24,
    gapSize: 0.16,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    linewidth: 1,
  });
  const dashedInLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(GATE_IN_POS[0], GATE_IN_POS[1], GATE_IN_POS[2]),
      new THREE.Vector3(0, 0, 0),
    ]),
    dashedInMat,
  );
  dashedInLine.computeLineDistances();
  const dashedInGroup = new THREE.Group();
  dashedInGroup.add(dashedInLine);
  scene.add(dashedInGroup);
  dashedEdges.push({ group: dashedInGroup, line: dashedInLine, material: dashedInMat, isPrompt: true });

  for (let k = 0; k < n; k++) {
    const mat = new THREE.LineDashedMaterial({
      color: new THREE.Color(planets[k].color),
      dashSize: 0.28,
      gapSize: 0.20,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      linewidth: 1,
    });
    const from = nodePos(k, n);
    const to = new THREE.Vector3(...KNOWLEDGE_POS);
    // Slight outward bezier via intermediate points for a natural arc
    const midX = (from.x + to.x) * 0.5 + 0.9;
    const midZ = (from.z + to.z) * 0.5 + 0.7;
    const points: THREE.Vector3[] = [];
    const segs = 24;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const it = 1 - t;
      points.push(new THREE.Vector3(
        it * it * from.x + 2 * it * t * midX + t * t * to.x,
        it * it * from.y + 2 * it * t * ((from.y + to.y) * 0.5) + t * t * to.y,
        it * it * from.z + 2 * it * t * midZ + t * t * to.z,
      ));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(geom, mat);
    line.computeLineDistances();
    const grp = new THREE.Group();
    grp.add(line);
    scene.add(grp);
    dashedEdges.push({ group: grp, line, material: mat, isPrompt: false });
  }

  return {
    scene, nodes, edges, edgeCurves,
    treeGroup, treeMaterial: trunkMat,
    hub, hubCore, hubShell, qRings,
    packet, packetGlow, packetTrail, trailBuf, trailHead,
    particleMesh, particleData,
    scoreWave, selectRing,
    gates, gateRings,
    stars, grid,
    nodeDefs, edgeDefs,
    dashedEdges,
    planets: [...planets],
  };
}

// ── Temporary objects (avoid per-frame allocation) ──

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _col = new THREE.Color();

// ── Packet position solver ──

function packetPos(
  run: ComputeRunResult,
  objs: TreeSceneObjects,
  winnerIdx: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const pk = run.packet;
  const winPos = objs.nodes[winnerIdx] ? objs.nodes[winnerIdx].position : HUB_POS;
  switch (pk.path) {
    case 'in': {
      _v4.set(...GATE_IN_POS).lerp(HUB_POS, pk.s);
      _v4.z += Math.sin(pk.s * Math.PI) * 1.5;
      _v4.y += Math.sin(pk.s * Math.PI) * 0.55;
      return out.copy(_v4);
    }
    case 'orbit': {
      const a = pk.s * Math.PI * 2 * 1.35 - Math.PI / 2;
      return out.set(Math.cos(a) * 2.15, Math.sin(a) * 1.75, Math.sin(a * 2) * 0.55);
    }
    case 'hub':
      return out.set(0, Math.sin(run.t * 0.004) * 0.22, 0);
    case 'toNode': {
      const cp = objs.edgeCurves[winnerIdx];
      if (cp) return cp.getPointAt(Math.max(0, Math.min(1, pk.s)), out);
      return out.copy(winPos);
    }
    case 'back': {
      const cp2 = objs.edgeCurves[winnerIdx];
      if (cp2) {
        cp2.getPointAt(1 - Math.max(0, Math.min(1, pk.s)), out);
        out.z += 0.72;
        return out;
      }
      return out.copy(winPos);
    }
    case 'out': {
      _v4.set(4.5, 0.8, 1.7);
      return bezier3(HUB_POS, _v4, new THREE.Vector3(...KNOWLEDGE_POS), pk.s, out);
    }
    default:
      return out.copy(HUB_POS);
  }
}

function bezier3(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const it = 1 - t;
  out.set(
    it * it * p0.x + 2 * it * t * p1.x + t * t * p2.x,
    it * it * p0.y + 2 * it * t * p1.y + t * t * p2.y,
    it * it * p0.z + 2 * it * t * p1.z + t * t * p2.z,
  );
  return out;
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

// ── Render frame ──

export function renderFrame(
  objs: TreeSceneObjects,
  animTime: number,
  routeState: { stage: string; routeTier: string | null; confidence: number | null; winnerModelId: string | null; events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>; nodes: readonly NodeVisualState[] },
  winnerIdx: number,
  probs: number[],
  _running = false,
): void {
  const { nodes, edges, edgeCurves, treeMaterial, hub, hubCore, hubShell, qRings,
    packet, packetGlow, particleMesh, particleData,
    scoreWave, selectRing, gates, gateRings, stars, dashedEdges } = objs;

  const n = objs.planets.length;
  const candidateCount = n;
  const ctx = {
    winnerIdx,
    nodeCount: objs.nodeDefs.length,
    probs: probs.length ? probs : Array(candidateCount).fill(1 / candidateCount),
    confidence: routeState.confidence ?? 0,
    tier: routeState.routeTier ?? 'ROUTE',
  };
  const run = computeRun(animTime, ctx);

  const isRouting = routeState.stage !== 'idle';
  const clock = animTime / 1000;
  const dt = 1 / 60; // approximate frame time

  // Tier colors
  const tierColorMap: Record<string, number> = {
    ROUTE: 0x00e676,
    GATE: 0xffc107,
    ESCALATE: 0xff1744,
    IDLE: 0x90a4ae,
  };
  const tierColor = tierColorMap[routeState.routeTier ?? 'IDLE'] ?? 0x90a4ae;

  // ── Hub animations ──
  hubCore.rotation.y += dt * 0.42;
  hubCore.rotation.x += dt * 0.17;
  const breathe = 1 + Math.sin(clock * 1.9) * 0.05;
  const analyzeBoost = 1 + run.pAnalyze * 0.22;
  hubCore.scale.setScalar(breathe * analyzeBoost);
  (hubCore.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.0 + run.pAnalyze * 0.9 + run.pScore * 0.45;
  hubShell.rotation.y -= dt * 0.24;
  hubShell.rotation.z += dt * 0.11;
  (hubShell.material as THREE.MeshBasicMaterial).opacity = 0.2 + run.pAnalyze * 0.35 + run.pScore * 0.2;

  const hubGlow = hub.userData.glow as THREE.Sprite;
  if (hubGlow) {
    hubGlow.material.opacity = 0.40 + run.pAnalyze * 0.30 + run.pScore * 0.14;
    hubGlow.scale.setScalar(5.2 * (1 + run.pAnalyze * 0.12));
  }

  // 中枢大星球标注：分析/评分阶段提亮
  const hubLabel = hub.userData.hubLabel as THREE.Sprite | undefined;
  if (hubLabel) {
    hubLabel.material.opacity = 0.72 + run.pAnalyze * 0.20 + run.pScore * 0.08;
    const hs = 1 + run.pAnalyze * 0.07;
    hubLabel.scale.set(3.4 * hs, 0.85 * hs, 1);
  }

  // Question rings
  for (let d = 0; d < qRings.length; d++) {
    const ring = qRings[d];
    const lit = run.qAct[d] ?? 0;
    (ring.material as THREE.MeshBasicMaterial).opacity = 0.10 + lit * 0.82;
    const sc = 1 + lit * 0.09;
    ring.scale.set(sc, sc, sc);
    ring.rotation.y += dt * (0.12 + lit * 0.5);
    ring.rotation.z += dt * (0.05 + lit * 0.2);
  }

  // ── Node animations ──
  for (let k = 0; k < nodes.length; k++) {
    const group = nodes[k];
    // scene 的 nodes[] 只含候选星球（索引 0..n-1），k 本身就是候选索引；
    // nodeDefs 里候选从 CANDIDATE_OFFSET 开始，planets 则从 0 开始。
    const candIdx = k;
    const def = objs.nodeDefs[candIdx + CANDIDATE_OFFSET];
    const planet = objs.planets[candIdx];
    if (!def || !planet) continue;

    const core = group.userData.core as THREE.Mesh | undefined;
    const shell = group.userData.shell as THREE.Mesh | undefined;
    const sring = group.userData.statusRing as THREE.Mesh | undefined;
    const glow = group.userData.glow as THREE.Sprite | undefined;
    const labelSprite = group.userData.labelSprite as THREE.Sprite | undefined;
    const countSprite = group.userData.countSprite as THREE.Sprite | undefined;

    const isActive = routeState.nodes.some((ns: NodeVisualState) => ns.id === def.id && ns.active);
    // 胜出是模型级的，星球节点按 modelIds 归属判定。
    const isWinner =
      routeState.winnerModelId !== null && planet.modelIds.includes(routeState.winnerModelId);
    const isGreyed = routeState.nodes.some((ns: NodeVisualState) => ns.id === def.id && ns.greyedOut);

    // nodeGlow is indexed by candidate index
    const glowVal = (candIdx >= 0 && candIdx < candidateCount)
      ? (run.nodeGlow[candIdx] ?? 0) : 0;

    if (core) {
      const coreMat = core.material as THREE.MeshStandardMaterial;
      if (isGreyed) {
        coreMat.emissiveIntensity = 0.2;
        core.scale.setScalar(0.85);
      } else if (isWinner) {
        coreMat.emissiveIntensity = 0.72 + 1.6 * 0.26 + 0.2;
        core.scale.setScalar(1 + 1.6 * 0.14 + run.execIntensity * 0.2);
      } else if (isActive) {
        coreMat.emissiveIntensity = 0.72 + Math.min(glowVal, 1.6) * 0.26;
        core.scale.setScalar(1 + glowVal * 0.14);
      } else {
        coreMat.emissiveIntensity = 0.72 + Math.min(glowVal, 1.6) * 0.26;
        core.scale.setScalar(1 + glowVal * 0.14);
      }
    }

    if (shell) {
      const shellMat = shell.material as THREE.MeshBasicMaterial;
      shell.rotation.y += dt * (0.3 + glowVal * 1.6);
      shell.rotation.x += dt * 0.14;
      shellMat.opacity = 0.14 + glowVal * 0.5;
    }

    if (sring) {
      const sringMat = sring.material as THREE.MeshBasicMaterial;
      // Status ring color: green=ROUTE, amber=GATE, red=ESCALATE
      if (isWinner) {
        sringMat.color.setHex(tierColor);
      } else if (isActive) {
        sringMat.color.setHex(0x4ea1ff);
      } else {
        sringMat.color.setHex(0x22d39a);
      }
      sringMat.opacity = 0.42 + Math.min(glowVal, 1.5) * 0.32;
      const rs = 1 + glowVal * 0.18 + (isWinner ? 0.12 : 0);
      sring.scale.set(rs, rs, rs);
      sring.rotation.z += dt * (0.25 + glowVal * 2.4);
    }

    if (glow) {
      glow.material.opacity = 0.10 + Math.min(glowVal, 1.5) * 0.22 + (isWinner ? 0.14 : 0);
      glow.scale.setScalar(NODE_GLOW * (1 + Math.min(glowVal, 1.6) * 0.20));
    }

    if (labelSprite) {
      labelSprite.material.opacity = isGreyed ? 0.25 : (isWinner ? 1.0 : 0.85);
    }

    if (countSprite) {
      countSprite.material.opacity = isGreyed ? 0.18 : (isWinner ? 0.95 : 0.72);
    }
  }

  // ── Leaf stem edges: opacity by flow ──
  let maxFlow = 0;
  for (let e = 0; e < edges.length; e++) {
    const flow = run.edgeFlow[e + 1] ?? 0; // +1 because edgeFlow[0] = prompt→hub
    if (flow > maxFlow) maxFlow = flow;
    const isWinEdge = (e === winnerIdx);
    let base = 0.1 + flow * 0.5;
    if (isWinEdge && run.pSelect > 0) base += 0.34 * run.pSelect;
    if (isWinEdge && run.pExec > 0) base += 0.2 * run.execIntensity;
    (edges[e].material as THREE.MeshBasicMaterial).opacity = clamp(base, 0.06, 0.92);
  }

  // ── Shared trunk material ──
  let tOp = 0.10 + maxFlow * 0.30;
  if (run.pSelect > 0) tOp += 0.16 * run.pSelect;
  if (run.pExec > 0) tOp += 0.14 * run.execIntensity;
  // Also account for ingest flow
  const ingestFlow = run.edgeFlow[0] ?? 0;
  if (ingestFlow > maxFlow) tOp = 0.10 + ingestFlow * 0.30;
  treeMaterial.opacity = clamp(tOp, 0.06, 0.78);

  // ── Flow particles ──
  let pIdx = 0;
  for (let pi = 0; pi < particleData.length; pi++) {
    const pd = particleData[pi];
    const curve = edgeCurves[pd.edge];
    if (!curve) { pIdx++; continue; }

    const edgeFlow = run.edgeFlow[pd.edge + 1] ?? 0;
    const u = (pd.off + clock * pd.speed * (0.5 + edgeFlow * 0.9)) % 1;
    curve.getPoint(u, _v1);
    const vis = edgeFlow > 0.12;
    const sc2 = vis ? (0.5 + edgeFlow * 0.75) : 0.0001;
    _dummy.position.copy(_v1);
    _dummy.scale.setScalar(sc2);
    _dummy.rotation.set(0, 0, 0);
    _dummy.updateMatrix();
    particleMesh.setMatrixAt(pIdx, _dummy.matrix);
    _col.set(objs.planets[pd.edge].color).multiplyScalar(0.35 + edgeFlow * 0.9);
    particleMesh.setColorAt(pIdx, _col);
    pIdx++;
  }
  particleMesh.instanceMatrix.needsUpdate = true;
  if (particleMesh.instanceColor) particleMesh.instanceColor.needsUpdate = true;

  // ── Data packet ──
  packet.visible = run.packet.visible && isRouting;
  objs.packetTrail.visible = run.packet.visible && isRouting;
  if (run.packet.visible && isRouting) {
    packetPos(run, objs, winnerIdx, _v2);
    packet.position.copy(_v2);
    const ps = 0.9 + Math.sin(clock * 9) * 0.07;
    packet.scale.setScalar(ps);
    packetGlow.material.opacity = 0.75 + Math.sin(clock * 6) * 0.2;

    // Trail
    const packetTrail = objs.packetTrail;
    const trailBuf = objs.trailBuf;
    objs.trailBuf[objs.trailHead].copy(_v2);
    objs.trailHead = (objs.trailHead + 1) % TRAIL_LEN;
    for (let t2 = 0; t2 < TRAIL_LEN; t2++) {
      const src = trailBuf[(objs.trailHead + t2) % TRAIL_LEN];
      const age = t2 / TRAIL_LEN;
      _dummy.position.copy(src);
      _dummy.scale.setScalar(0.35 + (1 - age) * 0.85);
      _dummy.rotation.set(0, 0, 0);
      _dummy.updateMatrix();
      packetTrail.setMatrixAt(t2, _dummy.matrix);
      _col.setRGB(0.42 + (1 - age) * 0.5, 0.66 + (1 - age) * 0.32, 1);
      packetTrail.setColorAt(t2, _col);
    }
    packetTrail.instanceMatrix.needsUpdate = true;
    if (packetTrail.instanceColor) packetTrail.instanceColor.needsUpdate = true;
  }

  // ── Score wave ──
  if (run.scoreWave > 0 && run.scoreWave < 1) {
    scoreWave.visible = true;
    const wr = lerp(1.2, 6.6, run.scoreWave);
    scoreWave.scale.set(wr, wr, wr);
    (scoreWave.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - run.scoreWave);
    scoreWave.rotation.z += dt * 0.6;
  } else {
    scoreWave.visible = false;
  }

  // ── Select ring ──
  if (run.selectWave > 0 && run.selectWave < 1 && winnerIdx >= 0 && winnerIdx < nodes.length) {
    selectRing.visible = true;
    selectRing.position.copy(nodes[winnerIdx].position);
    const sr = lerp(3.6, 0.95, run.selectWave);
    selectRing.scale.set(sr, sr, sr);
    (selectRing.material as THREE.MeshBasicMaterial).color.setHex(tierColor);
    (selectRing.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - run.selectWave);
  } else {
    selectRing.visible = false;
  }

  // ── Gate ring pulse ──
  for (let gi = 0; gi < gates.length; gi++) {
    const active = (gi === 0 ? run.pIngest : run.pReturn);
    const pulse = 1 + active * 0.25 + Math.sin(clock * 2.2 + gi) * 0.03;
    gateRings[gi].scale.set(pulse, pulse, pulse);
    (gateRings[gi].material as THREE.MeshBasicMaterial).opacity = 0.4 + active * 0.5;
    const gateGlow = gates[gi].userData.glow as THREE.Sprite | undefined;
    if (gateGlow) {
      gateGlow.material.opacity = 0.28 + active * 0.5;
    }
  }

  // ── Dashed logical connections ──
  // prompt→hub brightens during ingest; candidate→knowledge brightens during execute/return.
  const ingestFlowV = run.edgeFlow[0] ?? 0;
  const execFlowV = run.pExec > 0 ? run.execIntensity : 0;
  for (let d = 0; d < dashedEdges.length; d++) {
    const de = dashedEdges[d];
    let op: number;
    if (de.isPrompt) {
      op = 0.20 + ingestFlowV * 0.72 + (isRouting ? 0.06 : 0);
    } else {
      // de-1 .. de-6 correspond to candidate index 0..5
      const candIdx = d - 1;
      const isWinEdge = candIdx === winnerIdx;
      let f = run.edgeFlow[candIdx + 1 + candidateCount] ?? 0; // execute edges start at index (1 + candidateCount)
      op = 0.14 + f * 0.55 + execFlowV * 0.22;
      if (isWinEdge) op += 0.18 * (run.pSelect + run.pReturn) * 0.6;
    }
    (de.material as THREE.LineDashedMaterial).opacity = clamp(op, 0.10, 0.95);
  }

  // ── Stars slow rotation ──
  stars.rotation.y += dt * 0.006;
}
