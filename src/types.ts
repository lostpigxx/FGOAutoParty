// FGO 羁绊组队计算器 —— 共享类型

/** 羁绊加成作用范围 */
export type BondScope = "party" | "self" | "support";

export interface BondEffect {
  /** 加成百分比 (support 时为普通数值) */
  bonus: number;
  scope: BondScope;
  mlb: boolean;
  /** scope=support 时的助战时数值 */
  supportBonus: number | null;
}

/** 概念礼装 (爬取自 Mooncell) */
export interface Ce {
  id: string;
  name: string;
  jpName: string;
  rarity: number;
  cost: number;
  icon: string;
  category: string;
  skill: string;
  /** 特性条件 (OR 列表, 空 = 无条件) */
  traits: string[];
  bond: BondEffect[];
}

/** 从者 (爬取自 Mooncell 基础数值模板) */
export interface Servant {
  /** 页面标题 (唯一标识, 如 吉尔伽美什(Caster)) */
  title: string;
  /** 中文名 (可能与其他形态重名) */
  name: string;
  jpName?: string;
  rarity: number;
  /** 属性1: 秩序/中立/混沌 */
  attr1: string;
  /** 属性2: 善/中庸/恶 */
  attr2: string;
  /** 性别: 男性/女性/其他 */
  gender: string;
  /** 副属性: 地/人/天/星/兽 */
  subAttr: string;
  /** 职阶: Saber/Archer/.../Shielder/... */
  className: string;
  /** 特性列表 */
  traits: string[];
  /** 是否有灵衣 (默认视为已解锁 → 拥有「持有灵衣之人」特性) */
  hasCostume?: boolean;
}

/** 御主等级 -> 队伍 Cost 上限 */
export type MasterCostMap = Record<number, number>;

/** 从者稀有度 -> cost */
export const SERVANT_COST: Record<number, number> = {
  1: 3,
  2: 6,
  3: 9,
  4: 12,
  5: 16,
};
