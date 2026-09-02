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

/** 从者的一个战斗形象形态 (爬取自 Mooncell 特性备注/散文; 完整快照) */
export interface ServantForm {
  /** 形态键: 形象1/形象2/形象3/灵衣136 */
  key: string;
  /** 显示名: 战斗形象1 / 简易灵衣：地球总统 */
  label: string;
  attr1: string;
  attr2: string;
  gender: string;
  subAttr: string;
  /** 该形态下的特性列表 */
  traits: string[];
}

/** 从者 (爬取自 Mooncell 基础数值模板) */
export interface Servant {
  /** 页面标题 (唯一标识, 如 吉尔伽美什(Caster)) */
  title: string;
  /** 序号 (日服实装顺序, 游戏图鉴排序) */
  collectionNo?: number;
  /** 中文名 (可能与其他形态重名) */
  name: string;
  jpName?: string;
  rarity: number;
  /** 显式 COST 覆盖 (仅 玛修: COST=0, 各战斗形象均不占 cost); 缺省按稀有度推导 */
  cost?: number;
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
  /** 形态特性差异 (随战斗形象/灵衣变化, 如 U－奥尔加玛丽); 无则省略 */
  forms?: ServantForm[];
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
