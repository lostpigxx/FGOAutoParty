// 数据整理: 从爬取的 JSON 构建羁绊礼装目录、礼装副本、助战礼装选项、特性匹配
import type { BondScope, Ce, Servant, ServantForm } from "./types";
import type { CeItem } from "./optimizer";

// ---------------------------------------------------------------------------
// 特性匹配
// ---------------------------------------------------------------------------

const SEVEN_KNIGHTS = new Set([
  "Saber", "Archer", "Lancer", "Rider", "Caster", "Assassin", "Berserker",
]);

/** 礼装侧特性名 -> 从者侧特性名 (Mooncell 两侧叫法可能不同) */
const TRAIT_ALIASES: Record<string, string[]> = {
  "Fate/stay night从者": ["FSN从者", "Fate/stay night从者"],
  "兽科从者": ["兽科", "兽科从者"],
};

export interface ServantInfo {
  name: string;
  cost: number;
  rarity: number;
  attr1: string;
  attr2: string;
  gender: string;
  subAttr: string;
  className: string;
  traits: string[];
  /** 用户手动标记的特性 (如 持有灵衣之人) */
  extraTraits: string[];
  /**
   * 战斗形象形态 (仅当特性/属性随形象变化, 如 U－奥尔加玛丽)。
   * 有形态时本快照即「形象1」形态 (基准), 列表含全部可选形态 (形象1/2/3/灵衣N)。
   */
  forms?: ServantForm[];
}

export function toServantInfo(s: Servant): ServantInfo {
  // 有形态差异时: 基准 = 形态列表首个 (形象1), 不再用抓取的并集特性
  const f0 = s.forms?.[0];
  return {
    name: s.title,
    cost: servantCostByRarity(s.rarity),
    rarity: s.rarity,
    attr1: f0?.attr1 ?? s.attr1,
    attr2: f0?.attr2 ?? s.attr2,
    gender: f0?.gender ?? s.gender,
    subAttr: f0?.subAttr ?? s.subAttr,
    className: s.className,
    traits: f0 ? [...f0.traits] : [...s.traits],
    extraTraits: [],
    forms: s.forms?.length ? [...s.forms] : undefined,
  };
}

/**
 * 视图筛选 (同时约束展示列表与优化器可用从者池):
 * - rarity:  允许的稀有度 (空 = 不限)
 * - classes: 允许的职阶, 任一符合即可 (空 = 不限)
 * - traits:  必须全部满足的特性 (空 = 不限)
 */
export interface ServantViewFilters {
  rarity: Set<number>;
  classes: Set<string>;
  traits: Set<string>;
}

export function servantPassesFilters(info: ServantInfo, f: ServantViewFilters): boolean {
  if (f.rarity.size > 0 && !f.rarity.has(info.rarity)) return false;
  if (f.classes.size > 0 && !f.classes.has(info.className)) return false;
  for (const t of f.traits) {
    // 形态从者: 任一形态满足即可 (形象切换可命中)
    if (!servantMatchesAnyForm(info, t)) return false;
  }
  return true;
}

/**
 * 从者是否符合某个特性条件。
 * 部分特性是由 属性/性别/副属性/职阶 推导的复合特性;
 * 其余直接查特性列表 (含别名)。
 */
export function servantMatchesTrait(s: ServantInfo, trait: string): boolean {
  switch (trait) {
    case "星":
      return s.subAttr === "星" || s.traits.includes("星");
    case "恶":
      return s.attr2 === "恶" || s.traits.includes("恶");
    case "中立":
      return s.attr1 === "中立" || s.traits.includes("中立");
    case "秩序·善":
      return (s.attr1 === "秩序" && s.attr2 === "善") || s.traits.includes("秩序·善");
    case "秩序的女性":
      return (s.attr1 === "秩序" && s.gender === "女性") || s.traits.includes("秩序的女性");
    case "混沌且七骑士":
      return (
        (s.attr1 === "混沌" && SEVEN_KNIGHTS.has(s.className)) ||
        s.traits.includes("混沌且七骑士")
      );
    case "Saber":
    case "Archer":
    case "Lancer":
    case "Rider":
    case "Caster":
    case "Assassin":
    case "Berserker":
      return s.className === trait || s.traits.includes(trait);
    default: {
      const candidates = TRAIT_ALIASES[trait] ?? [trait];
      return candidates.some((c) => s.traits.includes(c) || s.extraTraits.includes(c));
    }
  }
}

/** 队伍中符合特性条件(任一)的从者数; 无条件则返回全队人数 */
export function matchCount(party: ServantInfo[], traits: string[]): number {
  if (traits.length === 0) return party.length;
  return party.filter((s) => traits.some((t) => servantMatchesTrait(s, t))).length;
}

// ---------------------------------------------------------------------------
// 战斗形象形态 (forms)
// ---------------------------------------------------------------------------

/** 该从者的全部形态快照; 无形态时 = [自身] */
export function svSnapshots(info: ServantInfo): ServantInfo[] {
  if (!info.forms?.length) return [info];
  return info.forms.map((f) => ({
    ...info,
    attr1: f.attr1,
    attr2: f.attr2,
    gender: f.gender,
    subAttr: f.subAttr,
    traits: [...f.traits],
    extraTraits: [...info.extraTraits],
    forms: undefined,
  }));
}

/** 特性是否命中该从者的「任意形态」(搜索/筛选/徽标用: 有形象能对上即可) */
export function servantMatchesAnyForm(info: ServantInfo, trait: string): boolean {
  return svSnapshots(info).some((s) => servantMatchesTrait(s, trait));
}

/** 全队中「任一形态命中」该特性的人数 (搜索引导用) */
export function matchCountAnyForm(party: ServantInfo[], traits: string[]): number {
  if (traits.length === 0) return party.length;
  return party.filter((s) => traits.some((t) => servantMatchesAnyForm(s, t))).length;
}

/** 该从者相对给定礼装组 (party scope) 的最优形态加成 (auto 模式: 每从者独立取最优) */
export function bestFormForCes(
  info: ServantInfo,
  ces: readonly CeItem[],
): { bonus: number; formKey: string | null; formLabel: string | null } {
  const snaps = svSnapshots(info);
  const bonusOf = (s: ServantInfo) => {
    let b = 0;
    for (const ce of ces) {
      if (ce.traits.length === 0 || ce.traits.some((t) => servantMatchesTrait(s, t))) b += ce.bonus;
    }
    return b;
  };
  if (snaps.length === 1) {
    return { bonus: bonusOf(snaps[0]), formKey: null, formLabel: null };
  }
  let best = -1;
  let bestSnap = snaps[0];
  for (const s of snaps) {
    const b = bonusOf(s);
    if (b > best) {
      best = b;
      bestSnap = s;
    }
  }
  const f = info.forms![snaps.indexOf(bestSnap)];
  return { bonus: best, formKey: f.key, formLabel: f.label };
}

/** 特性条件的可读描述 */
export function traitText(traits: string[]): string {
  if (traits.length === 0) return "无条件";
  return traits.join(" 或 ");
}

// ---------------------------------------------------------------------------
// 羁绊礼装目录
// ---------------------------------------------------------------------------

export interface BondCeCatalog {
  id: string;
  name: string;
  jpName: string;
  rarity: number;
  /** 礼装 cost (只由稀有度决定, 满破不改变) */
  cost: number;
  /** 特性条件 (OR 列表, 空 = 无条件) */
  traits: string[];
  normal: { bonus: number; scope: BondScope } | null;
  mlb: { bonus: number; scope: BondScope } | null;
  supportNormal: number | null;
  supportMlb: number | null;
  summary: string;
}

const SCOPE_TEXT: Record<BondScope, string> = {
  party: "全体",
  self: "自身",
  support: "助战",
};

function fmtEffect(e: { bonus: number; scope: BondScope }, support: number | null): string {
  if (e.scope === "support") {
    const sup = support != null ? ` / 助战时+${support}%` : "";
    return `${SCOPE_TEXT[e.scope]}+${e.bonus}%${sup}`;
  }
  return `${SCOPE_TEXT[e.scope]}+${e.bonus}%`;
}

export function buildBondCatalog(ces: Ce[]): BondCeCatalog[] {
  const out: BondCeCatalog[] = [];
  for (const ce of ces) {
    if (!ce.bond || ce.bond.length === 0) continue;
    const normal = ce.bond.find((e) => !e.mlb) ?? null;
    const mlb = ce.bond.find((e) => e.mlb) ?? null;
    const parts: string[] = [];
    if (normal) {
      parts.push(
        fmtEffect(normal, normal.scope === "support" ? normal.supportBonus : null),
      );
    }
    if (mlb) {
      parts.push("满破 " + fmtEffect(mlb, mlb.scope === "support" ? mlb.supportBonus : null));
    }
    out.push({
      id: ce.id,
      name: ce.name,
      jpName: ce.jpName,
      rarity: ce.rarity,
      cost: ce.cost,
      traits: ce.traits,
      normal: normal ? { bonus: normal.bonus, scope: normal.scope } : null,
      mlb: mlb ? { bonus: mlb.bonus, scope: mlb.scope } : null,
      supportNormal: normal?.scope === "support" ? normal.supportBonus : null,
      supportMlb: mlb?.scope === "support" ? mlb.supportBonus : null,
      summary: parts.join("；"),
    });
  }
  return out;
}

export interface OwnedCeState {
  catalog: BondCeCatalog;
  /** 是否满破 (每张礼装至多 1 张) */
  mlb: boolean;
}

function itemLabel(scope: BondScope, bonus: number, isMlb: boolean): string {
  const tag = isMlb ? "(满破)" : "";
  if (scope === "party") return `全体+${bonus}%${tag}`;
  if (scope === "support") return `助战礼装·自身+${bonus}%${tag}`;
  return `自身+${bonus}%${tag}`;
}

/** 把持有的羁绊礼装展开为优化器可用的礼装 item (每张 1 个) */
export function toCeItems(owned: OwnedCeState[]): CeItem[] {
  const items: CeItem[] = [];
  for (const o of owned) {
    const cat = o.catalog;
    const e = o.mlb ? cat.mlb : cat.normal;
    if (!e) continue;
    // 所有羁绊加成均对全队生效; 助战类礼装(午茶)装在自己槽位时用普通数值(对全队)
    const scope: BondScope = e.scope === "support" ? "party" : e.scope;
    items.push({
      key: `${cat.id}#${o.mlb ? "mlb" : "n"}`,
      id: cat.id,
      name: cat.name,
      isMlb: o.mlb,
      cost: cat.cost,
      bonus: e.bonus,
      scope,
      traits: cat.traits,
      label: itemLabel(scope, e.bonus, o.mlb),
    });
  }
  return items;
}

/**
 * 助战位礼装选项: 好友可借、能给我方全队带来羁绊加成的礼装。
 * 仅保留 5★ 且只提供满破形态 (简化默认)。
 * 自身类礼装对助战位无意义, 排除。
 */
export function supportCeOptions(catalog: BondCeCatalog[]): CeItem[] {
  const out: CeItem[] = [];
  for (const cat of catalog) {
    if (cat.rarity !== 5) continue; // 只看 5★
    if (!cat.mlb) continue; // 只考虑满破
    const isSup = cat.mlb.scope === "support";
    const eff =
      cat.mlb.scope === "party" ? cat.mlb.bonus : isSup && cat.supportMlb != null ? cat.supportMlb : null;
    if (eff == null || eff < 5) continue; // 剔除 <5% 鸡肋 (与 ownEquipUsable 一致)
    out.push({
      key: `${cat.id}#mlb`,
      id: cat.id,
      name: cat.name,
      isMlb: true,
      cost: cat.cost,
      bonus: eff,
      scope: "party",
      traits: isSup ? [] : cat.traits,
      label: isSup ? `助战+${eff}%(满破)` : `全体+${eff}%(满破)`,
    });
  }
  return out;
}

/** 从者稀有度 -> cost */
export function servantCostByRarity(rarity: number): number {
  return { 1: 3, 2: 6, 3: 9, 4: 12, 5: 16 }[rarity] ?? 0;
}

/** 该礼装自己佩戴时的最高加成 (普通/满破取大, 与 scope 无关) */
export function ownEquipBonus(cat: BondCeCatalog): number {
  return Math.max(cat.normal?.bonus ?? 0, cat.mlb?.bonus ?? 0);
}

/**
 * 该礼装自己佩戴是否有价值: 加成 ≥5%。
 * 剔除 <5% 的鸡肋礼装 (如满破仅 2.5% 的 狼的故事/梦想衣橱/迎向碧空);
 * 5%/10%/15%/20% 均保留。
 */
export function ownEquipUsable(cat: BondCeCatalog): boolean {
  return ownEquipBonus(cat) >= 5;
}
