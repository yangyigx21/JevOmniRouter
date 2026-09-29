/**
 * @module key-security
 * @implements T-7.2
 *
 * 密钥安全模块 —— 落实约束 C3：
 * "密钥 SHALL 仅存服务端，前端 SHALL NOT 接收供应商密钥"
 *
 * 本模块提供：
 * - 服务端密钥保险库（KeyVault）：带租户隔离的加密存储
 * - 响应脱敏（scrubResponse）：移除响应中密钥类字段
 * - 泄漏检测（KeyLeakDetector）：扫描对象中疑似密钥值
 * - 前端载荷断言（assertNoKeyInFrontendPayload）：发送至前端前的最后一道防线
 */

// ---------------------------------------------------------------------------
// ProviderKey
// ---------------------------------------------------------------------------

/**
 * 密钥记录。
 *
 * 实际密钥以加密形式存储于 `encryptedKey`（本实现使用 base64 编码模拟加密）。
 * @see C3 — 密钥仅存服务端
 */
export interface ProviderKey {
  providerName: string;
  keyId: string;
  encryptedKey: string;
  tenantId: string;
  createdAt: string;
  rotatedAt?: string;
}

// ---------------------------------------------------------------------------
// KeyLeakReport
// ---------------------------------------------------------------------------

/** 密钥泄漏扫描报告 */
export interface KeyLeakReport {
  hasLeak: boolean;
  leakPaths: string[];
  scannedPaths: number;
}

// ---------------------------------------------------------------------------
// XOR-based encryption helpers (simulation — 非生产级加密)
// ---------------------------------------------------------------------------

const XOR_CIPHER_SECRET = "JevRouter-C3-KeyVault-XOR";

/**
 * 使用简单 XOR 对明文进行"加密"并返回 base64。
 * 仅用于演示加密存储模式，不提供真实安全性。
 */
function xorEncrypt(plaintext: string): string {
  const secret = XOR_CIPHER_SECRET;
  const bytes: number[] = [];
  for (let i = 0; i < plaintext.length; i++) {
    bytes.push(plaintext.charCodeAt(i) ^ secret.charCodeAt(i % secret.length));
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * 将 XOR 加密后的 base64 密文解密为明文。
 */
function xorDecrypt(cipherBase64: string): string {
  const secret = XOR_CIPHER_SECRET;
  const bytes = Buffer.from(cipherBase64, "base64");
  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += String.fromCharCode(bytes[i] ^ secret.charCodeAt(i % secret.length));
  }
  return result;
}

// ---------------------------------------------------------------------------
// KeyVault
// ---------------------------------------------------------------------------

/**
 * 服务端密钥保险库。
 *
 * - 密钥以加密形式存储（XOR 模拟），按租户隔离
 * - 外部接口永不返回原始密钥
 * @see C3 — 密钥 SHALL 仅存服务端
 */
export class KeyVault {
  private store = new Map<string, ProviderKey>();

  // ── helpers ──────────────────────────────────────────────────────────

  /** 生成唯一 keyId */
  private generateKeyId(): string {
    return `key_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /** 租户作用域的复合键 */
  private compositeKey(tenantId: string, keyId: string): string {
    return `${tenantId}::${keyId}`;
  }

  // ── public API ───────────────────────────────────────────────────────

  /**
   * 存储供应商 API 密钥。
   *
   * 密钥在落盘前必须加密（C3）。
   * @returns keyId — 后续引用该密钥的唯一标识
   */
  storeKey(tenantId: string, providerName: string, apiKey: string): string {
    const keyId = this.generateKeyId();
    const encryptedKey = xorEncrypt(apiKey);
    const record: ProviderKey = {
      providerName,
      keyId,
      encryptedKey,
      tenantId,
      createdAt: new Date().toISOString(),
    };
    this.store.set(this.compositeKey(tenantId, keyId), record);
    return keyId;
  }

  /**
   * 解密并返回密钥。
   *
   * 仅在同一租户范围内可用；租户不匹配时返回 null。
   * @see C3 — 前端 SHALL NOT 接收供应商密钥，此方法仅限服务端内部调用
   */
  retrieveKey(tenantId: string, keyId: string): string | null {
    const record = this.store.get(this.compositeKey(tenantId, keyId));
    if (!record) {
      return null;
    }
    return xorDecrypt(record.encryptedKey);
  }

  /**
   * 轮转密钥。
   *
   * 旧 keyId 立即失效，新 keyId 指向加密后的新密钥。
   * @returns 新的 keyId
   */
  rotateKey(tenantId: string, keyId: string, newApiKey: string): string {
    const existing = this.store.get(this.compositeKey(tenantId, keyId));
    if (!existing) {
      throw new Error(`Key not found or tenant mismatch: ${keyId}`);
    }
    // 使旧记录失效
    this.store.delete(this.compositeKey(tenantId, keyId));

    // 创建新记录
    const newKeyId = this.generateKeyId();
    const encryptedKey = xorEncrypt(newApiKey);
    const record: ProviderKey = {
      providerName: existing.providerName,
      keyId: newKeyId,
      encryptedKey,
      tenantId,
      createdAt: existing.createdAt,
      rotatedAt: new Date().toISOString(),
    };
    this.store.set(this.compositeKey(tenantId, newKeyId), record);
    return newKeyId;
  }

  /**
   * 列出密钥元数据。
   *
   * **绝不**返回实际密钥或加密密钥（C3）。
   */
  listKeyIds(tenantId: string): Array<{ keyId: string; providerName: string; createdAt: string }> {
    const result: Array<{ keyId: string; providerName: string; createdAt: string }> = [];
    for (const record of this.store.values()) {
      if (record.tenantId === tenantId) {
        result.push({
          keyId: record.keyId,
          providerName: record.providerName,
          createdAt: record.createdAt,
        });
      }
    }
    return result;
  }

  /**
   * 删除密钥。
   *
   * 仅当密钥存在且归属该租户时才执行删除。
   * @returns 是否成功删除
   */
  deleteKey(tenantId: string, keyId: string): boolean {
    const ck = this.compositeKey(tenantId, keyId);
    if (this.store.has(ck)) {
      this.store.delete(ck);
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// scrubResponse
// ---------------------------------------------------------------------------

/** 需要从响应中脱敏的字段名模式（C3） */
const KEY_FIELD_PATTERNS = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /auth.*header/i,
  /api.*key/i,
];

/**
 * 深拷贝并脱敏对象，移除密钥类字段。
 *
 * 任何字段名匹配 /key/i、/secret/i、/token/i、/password/i、
 * /auth.*header/i、/api.*key/i 的值将被替换为 `'[REDACTED]'`。
 *
 * @see C3 — 前端 SHALL NOT 接收供应商密钥
 */
export function scrubResponse<T>(data: T): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== "object") {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map((item) => scrubResponse(item)) as unknown as T;
  }

  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(data as Record<string, unknown>)) {
    const shouldRedact = KEY_FIELD_PATTERNS.some((pattern) => pattern.test(key));
    if (shouldRedact) {
      clone[key] = "[REDACTED]";
    } else {
      const value = (data as Record<string, unknown>)[key];
      clone[key] = scrubResponse(value);
    }
  }
  return clone as T;
}

// ---------------------------------------------------------------------------
// KeyLeakDetector
// ---------------------------------------------------------------------------

/** 常见 API 密钥前缀模式 */
const API_KEY_VALUE_PATTERNS = [
  /^sk[_-]/i,        // OpenAI 等: sk-..., sk_...
  /^key[_-]/i,       // key-..., key_...
  /^pk_[a-z]+_/i,    // Stripe 可发布键: pk_live_..., pk_test_...
  /^rk_[a-z]+_/i,    // Stripe 受限键
  /^AKIA/i,          // AWS Access Key ID
  /^[A-Za-z0-9]{40}$/, // 40 字符 base64-ish 密钥
];

/**
 * 密钥泄漏检测器。
 *
 * 递归扫描任意对象，发现疑似 API 密钥的值并报告泄漏路径。
 * @see C3 — 前端 SHALL NOT 接收供应商密钥
 */
export class KeyLeakDetector {
  /**
   * 扫描对象中疑似 API 密钥值。
   *
   * @param obj   待扫描对象
   * @returns     泄漏报告
   */
  scan(obj: unknown): KeyLeakReport {
    const leakPaths: string[] = [];
    let scannedPaths = 0;

    const visit = (value: unknown, path: string): void => {
      scannedPaths++;

      if (typeof value === "string" && value.length > 0) {
        const isLeak = API_KEY_VALUE_PATTERNS.some((p) => p.test(value));
        if (isLeak) {
          leakPaths.push(path);
        }
        return;
      }

      if (value !== null && typeof value === "object") {
        if (Array.isArray(value)) {
          value.forEach((item, idx) => visit(item, `${path}[${idx}]`));
        } else {
          for (const key of Object.keys(value as Record<string, unknown>)) {
            visit((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
          }
        }
      }
    };

    visit(obj, "");
    return {
      hasLeak: leakPaths.length > 0,
      leakPaths,
      scannedPaths,
    };
  }
}

// ---------------------------------------------------------------------------
// assertNoKeyInFrontendPayload
// ---------------------------------------------------------------------------

/** 字段名模式：需在前端载荷中禁止的密钥类字段 */
const FRONTEND_FORBIDDEN_FIELD_PATTERNS = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /auth.*header/i,
  /api.*key/i,
];

/**
 * 前端载荷断言：确保载荷中不包含任何密钥类字段或疑似密钥值。
 *
 * 在将数据发送至前端之前调用此函数作为最后一道防线。
 * 若检测到密钥泄漏，抛出 Error 并说明泄漏路径。
 *
 * @see C3 — 前端 SHALL NOT 接收供应商密钥
 * @throws Error 当载荷包含密钥类字段或疑似密钥值
 */
export function assertNoKeyInFrontendPayload(payload: unknown): void {
  // 1. 检查密钥类字段名
  const fieldViolations: string[] = [];

  const checkFields = (value: unknown, parentPath: string): void => {
    if (value === null || value === undefined || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, idx) => checkFields(item, `${parentPath}[${idx}]`));
      return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const fullPath = parentPath ? `${parentPath}.${key}` : key;
      const isForbidden = FRONTEND_FORBIDDEN_FIELD_PATTERNS.some((p) => p.test(key));
      if (isForbidden) {
        fieldViolations.push(fullPath);
      }
      checkFields((value as Record<string, unknown>)[key], fullPath);
    }
  };

  checkFields(payload, "");

  // 2. 检查疑似密钥值
  const detector = new KeyLeakDetector();
  const leakReport = detector.scan(payload);

  // 3. 汇总违规
  const allViolations = [
    ...fieldViolations.map((p) => `forbidden field: ${p}`),
    ...leakReport.leakPaths.map((p) => `key-like value at: ${p}`),
  ];

  if (allViolations.length > 0) {
    throw new Error(
      `[C3 Violation] Payload contains key material that MUST NOT be sent to frontend:\n` +
        allViolations.map((v) => `  - ${v}`).join("\n"),
    );
  }
}
