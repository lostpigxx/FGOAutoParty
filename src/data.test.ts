// 数据层基础回归: 从者 cost 表 (真实 FGO 数值, 防再次拍脑袋)
import { describe, expect, it } from "vitest";
import { servantCostByRarity } from "./data";

describe("从者 cost 表 (真实 FGO 数值)", () => {
  it("1★=3 / 2★=4 / 3★=7 / 4★=12 / 5★=16", () => {
    expect([1, 2, 3, 4, 5].map((r) => servantCostByRarity(r))).toEqual([3, 4, 7, 12, 16]);
  });
});
