<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Store } from '../store/createStore.js';
import type { RouteState } from '../store/routeEventReducer.js';
import { withVendorColors } from '../store/routeEventReducer.js';
import { buildTreeScene, computeCameraFit, computeSceneBounds, fitFogToDistance, CAM_FAR, CAM_FOV, CAM_NEAR, renderFrame, toPlanetDefs, type PlanetDef, type TreeSceneObjects } from '../three/TreeScene.js';
import { AnimationController } from '../three/AnimationController.js';
import { TOTAL_DUR, STAGES } from '../three/computeRunFrontend.js';
import { fetchVendorGroups } from '../api/client.js';
import * as THREE from 'three';

const props = defineProps<{
  store: Store<RouteState, any>;
}>();

/**
 * 相机取景。
 *
 * 星球数量由 LLM 模型服务动态下发，场景宽度/高度随之变化，因此不再使用
 * 固定坐标 —— 每次按 `computeSceneBounds()` 的包围盒 + `computeCameraFit()`
 * 推算相机位置与距离，保证「Prompt输入 → Jev中枢 → 星球 → 决策库」完整可见，
 * 且不被浮在画布上的上下 HUD 遮挡。
 */
/**
 * 取景中心的横向让位量。
 *
 * 注意符号语义：相机 lookAt 的 x 变大 → 画面内容相对向左移动。
 * 取正值即为用户要求的「整体向左平移」，把右侧余量让给「决策库」。
 */
const FRAME_SHIFT_X = 0.6;

const canvasRef = ref<HTMLCanvasElement>();
const labelsRef = ref<HTMLDivElement>();

const anim = new AnimationController({
  reducedMotion: AnimationController.checkReducedMotion(),
});

let renderer: THREE.WebGLRenderer | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let sceneObjs: TreeSceneObjects | null = null;

const stageLine = computed(() => {
  const s = props.store.state;
  if (s.stage === 'idle') return '系统就绪 · 等待 prompt 输入';
  if (s.stage === 'ingest') return 'Stage 1 · 输入解析中…';
  if (s.stage === 'state') return 'Stage 1 · 状态组装 + 知识检索…';
  if (s.stage === 'analyze') return 'Stage 2 · Jev 策略决策中…';
  if (s.stage === 'jev') return 'Stage 2 · Jev 类型化问答中…';
  if (s.stage === 'probability') return `Stage 2 · 置信度校准 · ${s.confidence ?? '--'}`;
  if (s.stage === 'score') return 'Stage 2 · 候选模型评估中…';
  if (s.stage === 'constraint') return 'Stage 2 · 约束筛选…';
  if (s.stage === 'select') return `Stage 2 · 路由决策 · ${s.winnerModelId ?? '--'}`;
  if (s.stage === 'route') return `Stage 3 · 模型执行 · ${s.winnerModelId ?? '--'}`;
  if (s.stage === 'execute') return `Stage 3 · 模型推理执行中 · ${s.winnerModelId ?? '--'}`;
  if (s.stage === 'return') return 'Stage 4 · 结果回流汇聚…';
  if (s.stage === 'experience') return 'Stage 4 · 经验沉淀完成';
  return s.stage;
});

const animTime = ref(0);
const animProgress = computed(() => Math.min(animTime.value / TOTAL_DUR, 1));
const animStageName = ref('');
const isPlaying = ref(false);

/** 星球（厂商）节点 —— 来自 LLM 模型服务，驱动 3D 候选节点。 */
const vendorGroups = computed(() => props.store.state.vendorGroups);
const planets = computed<PlanetDef[]>(() => toPlanetDefs(vendorGroups.value));

const winnerIdx = computed(() => {
  const wid = props.store.state.winnerModelId;
  if (!wid) return 0;
  const idx = vendorGroups.value.findIndex((g) => g.modelIds.includes(wid));
  return idx >= 0 ? idx : 0;
});

const modelProbs = computed(() => {
  const groups = vendorGroups.value;
  const n = groups.length;
  if (n === 0) return [];
  // Prefer the real calibrated scores carried by JEV_DECISION_READY
  const scores = props.store.state.modelScores;
  if (scores.length > 0) {
    const byId = new Map(scores.map((s) => [s.name, s.score]));
    // 星球得分 = 所辖模型得分之和
    return groups.map((g) => g.modelIds.reduce((acc, id) => acc + (byId.get(id) ?? 0), 0));
  }
  // Fallback: derive a rough distribution from the winner + confidence
  if (!props.store.state.confidence) return Array(n).fill(1 / n);
  const wi = winnerIdx.value;
  const probs = Array(n).fill(0.05);
  probs[wi] = props.store.state.confidence ?? 0;
  const rest = (1 - probs[wi]) / (n - 1);
  for (let i = 0; i < n; i++) {
    if (i !== wi) probs[i] = rest;
  }
  return probs;
});

/**
 * 测量画布上下被 HUD 覆盖的像素带。
 *
 * `#gl` 是满高画布，但 `.hud-tl`（标题/流程条/状态行）、`.hud-bottom`（步骤条 +
 * 控制条）、`.hint`（操作提示）都是浮在画布上的 overlay。星球数量变多时纵向由
 * 高度主导取景，不扣掉这两条带子，最上/最下的星球就会被压住。
 */
function hudInsets(canvas: HTMLCanvasElement): { topInset: number; bottomInset: number } {
  const stage = canvas.parentElement;
  const canvasRect = canvas.getBoundingClientRect();
  const box = (sel: string): DOMRect | null =>
    stage?.querySelector(sel)?.getBoundingClientRect() ?? null;

  const top = box('.hud-tl');
  const bottomBar = box('.hud-bottom');
  const hint = box('.hint');

  return {
    topInset: top ? Math.max(0, top.bottom - canvasRect.top) : 0,
    bottomInset: Math.max(
      bottomBar ? canvasRect.bottom - bottomBar.top : 0,
      hint ? canvasRect.bottom - hint.top : 0,
    ),
  };
}

/** 依据当前包围盒 + 视口净空，重新摆位相机。 */
function fitCamera(): void {
  const canvas = canvasRef.value;
  if (!camera || !canvas) return;

  const fit = computeCameraFit(computeSceneBounds(planets.value), {
    width: canvas.clientWidth || 1,
    height: canvas.clientHeight || 1,
    ...hudInsets(canvas),
  });

  const cx = fit.centerX + FRAME_SHIFT_X;
  camera.position.set(cx, fit.centerY, fit.distance);
  camera.lookAt(cx, fit.centerY, 0);
  camera.updateProjectionMatrix();

  if (sceneObjs) fitFogToDistance(sceneObjs, fit.distance);
}

function resize() {
  const canvas = canvasRef.value;
  if (!canvas || !renderer || !camera) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  fitCamera();
}

function updateLabels() {
  // Labels are now rendered as canvas textures inside 3D nodes (TreeScene.ts)
  // No HTML overlay labels needed
}

function formatTime(ms: number): string {
  const s = ms / 1000;
  return s.toFixed(2) + 's';
}

watch(() => props.store.state.stage, () => {
  updateLabels();
});

watch(() => props.store.state.winnerModelId, () => {
  updateLabels();
});

watch(() => props.store.state.routeTier, () => {
  updateLabels();
});

/** 释放旧场景的 GPU 资源。厂商数量变化会整场重建，纹理必须一并释放。 */
function disposeScene(objs: TreeSceneObjects | null): void {
  if (!objs) return;
  objs.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const list = Array.isArray(mat) ? mat : mat ? [mat] : [];
    for (const m of list) {
      // 标签/光晕是 SpriteMaterial，贴图挂在 map 上，dispose 材质不会级联。
      (m as THREE.SpriteMaterial).map?.dispose();
      m.dispose();
    }
  });
}

onMounted(async () => {
  const canvas = canvasRef.value;
  if (!canvas) return;

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  // 至少按 2x 超采样：低 DPI 屏（devicePixelRatio=1）下 1:1 渲染会让球体、
  // 连线和文字贴图都发虚，抬高下限后边缘明显锐利；高 DPI 屏取实际比率，封顶 3x。
  renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio, 2), 3));

  camera = new THREE.PerspectiveCamera(CAM_FOV, 1, CAM_NEAR, CAM_FAR);

  sceneObjs = buildTreeScene(planets.value);
  resize();
  window.addEventListener('resize', resize);

  // Animation loop
  anim.onFrame((result: any, elapsed: number) => {
    animTime.value = elapsed;
    animStageName.value = result.stageName;

    if (sceneObjs && renderer && camera) {
      renderFrame(sceneObjs, elapsed, props.store.state, winnerIdx.value, modelProbs.value, true);
      renderer.render(sceneObjs.scene, camera);
    }
  });

  updateLabels();

  // Idle render — keeps the frame in sync with store state (e.g. after RESET_ROUTE)
  function idleRender() {
    if (!anim.isRunning() && renderer && camera && sceneObjs) {
      renderFrame(sceneObjs, animTime.value, props.store.state, winnerIdx.value, modelProbs.value, false);
      renderer.render(sceneObjs.scene, camera);
    }
    requestAnimationFrame(idleRender);
  }
  idleRender();

  // 从 LLM 模型服务读取厂商清单，动态生成星球节点；失败则保留离线兜底。
  try {
    const { vendors } = await fetchVendorGroups();
    if (vendors.length > 0) {
      props.store.dispatch({ type: 'SET_VENDOR_GROUPS', groups: withVendorColors(vendors) });
    }
  } catch {
    /* 后端不可达：沿用 fallbackVendorGroups */
  }
});

/** 厂商清单变化时重建 3D 场景（星球数量/顺序随模型服务变化）。 */
watch(planets, (next) => {
  if (!renderer || !camera) return;
  const prev = sceneObjs;
  sceneObjs = buildTreeScene(next);
  disposeScene(prev);
  // 场景尺寸变了，必须重新取景，否则两端节点会出画。
  fitCamera();
  renderFrame(sceneObjs, animTime.value, props.store.state, winnerIdx.value, modelProbs.value, false);
  renderer.render(sceneObjs.scene, camera);
});

onUnmounted(() => {
  anim.stop();
  window.removeEventListener('resize', resize);
  disposeScene(sceneObjs);
  renderer?.dispose();
});

function buildAnimCtx() {
  return {
    winnerIdx: winnerIdx.value,
    nodeCount: vendorGroups.value.length + 3, // prompt + jev-hub + knowledge (end node)
    probs: modelProbs.value,
    confidence: props.store.state.confidence ?? 0,
    tier: props.store.state.routeTier ?? 'ROUTE',
  };
}

/**
 * Start (or restart) the routing animation.
 * @param speed playback multiplier — the caller uses it to align the animation
 *              timeline with the incoming event stream.
 */
function submitAndAnimate(speed = 1) {
  anim.setSpeed(speed);
  if (anim.isRunning()) {
    anim.reroute(buildAnimCtx());
  } else {
    anim.startRun(buildAnimCtx());
  }
  isPlaying.value = true;
}

function togglePause() {
  anim.togglePause();
  isPlaying.value = !anim.isPaused();
}

function setSpeed(sp: number) {
  anim.setSpeed(sp);
}

/** Stop the animation and return the timeline to the start (used by demo reset). */
function resetAnimation() {
  anim.stop();
  animTime.value = 0;
  animStageName.value = '';
  isPlaying.value = false;
}

function replayAnim() {
  anim.replay();
  isPlaying.value = true;
}

function resetView() {
  fitCamera();
}

// Expose for parent
defineExpose({ submitAndAnimate, resetAnimation });
</script>

<template>
  <section id="stage" aria-label="Jev 智能路由 3D 可视化">
    <canvas ref="canvasRef" id="gl" role="img" aria-label="路由决策三维可视化" tabindex="0"></canvas>
    <div ref="labelsRef" id="labels"></div>

    <div class="hud hud-tl" aria-live="polite" aria-atomic="true">
      <div class="brand">
        <div class="logo">Jev</div>
        <h1>基于Jev多模型智能路由中枢<small>TYPESAFE Jev · TYPED QUESTIONS → CALIBRATED CONFIDENCE</small></h1>
      </div>
      <div class="flowbar" role="progressbar" aria-label="3D 场景进度" :aria-valuenow="Math.round(animProgress * 100)" aria-valuemin="0" aria-valuemax="100">
        <span class="fb-node fb-in">Prompt输入</span>
        <span class="fb-arrow" aria-hidden="true">→</span>
        <span class="fb-node fb-hub">Jev中枢</span>
        <span class="fb-arrow" aria-hidden="true">→</span>
        <span class="fb-node fb-out">模型执行</span>
        <span class="fb-arrow" aria-hidden="true">→</span>
        <span class="fb-node fb-save">决策库</span>
      </div>
      <div class="stage-line">
        <span class="pulse"></span>
        <span>{{ stageLine }}</span>
      </div>
    </div>

    <div class="hud hud-bl">
      <div class="card-mini">
        <div class="mini-t">节点状态图例</div>
        <div class="legend">
          <span><i style="background:#22d39a"></i>空闲 · 可立即接入</span>
          <span><i style="background:#ffb547"></i>处理中 · 队列占用</span>
          <span><i style="background:#ff5f6d"></i>负载过高 · 已降权</span>
          <span><i style="background:#4ea1ff"></i>本轮选中 · 高亮</span>
        </div>
      </div>
      <div class="card-mini">
        <div class="mini-t">置信度路由阈值</div>
        <div class="legend">
          <span><i style="background:#22d39a"></i>≥ 0.82 高置信 · 直接路由</span>
          <span><i style="background:#ffb547"></i>≥ 0.60 中置信 · 标记观察</span>
          <span><i style="background:#ff5f6d"></i>&lt; 0.60 低置信 · 转兜底模型</span>
        </div>
      </div>
    </div>

    <div class="hint">拖动旋转 · 滚轮缩放 · Shift+拖动平移 · 悬停节点查看详情 · <kbd>?</kbd> 快捷键</div>

    <div class="hud hud-bottom">
      <div class="steps">
        <div v-for="(st, i) in STAGES" :key="st.id" class="step" :class="{ act: animStageName === st.name, done: animProgress > (i + 1) / STAGES.length }">
          <div class="sb"><i :style="{ width: `${Math.min(animProgress * STAGES.length / (i + 1), 1) * 100}%` }"></i></div>
          <div class="st">{{ st.short }}</div>
        </div>
      </div>
      <div class="transport">
        <button class="tbtn" :title="isPlaying ? '暂停' : '播放'" @click="togglePause">{{ isPlaying ? '暂停' : '播放' }}</button>
        <button class="tbtn" title="重放 (R)" @click="replayAnim">重放</button>
        <div class="tsep"></div>
        <button class="tbtn" @click="setSpeed(0.5)">0.5×</button>
        <button class="tbtn act" @click="setSpeed(1)">1×</button>
        <button class="tbtn" @click="setSpeed(2)">2×</button>
        <div class="tsep"></div>
        <div class="prog"><i :style="{ width: `${animProgress * 100}%` }"></i></div>
        <span class="tinfo">{{ formatTime(animTime) }} / {{ formatTime(TOTAL_DUR) }}</span>
        <div class="tsep"></div>
        <button class="tbtn" title="重置视角 (H)" @click="resetView">重置视角</button>
      </div>
    </div>

    <div id="hoverCard"></div>
    <div id="toast"></div>
  </section>
</template>
