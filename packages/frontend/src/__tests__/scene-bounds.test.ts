/**
 * 场景包围盒 / 相机取景测试。
 *
 * 回归缺陷：相机取景曾是硬编码 `x = -0.78`，而场景实际横跨
 * `x ∈ [-7.4, 9.0]`（中心 0.8），导致「决策库」节点被裁出画面右侧。
 * 星球数量改为由 LLM 模型服务动态下发后，取景必须由几何推导。
 *
 * 第二个回归：画布满高，但上下 HUD 是浮在画布上的 overlay。只按整幅画布取景时，
 * 星球数变多（纵向由高度主导）后，最上/最下的星球会被标题条/控制条压住。
 */
import { describe, it, expect } from 'vitest';
import {
  CAM_FAR,
  CAM_FOV,
  computeCameraFit,
  computeSceneBounds,
  type CameraFit,
  type PlanetDef,
  type SceneBounds,
  type ViewportSpec,
} from '../three/TreeScene.js';

function planets(n: number): PlanetDef[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `vendor:v${i}`,
    vendor: `v${i}`,
    label: `Vendor ${i}`,
    modelIds: [`m${i}`],
    modelCount: 1,
    color: 0x4ea1ff,
  }));
}

/** 与 StageView 的 FRAME_SHIFT_X 保持一致（取景中心右移 → 画面左移）。 */
const FRAME_SHIFT_X = 0.6;

/**
 * 舞台实测尺寸与 HUD 覆盖带。
 *
 * 1067×900 视口下：`.hud-tl` 高 94px（top:14）→ 覆盖 108px；
 * `.hud-bottom` 高 75px（bottom:14）→ 89px，`.hint` 高 16px（bottom:74）→ 90px，
 * 取二者较大值。
 */
const STAGE: ViewportSpec = {
  width: 1067,
  height: 900,
  topInset: 108,
  bottomInset: 90,
};

/** 把世界包围盒投影到画布像素坐标（y 向下为正）。 */
function project(b: SceneBounds, fit: CameraFit, view: ViewportSpec) {
  const halfFovTan = Math.tan((CAM_FOV * Math.PI) / 360);
  const wpp = (2 * fit.distance * halfFovTan) / view.height;
  const cx = fit.centerX + FRAME_SHIFT_X;
  return {
    top: view.height / 2 - (b.maxY - fit.centerY) / wpp,
    bottom: view.height / 2 - (b.minY - fit.centerY) / wpp,
    left: view.width / 2 + (b.minX - cx) / wpp,
    right: view.width / 2 + (b.maxX - cx) / wpp,
  };
}

describe('computeSceneBounds', () => {
  it('6 星球时横向中心落在场景几何中心附近（非 -0.78）', () => {
    const b = computeSceneBounds(planets(6));
    // 几何跨度 GATE_IN(-7.4) ~ KNOWLEDGE(9.0)，中心 = 0.8
    expect(b.centerX).toBeCloseTo(0.8, 5);
    expect(b.minX).toBeLessThan(-7.4);
    expect(b.maxX).toBeGreaterThan(9.0);
  });

  it('横向跨度覆盖 Prompt输入 到 决策库', () => {
    const b = computeSceneBounds(planets(5));
    expect(b.minX).toBeLessThanOrEqual(-7.4);
    expect(b.maxX).toBeGreaterThanOrEqual(9.0);
  });

  it('星球数增加时纵向跨度变大', () => {
    const few = computeSceneBounds(planets(2));
    const many = computeSceneBounds(planets(10));
    expect(many.height).toBeGreaterThan(few.height);
    expect(many.centerY).toBeCloseTo(few.centerY, 5); // leafY 关于中心对称
  });

  it('纵向范围对称覆盖最上/最下星球', () => {
    const b = computeSceneBounds(planets(6));
    // leafY(0) = +5.25, leafY(5) = -5.25
    expect(b.maxY).toBeGreaterThan(5.25);
    expect(b.minY).toBeLessThan(-5.25);
  });

  it('width/height 与 min/max 一致', () => {
    const b = computeSceneBounds(planets(4));
    expect(b.width).toBeCloseTo(b.maxX - b.minX, 10);
    expect(b.height).toBeCloseTo(b.maxY - b.minY, 10);
    expect(b.centerX).toBeCloseTo((b.minX + b.maxX) / 2, 10);
    expect(b.centerY).toBeCloseTo((b.minY + b.maxY) / 2, 10);
  });

  it('单星球（极端最小场景）不产生 NaN', () => {
    const b = computeSceneBounds(planets(1));
    expect(Number.isFinite(b.centerX)).toBe(true);
    expect(Number.isFinite(b.height)).toBe(true);
    expect(b.height).toBeGreaterThan(0);
  });
});

describe('computeCameraFit · 横向', () => {
  it('包围盒在两个方向都完整入画', () => {
    const view: ViewportSpec = { ...STAGE, topInset: 0, bottomInset: 0 };
    const b = computeSceneBounds(planets(6));
    const box = project(b, computeCameraFit(b, view), view);
    expect(box.left).toBeGreaterThan(0);
    expect(box.right).toBeLessThan(view.width);
    expect(box.top).toBeGreaterThan(0);
    expect(box.bottom).toBeLessThan(view.height);
  });

  it('窄视口（宽高比小）自动后退更远，保证横向完整', () => {
    const b = computeSceneBounds(planets(6));
    const narrow = computeCameraFit(b, { ...STAGE, width: 400, topInset: 0, bottomInset: 0 });
    const wide = computeCameraFit(b, { ...STAGE, width: 2000, topInset: 0, bottomInset: 0 });
    expect(narrow.distance).toBeGreaterThan(wide.distance);
  });

  it('横向余量：决策库一侧留出可见空白（内容整体左移）', () => {
    const view: ViewportSpec = { ...STAGE, topInset: 0, bottomInset: 0 };
    const b = computeSceneBounds(planets(5));
    const box = project(b, computeCameraFit(b, view), view);
    expect(view.width - box.right).toBeGreaterThan(0);
    // 画面内容中心落在画布中心左侧 → 整体向左平移
    const contentCenter = (box.left + box.right) / 2;
    expect(contentCenter).toBeLessThan(view.width / 2);
  });
});

describe('computeCameraFit · 上下 HUD 净空（星球数变多时的回归点）', () => {
  for (const n of [1, 5, 12, 20]) {
    it(`${n} 颗星球时包围盒完全落在净空带内`, () => {
      const b = computeSceneBounds(planets(n));
      const box = project(b, computeCameraFit(b, STAGE), STAGE);
      expect(box.top).toBeGreaterThanOrEqual(STAGE.topInset);
      expect(box.bottom).toBeLessThanOrEqual(STAGE.height - STAGE.bottomInset);
      expect(box.left).toBeGreaterThan(0);
      expect(box.right).toBeLessThan(STAGE.width);
    });
  }

  it('扣除 HUD 带后相机比「按整幅画布取景」退得更远', () => {
    const b = computeSceneBounds(planets(12));
    const withBand = computeCameraFit(b, STAGE);
    const withoutBand = computeCameraFit(b, { ...STAGE, topInset: 0, bottomInset: 0 });
    expect(withBand.distance).toBeGreaterThan(withoutBand.distance);
  });

  it('内容中心对齐净空带中心，而非画布中心', () => {
    const view: ViewportSpec = { ...STAGE, topInset: 120, bottomInset: 200 };
    const b = computeSceneBounds(planets(12));
    const fit = computeCameraFit(b, view);
    const box = project(b, fit, view);
    const freeCenter = view.topInset + (view.height - view.topInset - view.bottomInset) / 2;
    expect((box.top + box.bottom) / 2).toBeCloseTo(freeCenter, 5);
  });

  it('HUD 带异常高（超过半幅画布）时退化为半幅净空，不产生 NaN/Infinity', () => {
    const view: ViewportSpec = { ...STAGE, topInset: 800, bottomInset: 700 };
    const b = computeSceneBounds(planets(6));
    const fit = computeCameraFit(b, view);
    expect(Number.isFinite(fit.distance)).toBe(true);
    expect(Number.isFinite(fit.centerY)).toBe(true);
    expect(fit.distance).toBeGreaterThan(0);
  });

  it('零尺寸视口（首帧尚未布局）不抛异常', () => {
    const b = computeSceneBounds(planets(5));
    const fit = computeCameraFit(b, { width: 0, height: 0, topInset: 0, bottomInset: 0 });
    expect(Number.isNaN(fit.distance) || fit.distance > 0).toBe(true);
  });
});

describe('computeCameraFit · 远裁剪面', () => {
  it('星球数直到 100 颗都不会退到 CAM_FAR 之外', () => {
    const view: ViewportSpec = { ...STAGE, width: 400, topInset: 0, bottomInset: 0 };
    for (const n of [5, 20, 50, 100]) {
      const fit = computeCameraFit(computeSceneBounds(planets(n)), view);
      expect(fit.distance).toBeLessThan(CAM_FAR);
    }
  });
});
