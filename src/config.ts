// 配置持久化: 序列化 / 解析 / URL 压缩
// 持有配置 (礼装数量、从者、锁定、灵衣、设置) 可存 localStorage 或编码进 URL 分享

export interface PersistedConfig {
  v: 1;
  settings: {
    costLimit: number;
    ownSlots: number;
    includeSupport: boolean;
    supportRarity: number;
    supportMode: string;
    autoPickFree: boolean;
    /** 礼装列表默认只看 5★ 加成礼装 */
    ceOnly5: boolean;
    /** 记住筛选选择 (刷新后恢复); 空数组 = 不限制 */
    classFilter: string[];
    traitFilter: string[];
    rarityFilter: number[];
  };
  /** [礼装id, {数量, 满破数}] */
  ownedCes: Array<[string, { count: number; mlbCount: number }]>;
  /** 从者默认全持有, 因此只存较小的一侧 */
  svMode: "owned" | "unowned";
  svList: string[];
  locked: string[];
  /** 已解锁灵衣的从者 (持有灵衣之人) */
  costumes: string[];
  /** 显式反选的灵衣从者 (国服未实装灵衣等); 有灵衣者默认勾上, 此列表内的除外 */
  costumesOff: string[];
}

export interface ConfigInput {
  settings: PersistedConfig["settings"];
  ownedCes: Map<string, { count: number; mlbCount: number }>;
  ownedSv: Set<string>;
  allTitles: Set<string>;
  locked: string[];
  costumeTitles: string[];
  costumeOffTitles: string[];
}

export function buildConfig(input: ConfigInput): PersistedConfig {
  const ownedCes = [...input.ownedCes.entries()]
    .filter(([, v]) => v.count > 0)
    .map(
      ([id, v]) => [id, { count: v.count, mlbCount: v.mlbCount }] as [
        string,
        { count: number; mlbCount: number },
      ],
    );
  const unowned = [...input.allTitles].filter((t) => !input.ownedSv.has(t));
  const svMode: "owned" | "unowned" =
    input.ownedSv.size <= unowned.length ? "owned" : "unowned";
  const svList = svMode === "owned" ? [...input.ownedSv] : unowned;
  return {
    v: 1,
    settings: { ...input.settings },
    ownedCes,
    svMode,
    svList,
    locked: [...input.locked],
    costumes: [...input.costumeTitles],
    costumesOff: [...input.costumeOffTitles],
  };
}

export interface ParsedConfig {
  settings: PersistedConfig["settings"];
  ownedCeIds: Map<string, { count: number; mlbCount: number }>;
  ownedSv: Set<string>;
  locked: string[];
  costumeTitles: string[];
  /** 显式反选的灵衣从者 (有灵衣者默认勾上, 这些除外) */
  costumesOff: string[];
}

/** 解析并校验配置; 对当前数据中不存在的礼装/从者做容错 */
export function parseConfig(
  json: string,
  availableCeIds: Set<string>,
  allTitles: Set<string>,
): ParsedConfig | null {
  try {
    const raw = JSON.parse(json) as PersistedConfig;
    if (!raw || raw.v !== 1) return null;

    const settings = {
      costLimit: clampInt(raw.settings?.costLimit, 1, 999, 113),
      ownSlots: clampInt(raw.settings?.ownSlots, 1, 6, 6),
      includeSupport: raw.settings?.includeSupport !== false,
      supportRarity: [1, 2, 3, 4, 5].includes(Number(raw.settings?.supportRarity))
        ? Number(raw.settings.supportRarity)
        : 4,
      supportMode: typeof raw.settings?.supportMode === "string" ? raw.settings.supportMode : "auto",
      autoPickFree: raw.settings?.autoPickFree !== false,
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

    const ownedCeIds = new Map<string, { count: number; mlbCount: number }>();
    for (const [id, v] of Array.isArray(raw.ownedCes) ? raw.ownedCes : []) {
      if (availableCeIds.has(id) && v && Number(v.count) > 0) {
        ownedCeIds.set(id, {
          count: Math.min(5, Number(v.count) || 1),
          mlbCount: Number(v.mlbCount) > 0 ? 1 : 0,
        });
      }
    }

    const list = (Array.isArray(raw.svList) ? raw.svList : []).filter((t) => allTitles.has(t));
    const ownedSv =
      raw.svMode === "unowned"
        ? new Set([...allTitles].filter((t) => !new Set(list).has(t)))
        : new Set(list);

    const locked = (Array.isArray(raw.locked) ? raw.locked : [])
      .filter((t) => allTitles.has(t))
      .slice(0, 6);
    const costumeTitles = (Array.isArray(raw.costumes) ? raw.costumes : []).filter((t) =>
      allTitles.has(t),
    );
    const costumesOff = (Array.isArray(raw.costumesOff) ? raw.costumesOff : []).filter((t) =>
      allTitles.has(t),
    );
    // 锁定/灵衣意味着已持有
    for (const t of [...locked, ...costumeTitles]) ownedSv.add(t);

    return { settings, ownedCeIds, ownedSv, locked, costumeTitles, costumesOff };
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
