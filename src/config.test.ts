import { describe, expect, it } from "vitest";
import {
  buildConfig,
  decodeConfig,
  encodeConfig,
  parseConfig,
  type ConfigInput,
  type PersistedConfig,
} from "./config";

function baseInput(): ConfigInput {
  const allTitles = new Set(["吉尔伽美什", "阿尔托莉雅", "玛修", "卫宫", "玉藻前"]);
  return {
    settings: {
      costLimit: 113,
      ownSlots: 6,
      includeSupport: true,
      supportRarity: 4,
      supportMode: "auto",
      autoPickFree: true,
      ceOnly5: true,
      classFilter: ["Berserker"],
      traitFilter: ["混沌且七骑士"],
      rarityFilter: [1, 2, 3, 4, 5],
    },
    ownedCes: new Map([["2509", { count: 1, mlbCount: 1 }]]),
    ownedSv: new Set(["吉尔伽美什", "阿尔托莉雅", "玛修"]),
    allTitles,
    locked: ["玛修"],
    costumeTitles: ["玉藻前"],
  };
}

describe("配置持久化", () => {
  it("build -> parse 往返一致", () => {
    const input = baseInput();
    const cfg = buildConfig(input);
    const json = JSON.stringify(cfg);
    const parsed = parseConfig(json, new Set(["2509"]), input.allTitles)!;

    expect(parsed.settings.costLimit).toBe(113);
    expect(parsed.settings.supportMode).toBe("auto");
    expect(parsed.ownedCeIds.get("2509")).toEqual({ count: 1, mlbCount: 1 });
    // 灵衣(玉藻前)强制视为持有
    expect(parsed.ownedSv).toEqual(new Set(["吉尔伽美什", "阿尔托莉雅", "玛修", "玉藻前"]));
    expect(parsed.locked).toEqual(["玛修"]);
    expect(parsed.costumeTitles).toEqual(["玉藻前"]);
  });

  it("从者只存较小一侧 (unowned)", () => {
    const input = baseInput();
    input.ownedSv = new Set(["吉尔伽美什", "阿尔托莉雅", "玛修", "卫宫"]); // 持有 4 名 -> 存 unowned(1名)
    const cfg = buildConfig(input);
    expect(cfg.svMode).toBe("unowned");
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    // unowned 侧为 玉藻前 -> 恢复后全持有, 且玉藻前因灵衣强制持有
    expect(parsed.ownedSv).toEqual(new Set(["吉尔伽美什", "阿尔托莉雅", "玛修", "卫宫", "玉藻前"]));
  });

  it("锁定/灵衣的从者强制视为持有", () => {
    const input = baseInput();
    input.ownedSv = new Set(); // 一个都没勾
    const cfg = buildConfig(input);
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    expect(parsed.ownedSv.has("玛修")).toBe(true); // locked
    expect(parsed.ownedSv.has("玉藻前")).toBe(true); // costume
  });

  it("容错: 不存在的礼装/从者被跳过, 非法 JSON 返回 null", () => {
    const input = baseInput();
    const cfg = buildConfig(input);
    const parsed = parseConfig(
      JSON.stringify({ ...cfg, ownedCes: [["不存在的id", { count: 1, mlbCount: 0 }]], svList: ["不存在的人"] }),
      new Set(["2509"]),
      input.allTitles,
    )!;
    expect(parsed.ownedCeIds.has("不存在的id")).toBe(false);
    expect([...parsed.ownedSv].some((t) => t.includes("不存在"))).toBe(false);
    expect(parseConfig("not json", new Set(), input.allTitles)).toBeNull();
    expect(parseConfig(JSON.stringify({ v: 99 }), new Set(), input.allTitles)).toBeNull();
  });

  it("设置值钳制", () => {
    const input = baseInput();
    const cfg: PersistedConfig = {
      ...buildConfig(input),
      settings: { ...buildConfig(input).settings, costLimit: 99999, ownSlots: 0, supportRarity: 9 },
    };
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    expect(parsed.settings.costLimit).toBe(999);
    expect(parsed.settings.ownSlots).toBe(1);
    expect(parsed.settings.supportRarity).toBe(4);
  });

  it("旧配置缺 ceOnly5 时默认只看5★", () => {
    const input = baseInput();
    const legacy = JSON.parse(JSON.stringify(buildConfig(input)));
    delete legacy.settings.ceOnly5;
    const parsed = parseConfig(JSON.stringify(legacy), new Set(), input.allTitles)!;
    expect(parsed.settings.ceOnly5).toBe(true);
  });

  it("筛选选择往返一致 (职阶/特性/稀有度)", () => {
    const input = baseInput();
    const cfg = buildConfig(input);
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    expect(parsed.settings.classFilter).toEqual(["Berserker"]);
    expect(parsed.settings.traitFilter).toEqual(["混沌且七骑士"]);
    expect(parsed.settings.rarityFilter).toEqual([1, 2, 3, 4, 5]);
  });

  it("旧配置缺筛选字段时默认: 职阶/特性空, 稀有度全选", () => {
    const input = baseInput();
    const legacy = JSON.parse(JSON.stringify(buildConfig(input)));
    delete legacy.settings.classFilter;
    delete legacy.settings.traitFilter;
    delete legacy.settings.rarityFilter;
    const parsed = parseConfig(JSON.stringify(legacy), new Set(), input.allTitles)!;
    expect(parsed.settings.classFilter).toEqual([]);
    expect(parsed.settings.traitFilter).toEqual([]);
    expect(parsed.settings.rarityFilter).toEqual([1, 2, 3, 4, 5]);
  });

  it("筛选字段容错: 非法值被过滤", () => {
    const input = baseInput();
    const cfg = JSON.parse(JSON.stringify(buildConfig(input)));
    cfg.settings.classFilter = ["Berserker", 123];
    cfg.settings.rarityFilter = [1, 99, "x", 3];
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    expect(parsed.settings.classFilter).toEqual(["Berserker"]);
    expect(parsed.settings.rarityFilter).toEqual([1, 3]);
  });
});

describe("URL 压缩", () => {
  it("中文 JSON 压缩往返一致", () => {
    const input = baseInput();
    const json = JSON.stringify(buildConfig(input));
    const enc = encodeConfig(json);
    expect(enc).not.toContain("+");
    expect(enc).not.toContain("/");
    expect(enc).not.toContain("=");
    expect(decodeConfig(enc)).toBe(json);
  });

  it("压缩后比 URL-encode 更短", () => {
    const input = baseInput();
    const json = JSON.stringify(buildConfig(input));
    const enc = encodeConfig(json);
    const urlen = encodeURIComponent(json);
    expect(enc.length).toBeLessThan(urlen.length);
  });
});
