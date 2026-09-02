// 核心优化器: 在 Cost 限制内组合羁绊礼装 + 选择从者, 最大化全队总羁绊加成
import type { BondScope } from "./types";
import type { ServantInfo } from "./data";
import { matchCount, servantMatchesTrait } from "./data";

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
  /** 该从者从"全队共享"礼装获得的加成 % (助战礼装也算) */
  partyBonus: number;
}

export interface OptimizeResult {
  feasible: boolean;
  error?: string;
  /** 是否为「cost最佳」方案 (尽可能用满 Cost 上限) */
  isCostMax?: boolean;
  /** 是否为「cost上限-1」方案 (预算少 1) */
  isCostMinusOne?: boolean;
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

/** 从候选助战礼装中按价值(加成x命中数)贪心选最优 */
function bestSupportOption(
  options: CeItem[],
  party: ServantInfo[],
  excludeKey: string | null,
): CeItem | null {
  let best: CeItem | null = null;
  let bestV = -1;
  for (const o of options) {
    if (o.key === excludeKey) continue;
    const v = o.bonus * matchCount(party, o.traits);
    if (v > bestV) {
      bestV = v;
      best = o;
    }
  }
  return best;
}

/** 给定队伍, 计算每个礼装 item 的价值 */
function itemValue(it: CeItem, party: ServantInfo[]): number {
  if (it.scope === "party") {
    return it.bonus * matchCount(party, it.traits);
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
    let pb = 0;
    for (const ce of partyCEs) {
      if (ce.traits.length === 0 || ce.traits.some((t) => servantMatchesTrait(s, t))) {
        pb += ce.bonus;
      }
    }
    return {
      servant: s,
      locked: i < locked.length,
      ce: chosen[i] ?? null,
      partyBonus: pb,
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
function optimizeWithSupportTopK(
  input: OptimizeInput,
  supportCe: CeItem | null,
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

  // 初始队伍: 锁定 + 最便宜填充
  let free = cheapestFillers(pool, freeCount);
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
      const scored = pool.map((s) => {
        let value = 0;
        for (const ce of partyCEs) {
          if (ce.traits.length === 0 || ce.traits.some((t) => servantMatchesTrait(s, t))) {
            value += ce.bonus;
          }
        }
        return { servant: s, cost: s.cost, value };
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

  // ---- Top-K 礼装组合 (对收敛后的队伍) ----
  const items = input.ceItems.map((it) => ({
    it,
    cost: it.cost,
    value: itemValue(it, party),
  }));
  const freeCost = party.slice(locked.length).reduce((s, x) => s + x.cost, 0);
  const budgetCe = Math.max(input.costLimit - lockedCost - freeCost, 0);
  const usable = items.filter((x) => x.value > 0);
  const freeCap = Math.max(0, input.maxCes - n);
  const paidCap = Math.min(input.maxCes, n);
  const { freeChosen, paidItems } = splitFreeCes(usable, freeCap, paidCap);

  const topSets = paidItems.length ? knapsackTopK(paidItems, budgetCe, paidCap, k) : [];
  const results =
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
 * 方案列表: 最佳方案 + 「cost上限-1」方案(预算少 1 求最佳) + 「cost最佳」方案(用满预算)。
 * 与已有方案重复的去重。
 */
export function optimizePlans(input: OptimizeInput): OptimizeResult[] {
  const results: OptimizeResult[] = [];
  const best = optimizeTopN(input, 1)[0];
  if (best?.feasible) results.push(best);

  if (input.costLimit > 1) {
    const minus1 = optimizeTopN({ ...input, costLimit: input.costLimit - 1 }, 1)[0];
    if (
      minus1?.feasible &&
      !results.some((r) => resultSignature(r) === resultSignature(minus1))
    ) {
      minus1.isCostMinusOne = true;
      results.push(minus1);
    }
  }

  const cm = optimizeCostMax(input);
  if (cm.feasible && !results.some((r) => resultSignature(r) === resultSignature(cm))) {
    results.push(cm);
  }
  return results;
}

export function optimize(input: OptimizeInput): OptimizeResult {
  const top = optimizeTopN(input, 1);
  if (top.length > 0) return top[0];
  // 全不可行: 返回第一个(无助战)的错误信息
  const r = optimizeWithSupportTopK(input, null, 1);
  return r[0] ?? infeasible("无法组队", input);
}
