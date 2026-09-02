// 导出配置落盘: 写入 <root>/settings/ 目录
// 供 server.mjs (发布版) 与 vite.config.ts (开发版) 共用
import path from "node:path";
import { promises as fs } from "node:fs";

const MAX_BODY = 2_000_000;

/** @param {string} root 项目根目录
 *  @param {string} body 请求体 (JSON: { filename, content })
 *  @returns {Promise<{ok: boolean, path?: string, error?: string}>} */
export async function saveConfigFile(root, body) {
  try {
    const raw = JSON.parse(body);
    const content = String(raw?.content ?? "");
    if (!content || content.length > MAX_BODY) {
      return { ok: false, error: "配置内容为空或过大" };
    }
    let name = String(raw?.filename ?? "").trim();
    // 只取文件名部分并剔除非法字符, 防目录穿越
    name = path
      .basename(name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim();
    if (!name) name = "fgo-bond-config.json";
    if (!/\.json$/i.test(name)) name += ".json";

    const dir = path.join(root, "settings");
    const file = path.join(dir, name);
    if (!path.resolve(file).startsWith(path.resolve(dir) + path.sep)) {
      return { ok: false, error: "非法文件名" };
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, content, "utf-8");
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
