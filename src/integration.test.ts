// 集成测试: 用真实爬取数据跑完整管线 (加载 -> 目录 -> 优化)
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBondCatalog, servantMatchesTrait, supportCeOptions, toCeItems, toServantInfo, traitText } from "./data";
import { optimize } from "./optimizer";
import type { Ce, Servant } from "./types";

function loadData() {
  const ces: Ce[] = JSON.parse(readFileSync("public/data/ces.json", "utf-8"));
  const servants: Servant[] = JSON.parse(readFileSync("public/data/servants.json", "utf-8"));
  return { ces, servants };
}

describe("真实数据管线", () => {
  const { ces, servants } = loadData();

  it("数据已加载", () => {
    expect(ces.length).toBeGreaterThan(2000);
    expect(servants.length).toBeGreaterThan(400);
  });

  it("羁绊礼装目录: 包含 20% 特性礼装与助战午茶", () => {
    const catalog = buildBondCatalog(ces);
    const chaldean = catalog.find((c) => c.name === "迦勒底之人");
    expect(chaldean).toBeDefined();
    expect(chaldean!.mlb?.bonus).toBe(20);
    expect(chaldean!.traits).toContain("混沌且七骑士");

    const tea = catalog.find((c) => c.name === "迦勒底午茶时光");
    expect(tea).toBeDefined();
    expect(tea!.supportMlb).toBe(15);
    expect(traitText(tea!.traits)).toBe("无条件");
  });

  it("满破不改变 cost: 5★ 礼装恒为 12 (回归)", () => {
    const catalog = buildBondCatalog(ces);
    const chaldean = catalog.find((c) => c.name === "迦勒底之人")!;
    expect(chaldean.cost).toBe(12);
    // 满破与未满破副本 cost 相同
    const items = toCeItems([{ catalog: chaldean, mlb: true }, { catalog: chaldean, mlb: false }]);
    expect(items.length).toBe(2);
    const costs = new Set(items.map((i) => i.cost));
    expect(costs.size).toBe(1);
    expect([...costs][0]).toBe(12);
    // 助战选项 cost 也是 12
    const opt = supportCeOptions(catalog).find((o) => o.name === "迦勒底之人");
    expect(opt?.cost).toBe(12);
  });

  it("助战选项: 仅 5★ 且仅满破", () => {
    const catalog = buildBondCatalog(ces);
    const opts = supportCeOptions(catalog);
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      const cat = catalog.find((c) => c.id === o.id)!;
      expect(cat.rarity).toBe(5);
      expect(o.isMlb).toBe(true);
    }
    const tea = opts.find((o) => o.name === "迦勒底午茶时光");
    expect(tea?.bonus).toBe(15);
    // 无 4★ (英灵逢魔/英灵极点) 与未满破版本
    expect(opts.some((o) => o.name.includes("英灵逢魔") || o.name.includes("英灵极点"))).toBe(false);
    expect(opts.some((o) => o.key.endsWith("#n"))).toBe(false);
  });

  it("助战选项包含 满破午茶 +15%", () => {
    const catalog = buildBondCatalog(ces);
    const opts = supportCeOptions(catalog);
    const tea = opts.find((o) => o.name === "迦勒底午茶时光" && o.isMlb);
    expect(tea?.bonus).toBe(15);
    expect(tea?.scope).toBe("party");
  });

  it("全持有场景: 满破20%特性礼装 + 午茶助战 时, 优化器给出高加成", () => {
    const catalog = buildBondCatalog(ces);
    const servantsByTitle = new Map(servants.map((s) => [s.title, s]));
    const gil = toServantInfo(servantsByTitle.get("吉尔伽美什")!); // 混沌·善 Archer -> 混沌且七骑士
    const art = toServantInfo(servantsByTitle.get("阿尔托莉雅·潘德拉贡")!); // 秩序·善 Saber 女性
    const mash = toServantInfo(servantsByTitle.get("玛修·基列莱特")!); // 秩序·善 Shielder
    expect(gil.attr1).toBe("混沌");

    // 持有: 1 张满破迦勒底之人 + 1 张满破检查报告 + 借满破午茶
    const ownedCes = catalog
      .filter((c) => ["迦勒底之人", "检查报告"].includes(c.name))
      .map((c) => ({ catalog: c, mlb: true }));

    const r = optimize({
      costLimit: 113,
      ownSlots: 6,
      maxCes: 6,
      includeSupport: true,
      supportOptions: supportCeOptions(catalog),
      ceItems: toCeItems(ownedCes),
      lockedServants: [gil, art, mash],
      freePool: servants
        .map(toServantInfo)
        .filter((s) => !["吉尔伽美什", "阿尔托莉雅·潘德拉贡", "玛修·基列莱特"].includes(s.name)),
      autoPickFree: true,
    });

    expect(r.feasible).toBe(true);
    // 迦勒底之人(20% 混沌且七骑士): 至少覆盖锁定中的吉尔伽美什
    // 检查报告(20% 秩序·善): 覆盖阿尔托莉雅/玛修等
    // 助战位自动选最优 (午茶15%全队 或 特性礼装)
    expect(r.grandTotalPct).toBeGreaterThan(600 + 20 + 40 + 90);
    expect(r.totalCost).toBeLessThanOrEqual(113);
    // 助战位自动选择了某张加成礼装
    expect(r.supportCe).not.toBeNull();
    // 大部分槽位吃到全队礼装加成 (预算紧时可能有一名低星补位从者不匹配特性)
    expect(r.slots.filter((s) => s.partyBonus > 0).length).toBeGreaterThanOrEqual(4);
    // 两张 20% 礼装都被选中, 且不重复 (回归: 背包状态覆盖 bug)
    const picked20 = r.chosenCe.filter((c) => c.bonus === 20);
    expect(picked20.length).toBe(2);
    expect(new Set(picked20.map((c) => c.key)).size).toBe(2);
  });

  it("至诚的一针(持有灵衣之人) 只覆盖手动标记的从者", () => {
    const catalog = buildBondCatalog(ces);
    const needlestitch = catalog.find((c) => c.name === "至诚的一针");
    expect(needlestitch?.traits).toContain("持有灵衣之人");
  });

  it("有灵衣的从者: 数据标记 + 勾选/反选决定特性", () => {
    const byTitle = new Map(servants.map((s) => [s.title, s]));
    const artRaw = byTitle.get("阿尔托莉雅·潘德拉贡")!; // 有灵衣
    const gilRaw = byTitle.get("吉尔伽美什")!; // 无灵衣
    expect(artRaw.hasCostume).toBe(true);
    expect(gilRaw.hasCostume ?? false).toBe(false);
    // 勾上(默认) → 拥有「持有灵衣之人」特性; 反选 → 没有
    const artOn = { ...toServantInfo(artRaw), extraTraits: ["持有灵衣之人"] };
    const artOff = { ...toServantInfo(artRaw), extraTraits: [] };
    expect(servantMatchesTrait(artOn, "持有灵衣之人")).toBe(true);
    expect(servantMatchesTrait(artOff, "持有灵衣之人")).toBe(false);
  });
});
