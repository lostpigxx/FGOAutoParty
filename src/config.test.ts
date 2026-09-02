import { describe, expect, it } from "vitest";
import {
  buildConfig,
  decodeConfig,
  encodeConfig,
  parseConfig,
  type ConfigInput,
} from "./config";

function baseInput(): ConfigInput {
  const allTitles = new Set(["吉尔伽美什", "阿尔托莉雅", "玛修", "卫宫", "玉藻前"]);
  return {
    settings: {
      costLimit: 113,
      ownSlots: 6,
      includeSupport: true,
      supportMode: "auto",
      autoPickFree: true,
      ceOnly5: true,
      classFilter: ["Berserker"],
      traitFilter: ["混沌且七骑士"],
      rarityFilter: [1, 2, 3, 4, 5],
    },
    ownedCes: new Map([
      ["2509", true],
      ["2052", false],
    ]),
    ownedSv: new Set(["吉尔伽美什", "阿尔托莉雅", "玛修"]),
    allTitles,
    locked: ["玛修"],
    costumeOffTitles: ["玉藻前"],
  };
}

describe("配置持久化", () => {
  it("build -> parse 往返一致", () => {
    const input = baseInput();
    const cfg = buildConfig(input);
    expect(cfg.v).toBe(2);
    const parsed = parseConfig(JSON.stringify(cfg), new Set(["2509", "2052"]), input.allTitles)!;

    expect(parsed.settings.costLimit).toBe(113);
    expect(parsed.settings.supportMode).toBe("auto");
    expect(parsed.settings.classFilter).toEqual(["Berserker"]);
    expect(parsed.settings.traitFilter).toEqual(["混沌且七骑士"]);
    expect(parsed.ownedCeIds.get("2509")).toBe(true);
    expect(parsed.ownedCeIds.get("2052")).toBe(false);
    expect(parsed.ownedSv).toEqual(new Set(["吉尔伽美什", "阿尔托莉雅", "玛修"]));
    expect(parsed.locked).toEqual(["玛修"]);
    expect(parsed.costumesOff).toEqual(["玉藻前"]);
  });

  it("从者只存较小一侧 (unowned)", () => {
    const input = baseInput();
    input.ownedSv = new Set(["吉尔伽美什", "阿尔托莉雅", "玛修", "卫宫"]); // 持有 4 名 -> 存 unowned(1名)
    const cfg = buildConfig(input);
    expect(cfg.svMode).toBe("unowned");
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    expect(parsed.ownedSv).toEqual(new Set(["吉尔伽美什", "阿尔托莉雅", "玛修", "卫宫"]));
  });

  it("锁定/灵衣反选的从者不受持有强制", () => {
    // 只有锁定强制视为持有; 灵衣反选不影响持有
    const input = baseInput();
    input.ownedSv = new Set(["阿尔托莉雅"]);
    const parsed = parseConfig(JSON.stringify(buildConfig(input)), new Set(), input.allTitles)!;
    expect(parsed.ownedSv.has("玛修")).toBe(true); // locked
    expect(parsed.ownedSv.has("玉藻前")).toBe(false); // costumeOff 不影响
  });

  it("容错: 不存在的礼装/从者被跳过, 非法 JSON 返回 null", () => {
    const input = baseInput();
    const cfg = buildConfig(input);
    const parsed = parseConfig(
      JSON.stringify({
        ...cfg,
        ownedCes: [["不存在的id", true]],
        svList: ["不存在的人"],
      }),
      new Set(["2509", "2052"]),
      input.allTitles,
    )!;
    expect(parsed.ownedCeIds.has("不存在的id")).toBe(false);
    expect([...parsed.ownedSv].some((t) => t.includes("不存在"))).toBe(false);
    expect(parseConfig("not json", new Set(), input.allTitles)).toBeNull();
    expect(parseConfig(JSON.stringify({ v: 99 }), new Set(), input.allTitles)).toBeNull();
  });

  it("设置值钳制", () => {
    const input = baseInput();
    const cfg = JSON.parse(JSON.stringify(buildConfig(input)));
    cfg.settings.costLimit = 99999;
    cfg.settings.ownSlots = 0;
    cfg.settings.rarityFilter = [1, 99, "x", 3];
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    expect(parsed.settings.costLimit).toBe(999);
    expect(parsed.settings.ownSlots).toBe(1);
    expect(parsed.settings.rarityFilter).toEqual([1, 3]);
  });

  it("缺字段时取默认: 筛选空/稀有度全选/ceOnly5", () => {
    const input = baseInput();
    const cfg = JSON.parse(JSON.stringify(buildConfig(input)));
    delete cfg.settings.ceOnly5;
    delete cfg.settings.classFilter;
    delete cfg.settings.traitFilter;
    delete cfg.settings.rarityFilter;
    const parsed = parseConfig(JSON.stringify(cfg), new Set(), input.allTitles)!;
    expect(parsed.settings.ceOnly5).toBe(true);
    expect(parsed.settings.classFilter).toEqual([]);
    expect(parsed.settings.traitFilter).toEqual([]);
    expect(parsed.settings.rarityFilter).toEqual([1, 2, 3, 4, 5]);
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
