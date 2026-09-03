// 配置持久化: 序列化 / 解析 / URL 压缩
// 持有配置 (礼装、从者、锁定、灵衣反选、设置) 可存 localStorage 或编码进 URL 分享
// 注: v1 未发布, 不兼容旧配置; 有 schema 变化直接升 v

export interface PersistedConfig {
  v: 2;
  settings: {
    costLimit: number;
    ownSlots: number;
    /** 最多装备的礼装数 (卡 cost 时可减少, 让更多高星从者上阵) */
    maxCes: number;
    includeSupport: boolean;
    supportMode: string;
    /** 冠位助战礼装 (第二助战位): none/auto/礼装key */
    supportMode2: string;
    autoPickFree: boolean;
    /** 改动后是否自动计算 (false=手动点「计算队伍」) */
    autoCalc: boolean;
    /** 深度搜索: 多起点收敛逃逸局部最优 (多职介池更优但更慢; false=单起点快速模式) */
    deepSearch: boolean;
    /** 礼装列表默认只看 5★ 加成礼装 */
    ceOnly5: boolean;
    /** 记住筛选选择 (刷新后恢复); 空数组 = 不限制 */
    classFilter: string[];
    traitFilter: string[];
    rarityFilter: number[];
  };
  /** [礼装id, 是否满破]; 每张礼装至多 1 张 */
  ownedCes: Array<[string, boolean]>;
  /** 从者默认全不选, 只存较小的一侧 (持有 / 未持有) */
  svMode: "owned" | "unowned";
  svList: string[];
  locked: string[];
  /** 显式反选的灵衣从者 (国服未实装灵衣等); 有灵衣者默认勾上, 此列表内的除外 */
  costumesOff: string[];
  /** 手动锁定的战斗形象: [从者title, 形态key]; 缺省(不在此列表)=自动搜索所有形态 */
  formSel?: Array<[string, string]>;
}

export interface ConfigInput {
  settings: PersistedConfig["settings"];
  ownedCes: Map<string, boolean>;
  ownedSv: Set<string>;
  allTitles: Set<string>;
  locked: string[];
  costumeOffTitles: string[];
  formSel?: Map<string, string>;
}

export function buildConfig(input: ConfigInput): PersistedConfig {
  const ownedCes = [...input.ownedCes.entries()].map(
    ([id, mlb]) => [id, mlb] as [string, boolean],
  );
  const unowned = [...input.allTitles].filter((t) => !input.ownedSv.has(t));
  const svMode: "owned" | "unowned" =
    input.ownedSv.size <= unowned.length ? "owned" : "unowned";
  const svList = svMode === "owned" ? [...input.ownedSv] : unowned;
  return {
    v: 2,
    settings: { ...input.settings },
    ownedCes,
    svMode,
    svList,
    locked: [...input.locked],
    costumesOff: [...input.costumeOffTitles],
    formSel: [...(input.formSel ?? new Map()).entries()],
  };
}

export interface ParsedConfig {
  settings: PersistedConfig["settings"];
  ownedCeIds: Map<string, boolean>;
  ownedSv: Set<string>;
  locked: string[];
  costumesOff: string[];
  formSel: Map<string, string>;
}

/** 解析并校验配置; 对当前数据中不存在的礼装/从者做容错 */
export function parseConfig(
  json: string,
  availableCeIds: Set<string>,
  allTitles: Set<string>,
): ParsedConfig | null {
  try {
    const raw = JSON.parse(json) as PersistedConfig;
    if (!raw || raw.v !== 2) return null;

    const settings = {
      costLimit: clampInt(raw.settings?.costLimit, 1, 999, 116),
      ownSlots: clampInt(raw.settings?.ownSlots, 1, 5, 5),
      maxCes: clampInt(raw.settings?.maxCes, 0, 6, 5),
      includeSupport: raw.settings?.includeSupport !== false,
      supportMode: typeof raw.settings?.supportMode === "string" ? raw.settings.supportMode : "auto",
      supportMode2: typeof raw.settings?.supportMode2 === "string" ? raw.settings.supportMode2 : "none",
      autoPickFree: raw.settings?.autoPickFree !== false,
      autoCalc: raw.settings?.autoCalc === true,
      deepSearch: raw.settings?.deepSearch !== false,
      ceOnly5: raw.settings?.ceOnly5 !== false,
      classFilter: Array.isArray(raw.settings?.classFilter)
        ? raw.settings.classFilter.filter((x) => typeof x === "string")
        : [],
      traitFilter: Array.isArray(raw.settings?.traitFilter)
        ? raw.settings.traitFilter.filter((x) => typeof x === "string")
        : [],
      rarityFilter: Array.isArray(raw.settings?.rarityFilter)
        ? raw.settings.rarityFilter
            .map(Number)
            .filter((x) => Number.isFinite(x) && [1, 2, 3, 4, 5].includes(x))
        : [1, 2, 3, 4, 5],
    };

    const ownedCeIds = new Map<string, boolean>();
    for (const [id, mlb] of Array.isArray(raw.ownedCes) ? raw.ownedCes : []) {
      if (availableCeIds.has(id)) ownedCeIds.set(id, mlb === true);
    }

    const list = (Array.isArray(raw.svList) ? raw.svList : []).filter((t) => allTitles.has(t));
    const ownedSv =
      raw.svMode === "unowned"
        ? new Set([...allTitles].filter((t) => !new Set(list).has(t)))
        : new Set(list);

    const locked = (Array.isArray(raw.locked) ? raw.locked : [])
      .filter((t) => allTitles.has(t))
      .slice(0, 6);
    const costumesOff = (Array.isArray(raw.costumesOff) ? raw.costumesOff : []).filter((t) =>
      allTitles.has(t),
    );
    const formSel = new Map<string, string>();
    for (const [t, k] of Array.isArray(raw.formSel) ? raw.formSel : []) {
      if (allTitles.has(t) && typeof k === "string") formSel.set(t, k);
    }
    // 锁定意味着已持有
    for (const t of locked) ownedSv.add(t);

    return { settings, ownedCeIds, ownedSv, locked, costumesOff, formSel };
  } catch {
    return null;
  }
}

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ---------------------------------------------------------------------------
// URL 压缩: UTF-8 -> base64url (无 = 填充, 无 +/ 字符, 可直接放 query)
// ---------------------------------------------------------------------------

export function encodeConfig(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeConfig(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
