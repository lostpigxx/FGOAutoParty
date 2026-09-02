// 战斗形象形态: 数据快照 / 匹配 / 优化器防高估
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bestFormForCes,
  buildBondCatalog,
  servantMatchesAnyForm,
  svSnapshots,
  toCeItems,
  toServantInfo,
  type ServantInfo,
} from "./data";
import { optimizePlans, type CeItem, type OptimizeInput } from "./optimizer";
import type { Ce, Servant } from "./types";

const ces: Ce[] = JSON.parse(readFileSync("public/data/ces.json", "utf-8"));
const servants: Servant[] = JSON.parse(readFileSync("public/data/servants.json", "utf-8"));
const catalog = buildBondCatalog(ces);

function findSv(title: string): Servant {
  const s = servants.find((x) => x.title === title)!;
  return s;
}

function mkCe(id: string, bonus: number, traits: string[], name = id): CeItem {
  return { key: `${id}#mlb`, id, name, isMlb: true, cost: 12, bonus, scope: "party", traits, label: "" };
}

const OLGA = "U－奥尔加玛丽";

describe("形态数据", () => {
  it("U-奥尔加玛丽: 基准=形象1, 形态齐全", () => {
    const info = toServantInfo(findSv(OLGA));
    expect(info.forms?.length).toBeGreaterThanOrEqual(4);
    // 基准 = 形象1 (恶/星)
    expect(info.attr2).toBe("恶");
    expect(info.subAttr).toBe("星");
    expect(info.traits).toContain("超巨大");
    expect(info.traits).not.toContain("活在当下的人类");
    const snaps = svSnapshots(info);
    // 形象3: 善/人 + 活在当下的人类
    const f3 = snaps.find((_, i) => info.forms![i].key === "形象3")!;
    expect(f3.attr2).toBe("善");
    expect(f3.subAttr).toBe("人");
    expect(f3.traits).toContain("活在当下的人类");
    // 任意形态匹配: 活在当下的人类 / 秩序·善 (形象3) 都能对上
    expect(servantMatchesAnyForm(info, "活在当下的人类")).toBe(true);
    expect(servantMatchesAnyForm(info, "秩序·善")).toBe(true);
    expect(servantMatchesAnyForm(info, "星")).toBe(true); // 形象1/2
  });

  it("灵衣形态 = 形象1 特性集", () => {
    const info = toServantInfo(findSv(OLGA));
    const c136 = svSnapshots(info).find((_, i) => info.forms![i].key === "灵衣136")!;
    expect(c136.attr2).toBe("恶");
    expect(c136.traits).toContain("超巨大");
    expect(c136.traits).not.toContain("活在当下的人类");
  });
});

describe("优化器: 形态精确计算 (防双 20% 高估)", () => {
  function baseInput(locked: ServantInfo[], ceItems: CeItem[]): OptimizeInput {
    return {
      costLimit: 60,
      ownSlots: 1,
      maxCes: 2, // 1 付费 + 1 免费
      includeSupport: false,
      supportOptions: [],
      supportOptions2: [],
      ceItems,
      lockedServants: locked,
      freePool: [],
      autoPickFree: true,
    };
  }
  function run(locked: ServantInfo[], ceItems: CeItem[]) {
    const plans = optimizePlans(baseInput(locked, ceItems), true);
    const best = plans[0];
    expect(best.feasible).toBe(true);
    return best;
  }

  it("异星之神(星/恶) + 迦勒底之晨(活在当下): 只能吃到一张, 不能 40%", () => {
    const info = toServantInfo(findSv(OLGA));
    const best = run([info], [
      mkCe("a", 20, ["星", "恶"], "异星之神"),
      mkCe("b", 20, ["活在当下的人类"], "迦勒底之晨"),
    ]);
    // 形象1 命中异星, 形象3 命中迦勒底之晨 —— 同一位从者只能选一个形象 → 总加成 20
    expect(best.totalPct).toBe(20);
    expect(best.slots[0].partyBonus).toBe(20);
    expect(best.slots[0].formKey).toBeTruthy();
  });

  it("检查报告(秩序·善) + 异星之神(星/恶): 同样只能吃一张", () => {
    const info = toServantInfo(findSv(OLGA));
    const best = run([info], [
      mkCe("c", 20, ["秩序·善"], "检查报告"),
      mkCe("d", 20, ["星", "恶"], "异星之神"),
    ]);
    expect(best.totalPct).toBe(20);
    expect(best.slots[0].partyBonus).toBe(20);
  });

  it("迦勒底之晨(活在当下的人类) 单独: 形象3 命中 → +20", () => {
    const info = toServantInfo(findSv(OLGA));
    const best = run([info], [mkCe("e", 20, ["活在当下的人类"], "迦勒底之晨")]);
    expect(best.totalPct).toBe(20);
    expect(best.slots[0].formLabel).toBe("战斗形象3");
  });

  it("无形态从者 (摩根) 行为不变: 秩序·善礼装 +0", () => {
    const info = toServantInfo(findSv("摩根"));
    expect(info.forms).toBeUndefined();
    const best = run([info], [mkCe("f", 20, ["秩序·善"], "检查报告")]);
    expect(best.totalPct).toBe(0);
  });
});

describe("bestFormForCes 语义", () => {
  it("按礼装组选形态, 组不同选不同", () => {
    const info = toServantInfo(findSv(OLGA));
    const r1 = bestFormForCes(info, [mkCe("g", 20, ["星", "恶"])]); // 形象1/2
    expect(r1.formKey).toBe("形象1");
    const r2 = bestFormForCes(info, [mkCe("h", 20, ["活在当下的人类"])]); // 形象3
    expect(r2.formKey).toBe("形象3");
  });
});

describe("真实目录内构造 sanity", () => {
  it("catalog 能找到 异星之神/迦勒底之晨", () => {
    const catById = new Map(catalog.map((c) => [c.id, c]));
    expect(catById.get("2437")?.traits).toContain("星");
    expect(catById.get("2020")?.traits).toContain("活在当下的人类");
    // toCeItems 通路不炸
    const owned = [{ catalog: catById.get("2437")!, mlb: true }];
    expect(toCeItems(owned).length).toBe(1);
  });
});
