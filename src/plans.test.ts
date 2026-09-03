// 方案列表: cost最佳 已移除; 新增 锁定加成最佳
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toServantInfo, type ServantInfo } from "./data";
import { optimizePlans, type CeItem, type OptimizeInput } from "./optimizer";
import type { Servant } from "./types";

const servants: Servant[] = JSON.parse(readFileSync("public/data/servants.json", "utf-8"));
const byTitle = new Map(servants.map((s) => [s.title, s]));

function sv(title: string): ServantInfo {
  const s = byTitle.get(title)!;
  return toServantInfo(s);
}
function mkCe(bonus: number, traits: string[], name: string, cost = 12): CeItem {
  return { key: `x-${name}`, id: name, name, isMlb: true, cost, bonus, scope: "party", traits, label: "" };
}
function input(locked: ServantInfo[], freePool: ServantInfo[], ceItems: CeItem[]): OptimizeInput {
  return {
    costLimit: 116, ownSlots: 5, maxCes: 6, includeSupport: false,
    supportOptions: [], supportOptions2: [],
    ceItems, lockedServants: locked, freePool, autoPickFree: true,
  };
}

describe("方案列表调整", () => {
  it("不再出现 cost最佳", () => {
    const plans = optimizePlans(input([sv("阿尔托莉雅·潘德拉贡")], [sv("阿尔托莉雅·潘德拉贡〔Alter〕"), sv("阿尔托莉雅·潘德拉贡〔Lily〕"), sv("贝德维尔"), sv("高文"), sv("伊阿宋")], [mkCe(20, ["秩序·善"], "检查报告")]), true);
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.some((r) => r.isCostMax)).toBe(false);
  });

  it("有锁定时出现「锁定加成最佳」且锁定从者加成拉满", () => {
    // 合成场景: 锁定 L 只匹配 X, 4 名自由从者只匹配 Y;
    // 预算只够 1 张特性礼装 -> 智能选 Y(总加成高但 L 吃不到), 锁定方案应选 X 让 L 吃满
    const mk = (name: string, cost: number, traits: string[]): ServantInfo => ({
      name, cost, rarity: 1, attr1: "混沌", attr2: "恶", gender: "男性",
      subAttr: "地", className: "Saber", traits, extraTraits: [],
    });
    const locked = mk("锁定A", 3, ["X"]);
    const pool = ["自由1", "自由2", "自由3", "自由4"].map((n) => mk(n, 3, ["Y"]));
    const ce = (bonus: number, traits: string[], name: string): CeItem => ({
      key: `k-${name}`, id: name, name, isMlb: true, cost: 12, bonus, scope: "party", traits, label: "",
    });
    const inp: OptimizeInput = {
      costLimit: 27, ownSlots: 5, maxCes: 1, includeSupport: false,
      supportOptions: [], supportOptions2: [],
      ceItems: [ce(20, ["X"], "CE_X"), ce(20, ["Y"], "CE_Y")],
      lockedServants: [locked], freePool: pool, autoPickFree: true,
    };
    const plans = optimizePlans(inp, true);
    const lp = plans.find((r) => r.isLockedMax);
    expect(lp).toBeDefined();
    // 默认第 2 行 (紧随智能方案)
    expect(plans[1] && plans[1].isLockedMax).toBe(true);
    // 锁定槽(第 1 位)吃满 20 (选 CE_X)
    expect(lp!.slots[0].partyBonus).toBe(20);
    // 智能方案为总加成选 CE_Y, 锁定从者吃不到 (加成 0) —— 证明两个方案确实不同
    expect(plans[0].isLockedMax).toBeFalsy();
    expect(plans[0].slots[0].partyBonus).toBe(0);
    expect(plans[0].totalPct).toBe(80);
    expect(lp!.totalPct).toBe(20);
  });

  it("无锁定时不出现该方案", () => {
    const pool = [sv("阿尔托莉雅·潘德拉贡"), sv("阿尔托莉雅·潘德拉贡〔Alter〕")];
    const plans = optimizePlans(input([], pool, [mkCe(20, ["秩序·善"], "检查报告")]), true);
    expect(plans.some((r) => r.isLockedMax)).toBe(false);
  });
});
