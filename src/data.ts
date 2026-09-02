// 数据整理: 从爬取的 JSON 构建羁绊礼装目录、礼装副本、助战礼装选项、特性匹配
import type { BondScope, Ce, Servant } from "./types";
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
}

export function toServantInfo(s: Servant): ServantInfo {
  return {
    name: s.title,
    cost: servantCostByRarity(s.rarity),
    rarity: s.rarity,
    attr1: s.attr1,
    attr2: s.attr2,
    gender: s.gender,
    subAttr: s.subAttr,
    className: s.className,
    traits: [...s.traits],
    extraTraits: [],
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
    if (!servantMatchesTrait(info, t)) return false;
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
  /** 持有总张数 */
  count: number;
  /** 其中满破张数 */
  mlbCount: number;
}

function itemLabel(scope: BondScope, bonus: number, isMlb: boolean): string {
  const tag = isMlb ? "(满破)" : "";
  if (scope === "party") return `全体+${bonus}%${tag}`;
  if (scope === "support") return `助战礼装·自身+${bonus}%${tag}`;
  return `自身+${bonus}%${tag}`;
}

/** 把自己持有的羁绊礼装(按副本)展开为优化器可用的礼装 item */
export function toCeItems(owned: OwnedCeState[]): CeItem[] {
  const items: CeItem[] = [];
  for (const o of owned) {
    const cat = o.catalog;
    if (o.count <= 0) continue;
    const mlbCopies = Math.min(o.mlbCount, o.count);
    const normalCopies = o.count - mlbCopies;
    for (let i = 0; i < mlbCopies; i++) {
      const e = cat.mlb;
      if (!e) continue;
      // 助战类礼装装在自己槽位上时, 只对装备者生效(普通数值)
      const scope: BondScope = e.scope === "support" ? "self" : e.scope;
      items.push({
        key: `${cat.id}#mlb#${i}`,
        id: cat.id,
        name: cat.name,
        isMlb: true,
        cost: cat.cost,
        bonus: e.bonus,
        scope,
        traits: cat.traits,
        label: itemLabel(scope, e.bonus, true),
      });
    }
    for (let i = 0; i < normalCopies; i++) {
      const e = cat.normal;
      if (!e) continue;
      const scope: BondScope = e.scope === "support" ? "self" : e.scope;
      items.push({
        key: `${cat.id}#n#${i}`,
        id: cat.id,
        name: cat.name,
        isMlb: false,
        cost: cat.cost,
        bonus: e.bonus,
        scope,
        traits: cat.traits,
        label: itemLabel(scope, e.bonus, false),
      });
    }
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
    if (cat.mlb.scope === "party") {
      out.push({
        key: `${cat.id}#mlb`,
        id: cat.id,
        name: cat.name,
        isMlb: true,
        cost: cat.cost,
        bonus: cat.mlb.bonus,
        scope: "party",
        traits: cat.traits,
        label: `全体+${cat.mlb.bonus}%(满破)`,
      });
    } else if (cat.mlb.scope === "support" && cat.supportMlb != null) {
      out.push({
        key: `${cat.id}#mlb`,
        id: cat.id,
        name: cat.name,
        isMlb: true,
        cost: cat.cost,
        bonus: cat.supportMlb,
        scope: "party",
        traits: [],
        label: `助战+${cat.supportMlb}%(满破)`,
      });
    }
  }
  return out;
}

/** 从者稀有度 -> cost */
export function servantCostByRarity(rarity: number): number {
  return { 1: 3, 2: 6, 3: 9, 4: 12, 5: 16 }[rarity] ?? 0;
}
