#!/usr/bin/env node
// 发布打包: 构建 + 组装发布目录 + zip
// 用法: node scripts/release.mjs [版本号, 默认取 package.json 版本]
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(path.join(root, "package.json"), "utf-8")));
const version = process.argv[2] || pkg.version;
const name = `fgo-bond-team-builder-v${version}`;
const releaseRoot = path.join(root, "release");
const bundleDir = path.join(releaseRoot, name);
const zipPath = path.join(releaseRoot, `${name}.zip`);

console.log("== 1/3 构建前端 ==");
execSync("npm run build", { cwd: root, stdio: "inherit" });

console.log("== 2/3 组装发布目录 ==");
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
cpSync(path.join(root, "dist"), path.join(bundleDir, "dist"), { recursive: true });
cpSync(path.join(root, "server.mjs"), path.join(bundleDir, "server.mjs"));
mkdirSync(path.join(bundleDir, "server"), { recursive: true });
cpSync(path.join(root, "server", "refresh.mjs"), path.join(bundleDir, "server", "refresh.mjs"));
cpSync(path.join(root, "server", "refresh.d.mts"), path.join(bundleDir, "server", "refresh.d.mts"));
cpSync(path.join(root, "scraper"), path.join(bundleDir, "scraper"), { recursive: true });

// 数据快照日期
const dataMtime = existsSync(path.join(root, "public/data/ces.json"))
  ? statSync(path.join(root, "public/data/ces.json")).mtime.toISOString().slice(0, 10)
  : "未知";

const readme = `FGO 羁绊加成组队计算器 v${version}
====================================================

【运行】
  1. 确保已安装 Node.js (https://nodejs.org, 建议 LTS 版本)
  2. 双击 start.bat
  3. 浏览器会自动打开 http://127.0.0.1:4173
  4. 关闭黑窗口即停止服务

【数据】
  本包内置数据快照日期: ${dataMtime}
  - 若需获取最新 Mooncell 数据(新从者/新羁绊礼装), 点击页面上「一键更新数据」
    (需本机安装 Python 3, 未安装时会提示)
  - 你勾选的持有/锁定/灵衣等配置保存在浏览器 localStorage, 关闭不丢失

【常见问题】
  - 端口被占用: 新建 bat 文件, 内容为  set PORT=4174 & node server.mjs
  - 浏览器未自动打开: 手动访问 http://127.0.0.1:4173
  - 卸载: 删除本文件夹即可 (配置存在浏览器里, 与文件夹无关)

【开发/进阶】
  源码: https://github.com/lostpigxx/FGOAutoParty
`;
// 文件名用 ASCII (Windows zip 中文名易乱码); 内容 UTF-8 + BOM 便于记事本识别
writeFileSync(path.join(bundleDir, "README.txt"), "\uFEFF" + readme, "utf-8");

const bat = `@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   FGO 羁绊加成组队计算器 v${version}
echo   启动中... 浏览器将自动打开
echo   关闭本窗口即停止服务
echo ============================================
set AUTO_OPEN=1
node server.mjs
pause
`;
writeFileSync(path.join(bundleDir, "start.bat"), bat, "utf-8");

console.log("== 3/3 打包 zip ==");
rmSync(zipPath, { force: true });
execSync(`cd "${releaseRoot}" && zip -r "${name}.zip" "${name}"`, { stdio: "inherit" });
rmSync(bundleDir, { recursive: true, force: true });
console.log(`\n发布包已生成: ${zipPath}`);
