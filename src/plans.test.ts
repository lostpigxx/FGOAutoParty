// 方案列表: cost最佳 已移除; 新增 锁定加成最佳
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBondCatalog, toCeItems, toServantInfo, type ServantInfo } from "./data";
import { optimizePlans, type CeItem, type OptimizeInput } from "./optimizer";
import type { Ce, Servant } from "./types";

const ces: Ce[] = JSON.parse(readFileSync("public/data/ces.json", "utf-8"));
const servants: Servant[] = JSON.parse(readFileSync("public/data/servants.json", "utf-8"));
const catalog = buildBondCatalog(ces);
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
    const locked = sv("阿尔托莉雅·潘德拉贡"); // 秩序·善
    const pool = [sv("阿尔托莉雅·潘德拉贡〔Alter〕"), sv("阿尔托莉雅·潘德拉贡〔Lily〕"), sv("贝德维尔"), sv("高文"), sv("伊阿宋"), sv("兰斯洛特(Saber)"), sv("亚瑟·潘德拉贡〔Prototype〕")];
    const plans = optimizePlans(input([locked], pool, [mkCe(20, ["秩序·善"], "检查报告"), mkCe(5, [], "名侦探")]), true);
    const lp = plans.find((r) => r.isLockedMax);
    expect(lp).toBeDefined();
    // 锁定槽(第 1 位)加成应 ≥ 20 (检查报告命中 秩序·善)
    expect(lp!.slots[0].partyBonus).toBeGreaterThanOrEqual(20);
    // 与智能方案相比, 锁定加成不差
    expect(lp!.slots[0].partyBonus).toBeGreaterThanOrEqual(plans[0].slots[0].partyBonus);
  });

  it("无锁定时不出现该方案", () => {
    const pool = [sv("阿尔托莉雅·潘德拉贡"), sv("阿尔托莉雅·潘德拉贡〔Alter〕")];
    const plans = optimizePlans(input([], pool, [mkCe(20, ["秩序·善"], "检查报告")]), true);
    expect(plans.some((r) => r.isLockedMax)).toBe(false);
  });
});
