// 核心优化器: 在 Cost 限制内组合羁绊礼装 + 选择从者, 最大化全队总羁绊加成
import type { BondScope } from "./types";
import type { ServantInfo } from "./data";
import {
  bestFormForCes,
  matchCountAnyForm,
  servantMatchesAnyForm,
  servantMatchesTrait,
} from "./data";

/** 一张可装备的礼装副本 */
export interface CeItem {
  key: string;
  id: string;
  name: string;
  isMlb: boolean;
  cost: number;
  /** 对单个符合条件从者的加成 % */
  bonus: number;
  /**
   * party   - 装备后全队(符合特性者)共享该加成
   * self    - 仅装备者获得
   * support - 装备在"助战位"(借用好友)时, 对全队(符合特性者)生效
   */
  scope: BondScope;
  /** 特性条件 (OR 列表, 空 = 无条件) */
  traits: string[];
  /** 展示标签 */
  label: string;
}

export interface OptimizeInput {
  costLimit: number;
  ownSlots: number;
  /** 最多装备的礼装数 (<= ownSlots; 卡 cost 时可减少) */
  maxCes: number;
  /** 折中方案权重 κ: 自由从者评分 = 特性加成 + κ×cost (0=纯加成) */
  servantCostWeight?: number;
  /** 是否计算助战位 (借用好友, cost 不计入) */
  includeSupport: boolean;
  /** 可选助战礼装 (优化器自动选最优, 含 null=无) */
  supportOptions: CeItem[];
  /** 冠位助战礼装 (第二助战位, 适配冠位战双助战; [] = 无) */
  supportOptions2: CeItem[];
  /** 自己槽位可用的全部礼装副本 */
  ceItems: CeItem[];
  /** 锁定从者 (按槽位顺序, 必须上阵) */
  lockedServants: ServantInfo[];
  /** 可选从者池 (自动填剩余槽位) */
  freePool: ServantInfo[];
  /** 是否自动选择剩余从者以最大化特性覆盖 */
  autoPickFree: boolean;
}

export interface SlotInfo {
  servant: ServantInfo | null;
  locked: boolean;
  ce: CeItem | null;
  /** 该从者从"全队共享"礼装获得的加成 % (助战礼装也算; 形态从者=其最优形态) */
  partyBonus: number;
  /** auto 形态下选中的战斗形象 (供前端提示"建议使用形象N"; 无=null) */
  formKey?: string | null;
  formLabel?: string | null;
}

export interface OptimizeResult {
  feasible: boolean;
  error?: string;
  /** 是否为「cost最佳」方案 (尽可能用满 Cost 上限) */
  isCostMax?: boolean;
  /** 是否为「锁定加成最佳」方案 (目标=锁定从者加成最高) */
  isLockedMax?: boolean;
  /** 上阵人数 */
  ownSlots: number;
  /** 队伍 Cost 上限 */
  costLimit: number;
  slots: SlotInfo[];
  support: SlotInfo | null;
  supportCe: CeItem | null;
  /** 冠位助战位 (第二助战) */
  support2: SlotInfo | null;
  supportCe2: CeItem | null;
  /** 选中的自己槽位礼装 */
  chosenCe: CeItem[];
  /** 自身加成合计 % (仅装备者) */
  selfBonus: number;
  servantCost: number;
  ceCost: number;
  /** 自己的总 cost (不含助战) */
  totalCost: number;
  /** 全队总加成百分点 = Σ 每人加成 */
  totalPct: number;
  /** 含基础 100%*ownSlots */
  grandTotalPct: number;
}

function infeasible(error: string, input: OptimizeInput): OptimizeResult {
  return {
    feasible: false,
    error,
    ownSlots: input.ownSlots,
    costLimit: input.costLimit,
    slots: [],
    support: null,
    supportCe: null,
    support2: null,
    supportCe2: null,
    chosenCe: [],
    selfBonus: 0,
    servantCost: 0,
    ceCost: 0,
    totalCost: 0,
    totalPct: 0,
    grandTotalPct: input.ownSlots * 100,
  };
}

interface KnapState {
  value: number;
  chosen: number[]; // 已选 item 下标
}

/**
 * 0/1 背包 (cost × 张数), 返回选中的 item 列表。
 * 注意: 不能只用 choice 指针回溯 (中间状态会被后续 item 覆盖导致重复选取),
 * 因此在每个状态内直接保存已选集合。
 */
export function knapsack<T extends { cost: number; value: number }>(
  items: T[],
  budget: number,
  maxCount: number,
): { chosen: T[]; totalCost: number; totalValue: number } {
  const dp: KnapState[][] = [];
  for (let c = 0; c <= budget; c++) {
    dp.push(
      Array.from({ length: maxCount + 1 }, () => ({ value: -1, chosen: [] as number[] })),
    );
  }
  dp[0][0] = { value: 0, chosen: [] };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    for (let c = budget; c >= it.cost; c--) {
      for (let k = maxCount; k >= 1; k--) {
        const prev = dp[c - it.cost][k - 1];
        if (prev.value >= 0 && prev.value + it.value > dp[c][k].value) {
          dp[c][k] = { value: prev.value + it.value, chosen: [...prev.chosen, i] };
        }
      }
    }
  }

  let bestC = 0;
  let bestK = 0;
  let bestV = -1;
  for (let c = 0; c <= budget; c++) {
    for (let k = 0; k <= maxCount; k++) {
      if (dp[c][k].value > bestV) {
        bestV = dp[c][k].value;
        bestC = c;
        bestK = k;
      }
    }
  }

  return {
    chosen: dp[bestC][bestK].chosen.map((i) => items[i]),
    totalCost: bestC,
    totalValue: bestV,
  };
}

/** 从候选助战礼装中按价值(加成x命中数)贪心选最优 (形态从者按任意形态乐观计, 最终以精确重算为准) */
function bestSupportOption(
  options: CeItem[],
  party: ServantInfo[],
  excludeKey: string | null,
): CeItem | null {
  let best: CeItem | null = null;
  let bestV = -1;
  for (const o of options) {
    if (o.key === excludeKey) continue;
    const v = o.bonus * matchCountAnyForm(party, o.traits);
    if (v > bestV) {
      bestV = v;
      best = o;
    }
  }
  return best;
}

/** 给定队伍, 计算每个礼装 item 的价值 (形态从者按任意形态乐观计) */
function itemValue(it: CeItem, party: ServantInfo[]): number {
  if (it.scope === "party") {
    return it.bonus * matchCountAnyForm(party, it.traits);
  }
  // self / 助战礼装普通数值: 只影响装备者
  return it.bonus;
}

function cheapestFillers(pool: ServantInfo[], count: number): ServantInfo[] {
  return [...pool].sort((a, b) => a.cost - b.cost).slice(0, count);
}

/**
 * Top-K 背包 (cost × 张数), 返回前 K 个互不相同的组合。
 * 每个状态内直接保存已选集合 (避免回溯链被覆盖)。
 */
export function knapsackTopK<T extends { cost: number; value: number }>(
  items: T[],
  budget: number,
  maxCount: number,
  k: number,
): { chosen: T[]; chosenIndices: number[]; totalCost: number; totalValue: number }[] {
  interface St {
    value: number;
    cost: number;
    chosen: number[];
  }
  const sig = (chosen: number[]) => chosen.join(",");
  const merge = (list: St[], cand: St): St[] => {
    const m = new Map<string, St>();
    for (const s of list) m.set(sig(s.chosen), s);
    m.set(sig(cand.chosen), cand);
    return [...m.values()].sort((a, b) => b.value - a.value).slice(0, k);
  };

  const dp: St[][][] = [];
  for (let c = 0; c <= budget; c++) {
    dp.push(Array.from({ length: maxCount + 1 }, () => [] as St[]));
  }
  dp[0][0] = [{ value: 0, cost: 0, chosen: [] }];

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    for (let c = budget; c >= it.cost; c--) {
      for (let j = maxCount; j >= 1; j--) {
        for (const prev of dp[c - it.cost][j - 1]) {
          dp[c][j] = merge(dp[c][j], {
            value: prev.value + it.value,
            cost: c,
            chosen: [...prev.chosen, i],
          });
        }
      }
    }
  }

  const all: St[] = [];
  for (let c = 0; c <= budget; c++) {
    for (let j = 0; j <= maxCount; j++) {
      for (const s of dp[c][j]) all.push(s);
    }
  }
  all.sort((a, b) => b.value - a.value);

  const seen = new Set<string>();
  const uniq: St[] = [];
  for (const s of all) {
    const key = sig(s.chosen);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
    if (uniq.length >= k) break;
  }

  return uniq.map((s) => ({
    chosen: s.chosen.map((i) => items[i]),
    chosenIndices: s.chosen,
    totalCost: s.cost,
    totalValue: s.value,
  }));
}

/** 由 (party, chosen, supportCe) 构建结果 */
function buildResult(
  input: OptimizeInput,
  supportCe: CeItem | null,
  supportCe2: CeItem | null,
  party: ServantInfo[],
  chosen: CeItem[],
): OptimizeResult {
  const n = input.ownSlots;
  const locked = input.lockedServants;
  const lockedCost = locked.reduce((s, x) => s + x.cost, 0);
  const free = party.slice(locked.length);
  const servantCost = lockedCost + free.reduce((s, x) => s + x.cost, 0);
  const ceCost = chosen.reduce((s, x) => s + x.cost, 0);
  const totalCost = servantCost + ceCost; // 自己的 cost (不含助战)
  if (totalCost > input.costLimit) {
    return infeasible(`Cost 超出上限 (${totalCost} > ${input.costLimit})`, input);
  }

  const partyCEs = [
    ...chosen.filter((x) => x.scope === "party"),
    ...(supportCe ? [supportCe] : []),
    ...(supportCe2 ? [supportCe2] : []),
  ];
  const slots: SlotInfo[] = party.map((s, i) => {
    // 形态从者 (auto): 每人独立选使自己在当前礼装组下加成最大的形态 (精确)
    const fb = bestFormForCes(s, partyCEs);
    return {
      servant: s,
      locked: i < locked.length,
      ce: chosen[i] ?? null,
      partyBonus: fb.bonus,
      ...(fb.formKey ? { formKey: fb.formKey, formLabel: fb.formLabel } : {}),
    };
  });

  const selfBonus = chosen.filter((x) => x.scope !== "party").reduce((s, x) => s + x.bonus, 0);
  const totalPct = slots.reduce((s, x) => s + x.partyBonus, 0) + selfBonus;

  return {
    feasible: true,
    ownSlots: n,
    costLimit: input.costLimit,
    slots,
    support: input.includeSupport
      ? { servant: null, locked: false, ce: supportCe, partyBonus: 0 }
      : null,
    supportCe: input.includeSupport ? supportCe : null,
    support2: input.includeSupport && supportCe2
      ? { servant: null, locked: false, ce: supportCe2, partyBonus: 0 }
      : null,
    supportCe2: input.includeSupport ? supportCe2 : null,
    chosenCe: chosen,
    selfBonus,
    servantCost,
    ceCost,
    totalCost,
    totalPct,
    grandTotalPct: n * 100 + totalPct,
  };
}


/** 免费礼装位 (冠位模式: 装备数可大于上阵人数, 超出部分 cost 计 0) */
function splitFreeCes(
  items: { it: CeItem; cost: number; value: number }[],
  freeCap: number,
  paidCap: number,
): { freeChosen: CeItem[]; paidItems: { it: CeItem; cost: number; value: number }[]; paidCap: number } {
  if (freeCap <= 0) return { freeChosen: [], paidItems: items, paidCap };
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const free = sorted.slice(0, freeCap);
  const freeKeys = new Set(free.map((x) => x.it.key));
  const paidItems = sorted.filter((x) => !freeKeys.has(x.it.key));
  return {
    // 免费礼装 cost 记 0 (不消耗预算)
    freeChosen: free.map((x) => ({ ...x.it, cost: 0 })),
    paidItems,
    paidCap,
  };
}

/**
 * 对固定助战礼装做优化, 返回该助战下的 Top-K 结果。
 * 交替迭代收敛最佳队伍后, 对最终队伍取 Top-K 礼装组合。
 */
/**
 * 交替迭代核心: 从给定「自由从者初始种子」出发, 收敛后返回 Top-K 礼装组合结果。
 * 交替法对初始队伍敏感 (不同种子可能收敛到不同局部最优),
 * 多起点优化 = 换多个种子各跑一遍, 取全局最优。
 */
function runAlternation(
  input: OptimizeInput,
  supportCe: CeItem | null,
  initialFree: ServantInfo[],
  k: number,
): OptimizeResult[] {
  const n = input.ownSlots;
  const locked = input.lockedServants;
  if (locked.length > n) {
    return [infeasible(`锁定从者数量 (${locked.length}) 超过上阵位 (${n})`, input)];
  }
  const freeCount = n - locked.length;
  const pool = [...input.freePool];
  if (pool.length < freeCount) {
    return [infeasible(`可用从者不足: 还需要 ${freeCount} 名, 剩余可选 ${pool.length} 名`, input)];
  }

  const lockedCost = locked.reduce((s, x) => s + x.cost, 0);

  let free = [...initialFree];
  let bestParty: ServantInfo[] | null = null;

  for (let iter = 0; iter < 6; iter++) {
    const party = [...locked, ...free];

    // ---- 礼装 DP (助战 cost 不计入自己的预算) ----
    const items = input.ceItems.map((it) => ({
      it,
      cost: it.cost,
      value: itemValue(it, party),
    }));
    const freeCost = free.reduce((s, x) => s + x.cost, 0);
    const budgetCe = input.costLimit - lockedCost - freeCost;
    if (budgetCe < 0) {
      return [
        infeasible(
          `Cost 不足: 自己从者已占 ${lockedCost + freeCost}, 超过上限 ${input.costLimit}`,
          input,
        ),
      ];
    }
    const usable = items.filter((x) => x.value > 0);
    const freeCap = Math.max(0, input.maxCes - n);
    const paidCap = Math.min(input.maxCes, n);
    const { freeChosen, paidItems } = splitFreeCes(usable, freeCap, paidCap);
    const kp = knapsack(paidItems, budgetCe, paidCap);
    const chosen = [...kp.chosen.map((x) => x.it), ...freeChosen];

    // ---- 冠位助战位: 贪心选最优 (不与主助战重复) ----
    const supportCe2 = bestSupportOption(input.supportOptions2, party, supportCe?.key ?? null);

    // ---- 自动选从者: 按已选礼装评分 ----
    if (input.autoPickFree && freeCount > 0) {
      const partyCEs = [
        ...chosen.filter((x) => x.scope === "party"),
        ...(supportCe ? [supportCe] : []),
        ...(supportCe2 ? [supportCe2] : []),
      ];
      const kappa = input.servantCostWeight ?? 0;
      const scored = pool.map((s) => {
        let value = 0;
        if (s.forms?.length) {
          // 形态从者 (auto): 按其在当前礼装组下的最优形态计
          value = bestFormForCes(s, partyCEs).bonus;
        } else {
          for (const ce of partyCEs) {
            if (ce.traits.length === 0 || ce.traits.some((t) => servantMatchesTrait(s, t))) {
              value += ce.bonus;
            }
          }
        }
        return { servant: s, cost: s.cost, value: value + kappa * s.cost };
      });
      const budgetSv = input.costLimit - lockedCost - kp.totalCost;
      if (budgetSv >= 0) {
        const kp2 = knapsack(scored, budgetSv, freeCount);
        const picked = kp2.chosen.map((x) => x.servant);
        if (picked.length === freeCount) {
          free = picked;
        }
      }
    }

    // 收敛判断
    const newParty = [...locked, ...free];
    if (bestParty !== null && newParty.every((s, i) => bestParty![i] === s)) {
      bestParty = newParty;
      break;
    }
    bestParty = newParty;
  }

  const party = bestParty!;
  const supportCe2 = bestSupportOption(input.supportOptions2, party, supportCe?.key ?? null);

  const freeCost = party.slice(locked.length).reduce((s, x) => s + x.cost, 0);
  const budgetCe = Math.max(input.costLimit - lockedCost - freeCost, 0);
  const freeCap = Math.max(0, input.maxCes - n);
  const paidCap = Math.min(input.maxCes, n);

  let results: OptimizeResult[];
  if (partyHasAutoForm(party)) {
    // 形态从者: 精确枚举 CE 子集 (防"不同形态各命中一张 20%"被按张数累加高估)
    const exactSets = selectCesExact(input, party, budgetCe, paidCap, freeCap, supportCe, supportCe2, k);
    if (exactSets.length > 0) {
      results = exactSets.map((chosen) => buildResult(input, supportCe, supportCe2, party, chosen));
      return results;
    }
    // 子集过大回退: 走下方近似路径
  }
  // ---- Top-K 礼装组合 (对收敛后的队伍) ----
  const items = input.ceItems.map((it) => ({
    it,
    cost: it.cost,
    value: itemValue(it, party),
  }));
  const usable = items.filter((x) => x.value > 0);
  const { freeChosen, paidItems } = splitFreeCes(usable, freeCap, paidCap);

  const topSets = paidItems.length ? knapsackTopK(paidItems, budgetCe, paidCap, k) : [];
  results =
    topSets.length > 0
      ? topSets.map((ks) =>
          buildResult(input, supportCe, supportCe2, party, [
            ...ks.chosen.map((x) => x.it),
            ...freeChosen,
          ]),
        )
      : [buildResult(input, supportCe, supportCe2, party, [...freeChosen])];
  return results;
}

/** 队伍中是否含 auto 形态从者 (需精确 CE 子集枚举) */
function partyHasAutoForm(party: ServantInfo[]): boolean {
  return party.some((s) => s.forms && s.forms.length > 0);
}

/**
 * 精确 CE 子集搜索: 枚举全部合法子集 (≤ paidCap 付费 + freeCap 免费, 付费 cost ≤ budget),
 * 按「每人取 argmax 形态」的精确总加成排序, 返回前 k 组。
 * 仅当子集空间可控 (礼装 ≤ 26 张) 时使用。
 */
function selectCesExact(
  input: OptimizeInput,
  party: ServantInfo[],
  budget: number,
  paidCap: number,
  freeCap: number,
  supportCe: CeItem | null,
  supportCe2: CeItem | null,
  k: number,
  filterParty: ServantInfo[] = party,
): CeItem[][] {
  // filterParty: 决定哪些礼装"有价值"(如只看锁定从者); party: 精确总分计数的成员
  const items = input.ceItems.filter((it) => it.scope !== "party" || itemValue(it, filterParty) > 0);
  if (items.length > 26) return [];
  const exactTotal = (chosen: CeItem[]) => {
    const partyCEs = [
      ...chosen.filter((x) => x.scope === "party"),
      ...(supportCe ? [supportCe] : []),
      ...(supportCe2 ? [supportCe2] : []),
    ];
    let t = 0;
    for (const s of party) t += bestFormForCes(s, partyCEs).bonus;
    t += chosen.filter((x) => x.scope !== "party").reduce((a, c) => a + c.bonus, 0);
    return t;
  };
  const totalCost = (chosen: CeItem[]) => chosen.reduce((a, c) => a + c.cost, 0);
  const maxCount = paidCap + freeCap;
  interface Cand { set: CeItem[]; total: number; cost: number }
  const cands: Cand[] = [];
  const rec = (start: number, chosen: CeItem[]) => {
    // 付费 = 总数 - 免费位(至多 freeCap, 优先免最贵的); 需 ≤ paidCap 且付费 cost ≤ budget
    const n = chosen.length;
    const freeUsed = Math.min(freeCap, n);
    const paidCount = n - freeUsed;
    if (paidCount <= paidCap) {
      const cost = totalCost(chosen);
      const freeCost = chosen
        .map((c) => c.cost)
        .sort((a, b) => b - a)
        .slice(0, freeUsed)
        .reduce((a, b) => a + b, 0);
      if (cost - freeCost <= budget) {
        cands.push({ set: [...chosen], total: exactTotal(chosen), cost });
      }
    }
    if (n >= maxCount) return;
    for (let i = start; i < items.length; i++) {
      chosen.push(items[i]);
      rec(i + 1, chosen);
      chosen.pop();
    }
  };
  rec(0, []);
  cands.sort((a, b) => b.total - a.total || b.cost - a.cost);
  // 免费位 (至多 freeCap 张最贵的) cost 置 0, 与常规路径一致
  const freeZero = (arr: CeItem[], cap: number): CeItem[] => {
    const free = new Set(
      arr
        .map((c, i) => ({ i, cost: c.cost }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, Math.min(cap, arr.length))
        .map((x) => x.i),
    );
    return arr.map((c, i) => (free.has(i) ? { ...c, cost: 0 } : c));
  };
  return cands.slice(0, Math.max(k, 1)).map((c) => freeZero(c.set, freeCap));
}

/** 默认单起点: 自由位以「最便宜填充」起步 */
function optimizeWithSupportTopK(
  input: OptimizeInput,
  supportCe: CeItem | null,
  k: number,
): OptimizeResult[] {
  const freeCount = input.ownSlots - input.lockedServants.length;
  const pool = [...input.freePool];
  return runAlternation(input, supportCe, cheapestFillers(pool, freeCount), k);
}

/** 多起点入口: 从指定自由从者种子起步跑完整交替收敛 (种子可来自随机/特性定向采样) */
export function optimizeFromSeed(
  input: OptimizeInput,
  supportCe: CeItem | null,
  seed: ServantInfo[],
  k = 1,
): OptimizeResult[] {
  const freeCount = input.ownSlots - input.lockedServants.length;
  if (seed.length !== freeCount) {
    throw new Error(`多起点种子需恰好 ${freeCount} 名自由从者, 实际 ${seed.length}`);
  }
  return runAlternation(input, supportCe, [...seed], k);
}

function resultSignature(r: OptimizeResult): string {
  if (!r.feasible) return "!";
  const sv = r.slots
    .map((s) => s.servant!.name)
    .sort()
    .join("|");
  const ce = r.chosenCe
    .map((c) => c.key)
    .sort()
    .join("|");
  return `${sv}§${ce}§${r.supportCe?.key ?? "none"}§${r.supportCe2?.key ?? "none"}`;
}

/** 返回 Top-N 组队方案 (跨助战礼装选项, 去重, 按总加成降序) */
export function optimizeTopN(input: OptimizeInput, n = 3): OptimizeResult[] {
  const options: (CeItem | null)[] = input.includeSupport ? [null, ...input.supportOptions] : [null];
  const seen = new Set<string>();
  const results: OptimizeResult[] = [];
  for (const opt of options) {
    for (const r of optimizeWithSupportTopK(input, opt, Math.max(n, 1))) {
      if (!r.feasible) continue;
      const sig = resultSignature(r);
      if (seen.has(sig)) continue;
      seen.add(sig);
      results.push(r);
    }
  }
  results.sort(
    (a, b) => b.grandTotalPct - a.grandTotalPct || b.totalCost - a.totalCost,
  );
  return results.slice(0, n);
}

/** 子集和表: dp[k][c] = 用恰好 k 个 item 达到花费 c 的可行性 + 一组选择 */
interface SubsetCell {
  ok: boolean;
  chosen: number[];
}
function subsetTable(items: number[], maxCount: number, maxCost: number): SubsetCell[][] {
  const dp: SubsetCell[][] = Array.from({ length: maxCount + 1 }, () =>
    Array.from({ length: maxCost + 1 }, () => ({ ok: false, chosen: [] as number[] })),
  );
  dp[0][0] = { ok: true, chosen: [] };
  for (let i = 0; i < items.length; i++) {
    const cost = items[i];
    for (let k = maxCount; k >= 1; k--) {
      for (let c = maxCost; c >= cost; c--) {
        const prev = dp[k - 1][c - cost];
        if (prev.ok) {
          dp[k][c] = { ok: true, chosen: [...prev.chosen, i] };
        }
      }
    }
  }
  return dp;
}

/**
 * 「cost最佳」方案: 在 Cost 上限内尽可能用满 cost (上高星从者 + 装满礼装)。
 * 从者(恰好自由位数量)与礼装(至多 maxCes 张)共用预算, 用子集和求总 cost 最大组合。
 * 助战(免费)仍按加成选最优。
 */
export function optimizeCostMax(input: OptimizeInput): OptimizeResult {
  const n = input.ownSlots;
  const locked = input.lockedServants;
  if (locked.length > n) {
    return infeasible(`锁定从者数量 (${locked.length}) 超过上阵位 (${n})`, input);
  }
  const freeCount = n - locked.length;
  const pool = [...input.freePool];
  if (pool.length < freeCount) {
    return infeasible(`可用从者不足: 还需要 ${freeCount} 名, 剩余可选 ${pool.length} 名`, input);
  }
  const lockedCost = locked.reduce((s, x) => s + x.cost, 0);
  const limit = input.costLimit - lockedCost;
  if (limit < 0) {
    return infeasible(`Cost 不足: 锁定从者已占 ${lockedCost}, 超过上限 ${input.costLimit}`, input);
  }
  // 付费礼装位 = min(maxCes, 上阵人数); 超出部分为免费位 (不消耗 cost)
  const paidCap = Math.min(input.maxCes, n);
  const freeCap = Math.max(0, input.maxCes - n);

  const svDp = subsetTable(pool.map((s) => s.cost), freeCount, limit);
  const ceDp = subsetTable(input.ceItems.map((it) => it.cost), paidCap, limit);

  const svCosts = new Set<number>();
  for (let c = 0; c <= limit; c++) if (svDp[freeCount][c].ok) svCosts.add(c);
  const ceCosts = new Set<number>();
  for (let k = 0; k <= paidCap; k++) {
    for (let c = 0; c <= limit; c++) if (ceDp[k][c].ok) ceCosts.add(c);
  }

  let bestS = 0;
  let bestC = 0;
  let bestT = -1;
  for (const s of svCosts) {
    for (const c of ceCosts) {
      const t = s + c;
      if (t <= limit && t > bestT) {
        bestT = t;
        bestS = s;
        bestC = c;
      }
    }
  }

  const svChosen = svDp[freeCount][bestS].chosen;
  let ceChosen: number[] = [];
  for (let k = 0; k <= paidCap; k++) {
    if (ceDp[k][bestC].ok) {
      ceChosen = ceDp[k][bestC].chosen;
      break;
    }
  }

  const freeServants = svChosen.map((i) => pool[i]);
  const party = [...locked, ...freeServants];
  const paidCes = ceChosen.map((i) => input.ceItems[i]);
  // 免费位: 剩余礼装按加成价值选 freeCap 张 (cost 0)
  const paidKeys = new Set(paidCes.map((c) => c.key));
  const freeCes = freeCap > 0
    ? input.ceItems
        .filter((it) => !paidKeys.has(it.key))
        .map((it) => ({ it, value: itemValue(it, party) }))
        .filter((x) => x.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, freeCap)
        .map((x) => ({ ...x.it, cost: 0 }))
    : [];
  const chosen = [...paidCes, ...freeCes];
  const supportCe = bestSupportOption(input.supportOptions, party, null);
  const supportCe2 = bestSupportOption(input.supportOptions2, party, supportCe?.key ?? null);
  const r = buildResult(input, supportCe, supportCe2, party, chosen);
  r.isCostMax = true;
  return r;
}

/**
 * 「锁定加成最佳」方案: 目标只最大化【锁定从者】的总加成,
 * 自由位以最便宜填充(最大化礼装预算), 礼装/助战均围绕锁定从者匹配。
 * 无锁定时返回 null (不展示该方案)。
 */
export function optimizeLockedBest(input: OptimizeInput): OptimizeResult | null {
  const locked = input.lockedServants;
  const n = input.ownSlots;
  if (locked.length === 0 || locked.length > n) return null;
  const freeCount = n - locked.length;
  const pool = [...input.freePool];
  if (pool.length < freeCount) return null;
  const free = cheapestFillers(pool, freeCount);
  const party = [...locked, ...free];
  const lockedCost = locked.reduce((s, x) => s + x.cost, 0);
  const freeCost = free.reduce((s, x) => s + x.cost, 0);
  const budgetCe = Math.max(input.costLimit - lockedCost - freeCost, 0);
  const freeCap = Math.max(0, input.maxCes - n);
  const paidCap = Math.min(input.maxCes, n);
  const lockedPctOf = (r: OptimizeResult) =>
    r.slots.slice(0, locked.length).reduce((a, s) => a + s.partyBonus, 0);
  const options: (CeItem | null)[] = input.includeSupport ? [null, ...input.supportOptions] : [null];
  let best: OptimizeResult | null = null;
  for (const sup of options) {
    // 冠位助战按锁定从者匹配度贪心 (目标只看锁定加成)
    const sup2 = bestSupportOption(input.supportOptions2, locked, sup?.key ?? null);
    const sets = selectCesExact(input, locked, budgetCe, paidCap, freeCap, sup, sup2, 1, locked);
    for (const chosen of sets) {
      const r = buildResult(input, sup, sup2, party, chosen);
      if (!r.feasible) continue;
      const lp = lockedPctOf(r);
      const blp = best ? lockedPctOf(best) : -1;
      if (!best || lp > blp || (lp === blp && r.totalPct > best.totalPct)) best = r;
    }
  }
  return best;
}

/** 智能方案(首选)的自由从者 cost 权重 κ: 加成第一, 同加成尽量上高星 */
const SMART_K = 1;

// ---------------------------------------------------------------------------
// 多起点: 交替法对初始队伍敏感, 从多个确定性种子出发收敛取全局最优
// ---------------------------------------------------------------------------

/** 确定性 PRNG (随机种子固定, 保证结果可复现/可分享) */
function mulberry32(a: number): () => number {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** cost 降序 (同 cost 高稀有度优先) */
function byCostDesc(a: ServantInfo, b: ServantInfo): number {
  return b.cost - a.cost || b.rarity - a.rarity;
}

/**
 * 构建多起点初始种子 (自由从者集合, 每个长度 = freeCount):
 * - 最便宜: 等价于原单起点 (保证多起点结果不倒退)
 * - 最高星: cost 降序
 * - 特性定向: 秩序善/秩序女性/星或恶/灵衣/兽科, 各自 cost 降序
 * - 职阶定向: 七职阶各自 cost 降序
 * - 随机: 固定种子抽样 (多样性兜底)
 * 特性/职阶种子匹配不足 freeCount 人时跳过。
 */
function buildSeeds(pool: ServantInfo[], freeCount: number): ServantInfo[][] {
  const seeds: ServantInfo[][] = [];
  const push = (arr: ServantInfo[]) => {
    const uniq = [...new Map(arr.map((s) => [s.name, s])).values()];
    if (uniq.length >= freeCount) seeds.push(uniq.slice(0, freeCount));
  };
  const top = (list: ServantInfo[]) => [...list].sort(byCostDesc);
  const cheapest = [...pool].sort((a, b) => a.cost - b.cost);

  push(cheapest); // 默认起点 (单起点行为)
  push(top(pool)); // 最高星
  for (const ts of [["秩序·善"], ["秩序的女性"], ["星", "恶"], ["持有灵衣之人"], ["兽科从者"]]) {
    push(top(pool.filter((s) => ts.some((t) => servantMatchesAnyForm(s, t)))));
  }
  for (const cls of ["Saber", "Archer", "Lancer", "Rider", "Caster", "Assassin", "Berserker"]) {
    push(top(pool.filter((s) => s.className === cls)));
  }
  const rng = mulberry32(20240511);
  for (let i = 0; i < 6; i++) {
    push([...pool].sort(() => rng() - 0.5));
  }

  const seen = new Set<string>();
  const key = (p: ServantInfo[]) => p.map((s) => s.name).sort().join("|");
  return seeds.filter((p) => (seen.has(key(p)) ? false : (seen.add(key(p)), true)));
}

/**
 * 多起点优化: 每个种子 × 每种助战礼装选项做交替收敛, 返回全局最优。
 * 含默认「最便宜」种子, 因此结果不差于单起点 (optimizeTopN)。
 * 返回 null 表示无可行解 (由调用方回退到单起点以保留错误信息)。
 */
export function optimizeMultiStart(input: OptimizeInput): OptimizeResult | null {
  const freeCount = input.ownSlots - input.lockedServants.length;
  const pool = [...input.freePool];
  if (pool.length < freeCount) return null;
  const seeds = buildSeeds(pool, freeCount);
  const options: (CeItem | null)[] = input.includeSupport ? [null, ...input.supportOptions] : [null];
  let best: OptimizeResult | null = null;
  for (const seed of seeds) {
    for (const opt of options) {
      const r = runAlternation(input, opt, seed, 1)[0];
      if (!r?.feasible) continue;
      if (
        !best ||
        r.totalPct > best.totalPct ||
        (r.totalPct === best.totalPct && r.totalCost > best.totalCost)
      ) {
        best = r;
      }
    }
  }
  return best;
}

/**
 * 方案列表 (全部展示, 由前端折叠后排):
 *   候选1: 加成最优 (κ=0, 纯加成)
 *   候选2: 智能方案 (κ=1, 加成第一 + κ×cost 尽量上高星) —— 通常榜首
 *   候选3: cost最佳 (尽可能用满 cost)
 * useMultiStart=false 时退化为单起点快速模式 (深度搜索开关关闭)。
 * 签名去重后按 (加成降序, 同加成 cost 降序) 排序。
 */
export function optimizePlans(input: OptimizeInput, useMultiStart = true): OptimizeResult[] {
  const candidates: OptimizeResult[] = [];

  const pushUnique = (r: OptimizeResult | undefined, mark?: (x: OptimizeResult) => void) => {
    if (!r?.feasible) return;
    if (candidates.some((x) => resultSignature(x) === resultSignature(r))) return;
    mark?.(r);
    candidates.push(r);
  };

  const smart = { ...input, servantCostWeight: SMART_K };
  if (useMultiStart) {
    // 多起点 (含默认起点种子, 保证不倒退); 无可行解时回退单起点以保留错误信息
    pushUnique(
      optimizeMultiStart({ ...input, servantCostWeight: 0 }) ?? optimizeTopN(input, 1)[0],
    ); // 加成最佳 (κ=0)
    pushUnique(optimizeMultiStart(smart) ?? optimizeTopN(smart, 1)[0]); // 智能方案 (κ=1)
  } else {
    pushUnique(optimizeTopN(input, 1)[0]); // 加成最佳 (κ=0)
    pushUnique(optimizeTopN(smart, 1)[0]); // 智能方案 (κ=1)
  }
  // 锁定加成最佳 (仅当有锁定时出现; 目标=锁定从者加成最高)
  pushUnique(optimizeLockedBest(input) ?? undefined, (x) => {
    x.isLockedMax = true;
  });

  candidates.sort((a, b) => b.totalPct - a.totalPct || b.totalCost - a.totalCost);
  return candidates;
}

export function optimize(input: OptimizeInput): OptimizeResult {
  const top = optimizeTopN(input, 1);
  if (top.length > 0) return top[0];
  // 全不可行: 返回第一个(无助战)的错误信息
  const r = optimizeWithSupportTopK(input, null, 1);
  return r[0] ?? infeasible("无法组队", input);
}
