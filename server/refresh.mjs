// 数据刷新与状态查询 (Node 零依赖, 供 vite 插件与独立 server.mjs 共用)
import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

// 锁文件: 防止服务器重启后 running 标志丢失导致并发抓取
function lockPath(projectRoot) {
  return path.join(projectRoot, "data", ".refresh.lock");
}

function isProcessAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // 存在但无权限
  }
}

function acquireLock(projectRoot) {
  const lp = lockPath(projectRoot);
  try {
    const pid = Number(readFileSync(lp, "utf-8"));
    if (isProcessAlive(pid)) return false;
    unlinkSync(lp); // 残留锁, 清理
  } catch {
    /* 无锁文件 */
  }
  writeFileSync(lp, String(process.pid));
  return true;
}

function releaseLock(projectRoot) {
  try {
    unlinkSync(lockPath(projectRoot));
  } catch {
    /* ignore */
  }
}

/**
 * 运行 Mooncell 爬虫并同步到 public/data/ 与 dist/data/。
 * 返回 { ok, log?, error?, running? }
 */
export async function refreshData(projectRoot) {
  if (!acquireLock(projectRoot)) {
    return { ok: false, error: "已有更新任务正在运行，请稍候", running: true };
  }
  try {
    const stdout = await new Promise((resolve, reject) => {
      const proc = spawn("python3", ["scraper/fetch_mooncell.py"], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let errOut = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.stderr.on("data", (d) => (errOut += d));
      const timer = setTimeout(() => proc.kill("SIGKILL"), 10 * 60 * 1000);
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(String(e.message || e)));
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error((errOut || "退出码 " + code).slice(-2000)));
      });
    });
    // 爬虫已把结果写入 data/ 与 public/data/; 若存在 dist/ 则同步
    for (const f of ["ces.json", "servants.json"]) {
      const distData = path.join(projectRoot, "dist", "data");
      if (existsSync(distData)) {
        copyFileSync(path.join(projectRoot, "data", f), path.join(distData, f));
      }
    }
    return { ok: true, log: stdout.slice(-2000) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(-2000) };
  } finally {
    releaseLock(projectRoot);
  }
}

/** 返回本地数据文件的状态 (大小 / 修改时间) */
export async function dataStatus(projectRoot) {
  const read = async (f) => {
    try {
      const st = await fs.stat(path.join(projectRoot, "data", f));
      return { size: st.size, mtime: st.mtime.toISOString() };
    } catch {
      return null;
    }
  };
  return {
    ces: await read("ces.json"),
    servants: await read("servants.json"),
  };
}
