// 独立服务器: 静态托管 dist/ + 数据刷新 API
// 用法: npm run build && node server.mjs  ->  http://127.0.0.1:4173
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { dataStatus, refreshData } from "./server/refresh.mjs";

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/refresh" && req.method === "POST") {
    sendJson(res, await refreshData(root));
    return;
  }
  if (url.pathname === "/api/status") {
    sendJson(res, await dataStatus(root));
    return;
  }

  // 静态文件 (防目录穿越)
  let p = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(dist, p));
  if (!file.startsWith(dist)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`FGO 羁绊组队计算器: ${url}`);
  if (process.env.AUTO_OPEN === "1") {
    setTimeout(() => openBrowser(url), 600);
  }
});
