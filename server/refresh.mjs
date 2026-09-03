// 数据刷新与状态查询 (Node 零依赖, 供 vite 插件与独立 server.mjs 共用)
import { execFile, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

/** 探测可用的 python 命令 (Windows 为 python, 其余为 python3; 都有则优先 python3) */
function findPython() {
  const candidates = ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ["--version"], { timeout: 5000 });
      if (r.error) continue;
      if (r.status === 0) return cmd;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
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
    const py = findPython();
    if (!py) {
      return {
        ok: false,
        error: "未检测到 Python 3（一键更新数据需要 Python）。当前数据为打包快照，可直接使用；如需最新数据请安装 Python 后重试。",
      };
    }
    const stdout = await new Promise((resolve, reject) => {
      const proc = spawn(py, ["scraper/fetch_mooncell.py"], {
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
    const distData = path.join(projectRoot, "dist", "data");
    if (existsSync(distData)) {
      for (const f of ["ces.json", "servants.json"]) {
        copyFileSync(path.join(projectRoot, "data", f), path.join(distData, f));
      }
      // 图片目录 (爬虫下载: 礼装卡面 ce-img / 从者头像 sv-avatar; 缺失文件静默跳过)
      for (const sub of ["ce-img", "sv-avatar"]) {
        const imgSrc = path.join(projectRoot, "data", sub);
        if (!existsSync(imgSrc)) continue;
        const imgDst = path.join(distData, sub);
        mkdirSync(imgDst, { recursive: true });
        for (const f of readdirSync(imgSrc)) {
          try {
            copyFileSync(path.join(imgSrc, f), path.join(imgDst, f));
          } catch {
            /* 单个文件失败不影响整体 */
          }
        }
      }
    }
    return { ok: true, log: stdout.slice(-2000) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(-2000) };
  } finally {
    releaseLock(projectRoot);
  }
}

/** 返回本地数据文件的状态 (大小 / 修改时间); data/ 缺失时回退到 dist/data (发布快照) */
export async function dataStatus(projectRoot) {
  const read = async (f) => {
    for (const dir of ["data", path.join("dist", "data")]) {
      try {
        const st = await fs.stat(path.join(projectRoot, dir, f));
        return { size: st.size, mtime: st.mtime.toISOString() };
      } catch {
        /* 尝试下一个目录 */
      }
    }
    return null;
  };
  // 图片目录总大小/张数 (礼装卡面 ce-img / 从者头像 sv-avatar)
  const imgDir = async (sub) => {
    for (const dir of ["data", path.join("dist", "data")]) {
      try {
        const p = path.join(projectRoot, dir, sub);
        if (!existsSync(p)) continue;
        let size = 0;
        let count = 0;
        for (const f of readdirSync(p)) {
          if (!/\.(png|jpe?g|webp)$/i.test(f)) continue; // 排除 .DS_Store 等
          try {
            size += statSync(path.join(p, f)).size;
            count += 1;
          } catch {
            /* 跳过 */
          }
        }
        return { size, count };
      } catch {
        /* 尝试下一个目录 */
      }
    }
    return null;
  };
  const [ces, servants, ceImg, svAvatar] = await Promise.all([
    read("ces.json"),
    read("servants.json"),
    imgDir("ce-img"),
    imgDir("sv-avatar"),
  ]);
  return { ces, servants, ceImg, svAvatar };
}
