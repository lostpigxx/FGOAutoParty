import { describe, expect, it } from "vitest";
import { knapsack, knapsackTopK, optimize, optimizeTopN, type CeItem, type OptimizeInput } from "./optimizer";
import { servantMatchesTrait, servantPassesFilters, type ServantInfo } from "./data";

function svInfo(name: string, over: Partial<ServantInfo> = {}): ServantInfo {
  return {
    name,
    cost: 3,
    rarity: 3,
    attr1: "",
    attr2: "",
    gender: "",
    subAttr: "",
    className: "",
    traits: [],
    extraTraits: [],
    ...over,
  };
}

function ce(over: Partial<CeItem> & { key: string; name: string; cost: number; bonus: number }): CeItem {
  return {
    id: over.key,
    isMlb: false,
    scope: "self",
    traits: [],
    label: `${over.name}+${over.bonus}%`,
    ...over,
  };
}

function baseInput(over: Partial<OptimizeInput> = {}): OptimizeInput {
  return {
    costLimit: 113,
    ownSlots: 6,
    includeSupport: false,
    supportOptions: [],
    ceItems: [],
    lockedServants: [],
    freePool: [],
    autoPickFree: false,
    ...over,
  };
}

describe("特性匹配", () => {
  const gil = svInfo("吉尔伽美什", { attr1: "混沌", attr2: "善", className: "Archer" });
  const art = svInfo("阿尔托莉雅", { attr1: "秩序", attr2: "善", gender: "女性", className: "Saber" });
  const emiya = svInfo("卫宫", { traits: ["FSN从者"] });
  const beast = svInfo("玉藻前", { traits: ["兽科"] });

  it("混沌且七骑士: 混沌属性 + 七骑士职阶", () => {
    expect(servantMatchesTrait(gil, "混沌且七骑士")).toBe(true);
    expect(servantMatchesTrait(art, "混沌且七骑士")).toBe(false);
  });
  it("秩序·善 / 秩序的女性", () => {
    expect(servantMatchesTrait(art, "秩序·善")).toBe(true);
    expect(servantMatchesTrait(art, "秩序的女性")).toBe(true);
    expect(servantMatchesTrait(gil, "秩序·善")).toBe(false);
  });
  it("FSN从者 与 兽科从者 别名", () => {
    expect(servantMatchesTrait(emiya, "Fate/stay night从者")).toBe(true);
    expect(servantMatchesTrait(beast, "兽科从者")).toBe(true);
  });
  it("星 (副属性)", () => {
    const star = svInfo("谜之女主角X", { subAttr: "星" });
    expect(servantMatchesTrait(star, "星")).toBe(true);
  });
  it("手动标记特性 (灵衣)", () => {
    const s = svInfo("尼禄", { extraTraits: ["持有灵衣之人"] });
    expect(servantMatchesTrait(s, "持有灵衣之人")).toBe(true);
  });
});

describe("背包算法", () => {
  it("相同 cost 不同 value 的 item 不会重复选取 (状态覆盖回归)", () => {
    const items = [
      { cost: 9, value: 20, name: "A" },
      { cost: 9, value: 100, name: "B" },
    ];
    const r = knapsack(items, 39, 6);
    expect(r.chosen.map((x) => x.name).sort()).toEqual(["A", "B"]);
    expect(r.totalValue).toBe(120);
  });

  it("满破与未满破副本是独立 item", () => {
    const items = [
      { cost: 9, value: 100, name: "mlb" },
      { cost: 12, value: 40, name: "normal" },
    ];
    const r = knapsack(items, 21, 6);
    expect(r.chosen.length).toBe(2);
  });

  it("Top-K 背包: 返回 K 个互不相同的组合", () => {
    const items = [
      { cost: 9, value: 100, name: "B" },
      { cost: 9, value: 20, name: "A" },
      { cost: 12, value: 40, name: "C" },
      { cost: 6, value: 15, name: "D" },
    ];
    const top = knapsackTopK(items, 30, 6, 3);
    expect(top.length).toBe(3);
    const sigs = new Set(top.map((t) => t.chosenIndices.join(",")));
    expect(sigs.size).toBe(3);
    for (let i = 1; i < top.length; i++) {
      expect(top[i].totalValue).toBeLessThanOrEqual(top[i - 1].totalValue);
    }
    expect(top[0].totalValue).toBe(160); // A + B + C (cost 9+9+12=30)
  });

  it("Top-N 优化: 去重、降序、top1 等于 optimize()", () => {
    const pool = [
      svInfo("混沌A", { attr1: "混沌", className: "Saber", cost: 16 }),
      svInfo("混沌B", { attr1: "混沌", className: "Archer", cost: 16 }),
      svInfo("秩序C", { attr1: "秩序", className: "Caster", cost: 3 }),
      svInfo("秩序D", { attr1: "秩序", className: "Rider", cost: 3 }),
      svInfo("秩序E", { attr1: "秩序", className: "Lancer", cost: 3 }),
      svInfo("秩序F", { attr1: "秩序", className: "Berserker", cost: 3 }),
    ];
    const input = baseInput({
      costLimit: 80,
      freePool: pool,
      autoPickFree: true,
      includeSupport: true,
      supportOptions: [
        ce({ key: "tea", name: "午茶+15%", cost: 9, bonus: 15, scope: "party", traits: [] }),
      ],
      ceItems: [
        ce({ key: "c1", name: "混沌+20%", cost: 9, bonus: 20, scope: "party", traits: ["混沌且七骑士"], isMlb: true }),
        ce({ key: "c2", name: "秩序善+20%", cost: 9, bonus: 20, scope: "party", traits: ["秩序·善"], isMlb: true }),
      ],
    });
    const top = optimizeTopN(input, 3);
    expect(top.length).toBeGreaterThanOrEqual(1);
    expect(top.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < top.length; i++) {
      expect(top[i].grandTotalPct).toBeLessThanOrEqual(top[i - 1].grandTotalPct);
    }
    expect(top[0].grandTotalPct).toBe(optimize(input).grandTotalPct);
    // 去重: 方案签名互不相同
    const sigs = new Set(top.map((r) => r.chosenCe.map((c) => c.key).sort().join("|") + "§" + (r.supportCe?.key ?? "")));
    expect(sigs.size).toBe(top.length);
  });
});

describe("从者视图筛选 (约束结果)", () => {
  it("职阶多选 = 任一符合", () => {
    const f = {
      rarity: new Set<number>(),
      classes: new Set(["Saber", "Archer"]),
      traits: new Set<string>(),
    };
    expect(servantPassesFilters(svInfo("A", { className: "Saber" }), f)).toBe(true);
    expect(servantPassesFilters(svInfo("B", { className: "Archer" }), f)).toBe(true);
    expect(servantPassesFilters(svInfo("C", { className: "Caster" }), f)).toBe(false);
  });

  it("特性多选 = 需同时满足", () => {
    const f = {
      rarity: new Set<number>(),
      classes: new Set<string>(),
      traits: new Set(["秩序·善", "秩序的女性"]),
    };
    // 阿尔托莉雅(秩序·善, 女性): 两个特性都满足
    const art = svInfo("阿尔托莉雅", { attr1: "秩序", attr2: "善", gender: "女性", className: "Saber" });
    expect(servantPassesFilters(art, f)).toBe(true);
    // 秩序·善 男性: 只满足一个
    expect(servantPassesFilters(svInfo("秩序男", { attr1: "秩序", attr2: "善", gender: "男性", className: "Saber" }), f)).toBe(false);
    // 混沌·善(吉尔伽美什): 不是秩序·善
    expect(servantPassesFilters(svInfo("吉尔伽美什", { attr1: "混沌", attr2: "善", className: "Archer" }), f)).toBe(false);
  });

  it("稀有度约束 (空 = 不限)", () => {
    const f5 = { rarity: new Set([5]), classes: new Set<string>(), traits: new Set<string>() };
    expect(servantPassesFilters(svInfo("A", { rarity: 5 }), f5)).toBe(true);
    expect(servantPassesFilters(svInfo("B", { rarity: 3 }), f5)).toBe(false);
    const fEmpty = { rarity: new Set<number>(), classes: new Set<string>(), traits: new Set<string>() };
    expect(servantPassesFilters(svInfo("B", { rarity: 1 }), fEmpty)).toBe(true);
  });
});

describe("优化器基础", () => {
  it("无礼装: 6 名最低 cost 从者, 总 cost=18", () => {
    const pool = Array.from({ length: 10 }, (_, i) => svInfo(`从者${i}`, { cost: 3 }));
    const r = optimize(baseInput({ freePool: pool }));
    expect(r.feasible).toBe(true);
    expect(r.servantCost).toBe(18);
    expect(r.totalCost).toBe(18);
    expect(r.totalPct).toBe(0);
  });

  it("自身礼装: 只加 1 名从者", () => {
    const pool = Array.from({ length: 6 }, (_, i) => svInfo(`从者${i}`, { cost: 3 }));
    const r = optimize(
      baseInput({
        freePool: pool,
        ceItems: [ce({ key: "a", name: "自身+2%", cost: 9, bonus: 2, scope: "self" })],
      }),
    );
    expect(r.feasible).toBe(true);
    expect(r.selfBonus).toBe(2);
    expect(r.totalPct).toBe(2);
    expect(r.totalCost).toBe(18 + 9);
  });

  it("无条件全体礼装: 加成 ×6", () => {
    const pool = Array.from({ length: 6 }, (_, i) => svInfo(`从者${i}`, { cost: 3 }));
    const r = optimize(
      baseInput({
        freePool: pool,
        ceItems: [ce({ key: "b", name: "全体+5%", cost: 9, bonus: 5, scope: "party", traits: [] })],
      }),
    );
    expect(r.totalPct).toBe(30);
  });

  it("特性全体礼装: 只加符合特性的从者", () => {
    const party = [
      svInfo("混沌A", { attr1: "混沌", className: "Saber" }),
      svInfo("混沌B", { attr1: "混沌", className: "Archer" }),
      svInfo("秩序C", { attr1: "秩序", className: "Caster" }),
    ];
    const pool = [
      ...party,
      svInfo("秩序D", { attr1: "秩序", className: "Rider" }),
      svInfo("秩序E", { attr1: "秩序", className: "Lancer" }),
      svInfo("秩序F", { attr1: "秩序", className: "Berserker" }),
    ];
    const r = optimize(
      baseInput({
        freePool: pool,
        ceItems: [ce({ key: "c", name: "混沌且七骑士+20%", cost: 9, bonus: 20, scope: "party", traits: ["混沌且七骑士"], isMlb: true })],
      }),
    );
    // 6 人中 2 人符合 → 40
    expect(r.totalPct).toBe(40);
  });

  it("好友助战不计入 Cost (回归)", () => {
    const pool = Array.from({ length: 6 }, (_, i) => svInfo(`从者${i}`, { cost: 3 }));
    const tea = ce({ key: "tea", name: "午茶+15%", cost: 9, bonus: 15, scope: "party", traits: [] });
    const r = optimize(
      baseInput({
        costLimit: 30, // 只够 6 名从者(18) + 少量自己礼装
        includeSupport: true,
        supportOptions: [tea], // 助战礼装 cost 9 (不应计入)
        freePool: pool,
      }),
    );
    expect(r.feasible).toBe(true);
    expect(r.totalCost).toBe(18); // 自己的 cost 仅 6×3
    expect(r.supportCe?.key).toBe("tea");
    expect(r.totalPct).toBe(90);
  });

  it("cost 不足时报错", () => {
    const r = optimize(
      baseInput({
        costLimit: 10,
        freePool: Array.from({ length: 6 }, (_, i) => svInfo(`从者${i}`, { cost: 3 })),
      }),
    );
    expect(r.feasible).toBe(false);
  });

  it("助战位: 满破午茶时光 +15% 全队", () => {
    const pool = Array.from({ length: 6 }, (_, i) => svInfo(`从者${i}`, { cost: 3 }));
    const teaTime = ce({ key: "tea", name: "助战+15%", cost: 9, bonus: 15, scope: "party", traits: [] });
    const r = optimize(
      baseInput({
        includeSupport: true,
        supportOptions: [teaTime],
        freePool: pool,
      }),
    );
    expect(r.feasible).toBe(true);
    expect(r.supportCe?.key).toBe("tea");
    expect(r.totalPct).toBe(90);
  });

  it("自动选从者: 优先选符合特性的从者", () => {
    const pool = [
      svInfo("混沌A", { attr1: "混沌", className: "Saber", cost: 16 }),
      svInfo("混沌B", { attr1: "混沌", className: "Archer", cost: 16 }),
      svInfo("秩序C", { attr1: "秩序", className: "Caster", cost: 3 }),
      svInfo("秩序D", { attr1: "秩序", className: "Rider", cost: 3 }),
      svInfo("秩序E", { attr1: "秩序", className: "Lancer", cost: 3 }),
      svInfo("秩序F", { attr1: "秩序", className: "Berserker", cost: 3 }),
    ];
    const r = optimize(
      baseInput({
        costLimit: 60,
        freePool: pool,
        autoPickFree: true,
        ceItems: [ce({ key: "c", name: "混沌且七骑士+20%", cost: 9, bonus: 20, scope: "party", traits: ["混沌且七骑士"], isMlb: true })],
      }),
    );
    expect(r.feasible).toBe(true);
    // 应尽量带上 2 名混沌从者
    const chaotic = r.slots.filter((s) => s.servant!.attr1 === "混沌").length;
    expect(chaotic).toBeGreaterThanOrEqual(1);
  });
});
