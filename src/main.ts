import {
  buildBondCatalog,
  ownEquipUsable,
  servantMatchesAnyForm,
  servantMatchesTrait,
  servantPassesFilters,
  supportCeOptions,
  svSnapshots,
  toCeItems,
  toServantInfo,
  traitText,
  type BondCeCatalog,
  type ServantInfo,
  type ServantViewFilters,
} from "./data";
import { optimizePlans, type CeItem, type OptimizeResult } from "./optimizer";
import {
  buildConfig,
  decodeConfig,
  encodeConfig,
  parseConfig,
  type ParsedConfig,
} from "./config";
import type { Ce, Servant } from "./types";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

const state = {
  costLimit: 116,
  ownSlots: 5,
  maxCes: 5,
  includeSupport: true,
  supportMode: "auto" as string,
  /** 冠位助战礼装 (第二助战位, 默认无) */
  supportMode2: "none" as string,
  autoPickFree: true,
  /** 深度搜索: 多起点收敛逃逸局部最优 (多职介更优但更慢; false=单起点快速模式) */
  deepSearch: true,
  /** 战斗形象手动选择: 从者title -> 形态key; 缺省=自动选最优 (搜索所有形态) */
  formSel: new Map<string, string>(),
  /** 礼装id -> 是否满破 (每张至多 1 张) */
  ownedCes: new Map<string, boolean>(),
  ownedSv: new Set<string>(),
  locked: [] as string[],
  extraTraits: new Map<string, string[]>(),
  svSearch: "",
  rarityFilter: new Set(["1", "2", "3", "4", "5"]),
  classFilter: new Set<string>(),
  traitFilter: new Set<string>(),
  ceOnly5: true,
};

let catalog: BondCeCatalog[] = [];
let catalogById = new Map<string, BondCeCatalog>();
let servants: Servant[] = [];
let servantsByTitle = new Map<string, Servant>();

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

function svInfoWithExtra(title: string): ServantInfo {
  const s = servantsByTitle.get(title);
  if (!s) throw new Error(`servant not found: ${title}`);
  const base = toServantInfo(s);
  base.extraTraits = state.extraTraits.get(title) ?? [];
  // 手动锁定的战斗形象: 直接用该形态快照 (不再自动跨形态搜索)
  const sel = state.formSel.get(title);
  if (sel && base.forms?.length) {
    const i = base.forms.findIndex((f) => f.key === sel);
    if (i >= 0) return svSnapshots(base)[i];
  }
  return base;
}

const KEY_TRAIT_SHORT: Record<string, string> = {
  "混沌且七骑士": "混沌骑士",
  "秩序·善": "秩序·善",
  "秩序的女性": "秩序女性",
  "星": "星",
  "恶": "恶",
  "中立": "中立",
  "活在当下的人类": "活在当下",
  "兽科从者": "兽科",
  "Fate/stay night从者": "FSN",
  "持有灵衣之人": "灵衣",
};
const KEY_TRAITS = Object.keys(KEY_TRAIT_SHORT);

function traitBadges(info: ServantInfo): string[] {
  // 形态从者: 任一形态命中即显示徽标 (提示该从者"能对上"哪些 20% 礼装)
  return KEY_TRAITS.filter((t) => servantMatchesAnyForm(info, t)).map((t) => KEY_TRAIT_SHORT[t]);
}

function starClass(r: number): string {
  return `ce-star-${r}`;
}

function esc(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// 渲染: 礼装列表
// ---------------------------------------------------------------------------

function renderCeList() {
  const list = $<HTMLDivElement>("ceList");
  const sorted = catalog
    .filter((c) => ownEquipUsable(c)) // 剔除 <5% 鸡肋 (2.5% 等)
    .filter((c) => !state.ceOnly5 || c.rarity === 5)
    // 按礼装 ID 倒序 (新礼装在前, 与从者"新从者在前"一致;
    // 国服未实装的一般是最新一批高 ID, 聚在一起方便快速取消勾选)
    .sort((a, b) => Number(b.id) - Number(a.id) || a.name.localeCompare(b.name));
  list.innerHTML = sorted
    .map((c) => {
      const mlb = state.ownedCes.get(c.id) ?? false;
      const trait = c.traits.length
        ? ` <span class="trait">〔${esc(traitText(c.traits))}〕</span>`
        : "";
      return `<div class="ce-row">
        <input type="checkbox" class="ce-owned" data-id="${esc(c.id)}" ${state.ownedCes.has(c.id) ? "checked" : ""} />
        <img class="ce-art" data-id="${esc(c.id)}" src="data/ce-img/${esc(c.id)}.png" alt="${esc(c.name)}" loading="lazy" title="点击查看卡面" />
        <div>
          <div class="ce-name"><span class="${starClass(c.rarity)}">★${c.rarity}</span> ${esc(c.name)}<span class="jp">${esc(c.jpName)}</span></div>
          <div class="ce-effect">${esc(c.summary)}${trait} · cost ${c.cost}</div>
        </div>
        <div class="ce-ctrl" data-ctrl="${esc(c.id)}">
          ${state.ownedCes.has(c.id) ? `<label>满破 <input type="checkbox" class="ce-mlb" data-id="${esc(c.id)}" ${mlb ? "checked" : ""} /></label>` : ""}
        </div>
      </div>`;
    })
    .join("");
  // 图片缺失(未下载/页面不存在)时隐藏缩略图
  list.querySelectorAll<HTMLImageElement>("img.ce-art").forEach((img) => {
    img.addEventListener("error", () => img.remove(), { once: true });
  });
}

// ---------------------------------------------------------------------------
// 渲染: 从者列表
// ---------------------------------------------------------------------------

/** 当前筛选 + 搜索条件下的可见从者 */
function visibleServants(): Servant[] {
  const q = state.svSearch.trim().toLowerCase();
  const filters = currentViewFilters();
  return servants.filter((s) => {
    if (!servantPassesFilters(svInfoWithExtra(s.title), filters)) return false;
    if (!q) return true;
    const hay = `${s.title} ${s.name} ${s.className} ${s.traits.join(" ")}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderServantList() {
  const list = $<HTMLDivElement>("svList");
  const visible = visibleServants();

  const groups = new Map<number, Servant[]>();
  for (const s of visible) {
    if (!groups.has(s.rarity)) groups.set(s.rarity, []);
    groups.get(s.rarity)!.push(s);
  }
  // 同稀有度内按序号倒序 (新从者在前)
  for (const g of groups.values()) {
    g.sort((a, b) => (b.collectionNo ?? 0) - (a.collectionNo ?? 0));
  }

  let html = "";
  for (const rarity of [5, 4, 3, 2, 1]) {
    const g = groups.get(rarity);
    if (!g) continue;
    html += `<div class="sv-group-title">★${rarity}（${g.length} 名）</div>`;
    for (const s of g) {
      const info = svInfoWithExtra(s.title);
      const badges = traitBadges(info);
      const isLocked = state.locked.includes(s.title);
      const formSel = s.forms?.length
        ? `<select class="form-sel" data-title="${esc(s.title)}" title="战斗形象：特性随形象变化的从者（如 U－奥尔加玛丽形象3 为善/活在当下的人类）。自动=搜索所有形态、按全队礼装取最优并提示建议形态；也可手动锁定">
            <option value="" ${state.formSel.has(s.title) ? "" : "selected"}>形态·自动</option>
            ${s.forms.map((f) => `<option value="${esc(f.key)}" ${state.formSel.get(s.title) === f.key ? "selected" : ""}>${esc(f.label)}</option>`).join("")}
          </select>`
        : "";
      html += `<div class="sv-row ${isLocked ? "locked" : ""}">
        <input type="checkbox" class="sv-owned" data-title="${esc(s.title)}" ${state.ownedSv.has(s.title) ? "checked" : ""} />
        <div class="sv-line1">
          <span class="sv-title">${esc(s.title)}</span>
          <span class="sv-class">${esc(s.className)}</span>
        </div>
        ${badges.length ? `<div class="sv-traits">${badges.map(esc).join(" / ")}</div>` : ""}
        ${formSel}
        <div class="sv-actions">
          ${s.hasCostume
            ? `<label class="sv-costume-label" title="该从者有灵衣，默认视为已解锁（持有灵衣之人特性）；国服未实装的可取消勾选">灵衣
              <input type="checkbox" class="sv-costume" data-title="${esc(s.title)}" ${info.extraTraits.includes("持有灵衣之人") ? "checked" : ""} />
            </label>`
            : ""}
          <button class="lock" data-title="${esc(s.title)}">${isLocked ? "已锁定" : "锁定"}</button>
        </div>
      </div>`;
    }
  }
  list.innerHTML = html || `<div class="meta">没有匹配的从者</div>`;

  $<HTMLDivElement>("lockedBar").innerHTML =
    state.locked.length === 0
      ? `<span class="meta">锁定从者（最多 ${state.ownSlots} 名，按顺序入队）</span>`
      : state.locked
          .map(
            (t) => `<span class="locked-chip">${esc(t)}
              <button class="unlock" data-title="${esc(t)}">×</button></span>`,
          )
          .join("");
}

// ---------------------------------------------------------------------------
// 渲染: 助战礼装选项
// ---------------------------------------------------------------------------

function renderSupportOptions() {
  const options = supportCeOptions(catalog);
  const optHtml = [
    `<option value="auto">自动选最优</option>`,
    `<option value="none">无</option>`,
    ...options.map(
      (o) =>
        `<option value="${esc(o.key)}">${esc(o.label)} · ${esc(traitText(o.traits))} · cost ${o.cost}</option>`,
    ),
  ].join("");
  const sel = $<HTMLSelectElement>("supportCeMode");
  sel.innerHTML = optHtml;
  sel.value = state.supportMode;
  const sel2 = $<HTMLSelectElement>("supportCeMode2");
  sel2.innerHTML = optHtml;
  sel2.value = state.supportMode2;
}

// ---------------------------------------------------------------------------
// 渲染: 职阶 / 特性筛选
// ---------------------------------------------------------------------------

const CLASS_ORDER = [
  "Saber", "Archer", "Lancer", "Rider", "Caster", "Assassin", "Berserker",
];

function renderClassChips() {
  const el = $<HTMLSpanElement>("classFilter");
  const classes = [...new Set(servants.map((s) => s.className).filter(Boolean))];
  classes.sort((a, b) => {
    const ia = CLASS_ORDER.indexOf(a);
    const ib = CLASS_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const allActive = state.classFilter.size === 0;
  el.innerHTML =
    `<span class="trait-chip ${allActive ? "active" : ""}" data-class="">全部</span>` +
    classes
      .map(
        (c) =>
          `<span class="trait-chip ${state.classFilter.has(c) ? "active" : ""}" data-class="${esc(c)}">${esc(c)}</span>`,
      )
      .join("");
}

function renderTraitChips() {
  const el = $<HTMLSpanElement>("traitFilter");
  el.innerHTML = KEY_TRAITS.map(
    (t) =>
      `<span class="trait-chip ${state.traitFilter.has(t) ? "active" : ""}" data-trait="${esc(t)}">${esc(KEY_TRAIT_SHORT[t])}</span>`,
  ).join("");
}

// ---------------------------------------------------------------------------
// 数据状态 / 一键更新
// ---------------------------------------------------------------------------

async function loadDataStatus() {
  try {
    const res = await fetch("api/status");
    if (!res.ok) return;
    const s = (await res.json()) as {
      ces: { size: number; mtime: string } | null;
      servants: { size: number; mtime: string } | null;
    };
    const fmt = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    $<HTMLSpanElement>("dataStatus").textContent = s.ces && s.servants
      ? `数据已本地保存 · 礼装 ${(s.ces.size / 1024).toFixed(0)}KB · 从者 ${(s.servants.size / 1024).toFixed(0)}KB · 最后更新 ${fmt(s.ces.mtime)}`
      : "数据文件缺失，请点击「一键更新数据」";
  } catch {
    $<HTMLSpanElement>("dataStatus").textContent = "数据状态查询不可用（开发服务器需通过 npm run dev 或 node server.mjs 启动）";
  }
}

async function loadData() {
  const [cesRes, svRes] = await Promise.all([
    fetch(`data/ces.json?t=${Date.now()}`),
    fetch(`data/servants.json?t=${Date.now()}`),
  ]);
  if (!cesRes.ok || !svRes.ok) throw new Error("数据文件加载失败");
  const ces: Ce[] = await cesRes.json();
  const svs: Servant[] = await svRes.json();
  catalog = buildBondCatalog(ces);
  catalogById = new Map(catalog.map((c) => [c.id, c]));
  servants = svs;
  servantsByTitle = new Map(svs.map((s) => [s.title, s]));
  state.ownedSv = new Set(); // 默认全不选
  // 灵衣默认全勾上 (有灵衣 = 视为已解锁), 之后由保存的配置覆盖
  state.extraTraits = new Map(
    svs.filter((s) => s.hasCostume).map((s) => [s.title, ["持有灵衣之人"]]),
  );
}

/** 重新加载数据 (数据更新后调用, 会重新套用已保存的配置) */
async function reloadData() {
  await loadData();
  applySavedConfig();
  renderSupportOptions();
  renderClassChips();
  renderCeList();
  renderServantList();
  recalc();
}

// ---------------------------------------------------------------------------
// 配置持久化 (localStorage + URL)
// ---------------------------------------------------------------------------

const LS_KEY = "fgo-bond-config-v2";

function availableCeIds(): Set<string> {
  return new Set(catalogById.keys());
}
function allTitles(): Set<string> {
  return new Set(servantsByTitle.keys());
}

function currentSettings() {
  return {
    costLimit: state.costLimit,
    ownSlots: state.ownSlots,
    maxCes: state.maxCes,
    includeSupport: state.includeSupport,
    supportMode: state.supportMode,
    supportMode2: state.supportMode2,
    autoPickFree: state.autoPickFree,
    deepSearch: state.deepSearch,
    ceOnly5: state.ceOnly5,
    classFilter: [...state.classFilter],
    traitFilter: [...state.traitFilter],
    rarityFilter: [...state.rarityFilter].map((r) => Number(r)),
  };
}

/** 显式反选的灵衣从者 (有灵衣者默认勾上, 这些除外) */
function currentCostumesOff(): string[] {
  return servants
    .filter((s) => s.hasCostume && !state.extraTraits.has(s.title))
    .map((s) => s.title);
}

/** 手动锁定的战斗形象选择 (缺省=自动) */
function currentFormSel(): Map<string, string> {
  return new Map(state.formSel);
}

/** 当前视图筛选 (稀有度/职阶/特性) —— 同时约束展示列表与优化结果 */
function currentViewFilters(): ServantViewFilters {
  return {
    rarity: new Set([...state.rarityFilter].map((r) => Number(r))),
    classes: state.classFilter,
    traits: state.traitFilter,
  };
}

/** 把当前状态写入 localStorage (在 recalc 末尾调用) */
function persist() {
  try {
    const cfg = buildConfig({
      settings: currentSettings(),
      ownedCes: state.ownedCes,
      ownedSv: state.ownedSv,
      allTitles: allTitles(),
      locked: state.locked,
      costumeOffTitles: currentCostumesOff(),
      formSel: currentFormSel(),
    });
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    /* localStorage 不可用/满 — 忽略 */
  }
}

/** 套用解析后的配置到 state, 并同步设置控件 */
function applyParsed(p: ParsedConfig) {
  state.costLimit = p.settings.costLimit;
  state.ownSlots = p.settings.ownSlots;
  state.maxCes = p.settings.maxCes;
  state.includeSupport = p.settings.includeSupport;
  state.supportMode = p.settings.supportMode;
  state.supportMode2 = p.settings.supportMode2;
  state.autoPickFree = p.settings.autoPickFree;
  state.deepSearch = p.settings.deepSearch;
  state.ceOnly5 = p.settings.ceOnly5;
  state.classFilter = new Set(p.settings.classFilter);
  state.traitFilter = new Set(p.settings.traitFilter);
  state.rarityFilter = new Set(p.settings.rarityFilter.map(String));
  // 剔除 <5% 鸡肋礼装 (目录未就绪时保留, boot 早期)
  state.ownedCes = new Map(
    [...p.ownedCeIds].filter(([id]) => {
      const c = catalogById.get(id);
      return c ? ownEquipUsable(c) : true;
    }),
  );
  state.ownedSv = p.ownedSv;
  state.locked = p.locked;
  state.formSel = new Map(p.formSel);
  // 灵衣: 有灵衣者默认勾上 (视为已解锁), 显式反选的除外
  const off = new Set(p.costumesOff);
  state.extraTraits = new Map();
  for (const s of servants) {
    if (s.hasCostume && !off.has(s.title)) {
      state.extraTraits.set(s.title, ["持有灵衣之人"]);
    }
  }
  syncSettingsInputs();
  renderClassChips();
  renderTraitChips();
}

function syncSettingsInputs() {
  $<HTMLInputElement>("costLimit").value = String(state.costLimit);
  $<HTMLInputElement>("ownSlots").value = String(state.ownSlots);
  $<HTMLInputElement>("maxCes").value = String(state.maxCes);
  $<HTMLInputElement>("includeSupport").checked = state.includeSupport;
  $<HTMLSelectElement>("supportCeMode").value = state.supportMode;
  $<HTMLSelectElement>("supportCeMode2").value = state.supportMode2;
  $<HTMLInputElement>("autoPickFree").checked = state.autoPickFree;
  $<HTMLInputElement>("deepSearch").checked = state.deepSearch;
  $<HTMLInputElement>("ceOnly5").checked = state.ceOnly5;
  document.querySelectorAll<HTMLInputElement>(".rarityFilter").forEach((cb) => {
    cb.checked = state.rarityFilter.has(cb.value);
  });
}

function applySavedConfig(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const p = parseConfig(raw, availableCeIds(), allTitles());
    if (!p) return false;
    applyParsed(p);
    return true;
  } catch {
    return false;
  }
}

function configLink(): string {
  const cfg = buildConfig({
    settings: currentSettings(),
    ownedCes: state.ownedCes,
    ownedSv: state.ownedSv,
    allTitles: allTitles(),
    locked: state.locked,
    costumeOffTitles: currentCostumesOff(),
    formSel: currentFormSel(),
  });
  const url = new URL(location.href);
  url.searchParams.set("cfg", encodeConfig(JSON.stringify(cfg)));
  return url.toString();
}

let hintTimer: number | undefined;
function hint(msg: string) {
  const el = $<HTMLSpanElement>("configHint");
  el.textContent = msg;
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => (el.textContent = ""), 4000);
}

function bindConfigButtons() {
  $<HTMLButtonElement>("copyConfig").addEventListener("click", async () => {
    const link = configLink();
    try {
      await navigator.clipboard.writeText(link);
      hint("配置链接已复制（含持有/锁定/设置），可直接发给他人或收藏");
    } catch {
      window.prompt("复制配置链接:", link);
    }
  });
  $<HTMLButtonElement>("resetConfig").addEventListener("click", () => {
    localStorage.removeItem(LS_KEY);
    state.ownedCes = new Map();
    state.ownedSv = new Set(servantsByTitle.keys());
    state.locked = [];
    state.formSel = new Map();
    state.extraTraits = new Map(
      servants.filter((s) => s.hasCostume).map((s) => [s.title, ["持有灵衣之人"]]),
    );
    state.costLimit = 116;
    state.ownSlots = 5;
    state.maxCes = 5;
    state.includeSupport = true;
    state.supportMode = "auto";
    state.supportMode2 = "none";
    state.autoPickFree = true;
    state.deepSearch = true;
    state.ceOnly5 = true;
    state.classFilter = new Set();
    state.traitFilter = new Set();
    state.rarityFilter = new Set(["1", "2", "3", "4", "5"]);
    const u = new URL(location.href);
    u.searchParams.delete("cfg");
    history.replaceState(null, "", u.toString());
    syncSettingsInputs();
    renderClassChips();
    renderTraitChips();
    renderSupportOptions();
    renderCeList();
    renderServantList();
    recalc();
    hint("配置已重置为默认");
  });
  // ---- 导出配置: 弹窗确认文件名 -> 本机服务写入 settings/ (失败回退浏览器下载) ----
  const exportModal = $<HTMLDivElement>("exportModal");
  const exportFileName = $<HTMLInputElement>("exportFileName");
  const exportMsg = $<HTMLParagraphElement>("exportMsg");
  const cfgContent = () =>
    JSON.stringify(
      buildConfig({
        settings: currentSettings(),
        ownedCes: state.ownedCes,
        ownedSv: state.ownedSv,
        allTitles: allTitles(),
        locked: state.locked,
        costumeOffTitles: currentCostumesOff(),
        formSel: currentFormSel(),
      }),
      null,
      2,
    );
  const defaultCfgName = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `fgo-bond-config-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
  };
  const closeExportModal = () => {
    exportModal.hidden = true;
  };
  $<HTMLButtonElement>("exportConfig").addEventListener("click", () => {
    exportFileName.value = defaultCfgName();
    exportMsg.textContent = "";
    exportModal.hidden = false;
  });
  $<HTMLButtonElement>("exportCancel").addEventListener("click", closeExportModal);
  exportModal.addEventListener("click", (e) => {
    if (e.target === exportModal) closeExportModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!exportModal.hidden) closeExportModal();
    const am = document.getElementById("artModal") as HTMLDivElement | null;
    if (am && !am.hidden) am.hidden = true;
  });
  $<HTMLButtonElement>("exportSave").addEventListener("click", async () => {
    let name = exportFileName.value.trim();
    if (!name) {
      exportMsg.textContent = "请输入文件名";
      return;
    }
    if (!/\.json$/i.test(name)) name += ".json";
    const content = cfgContent();
    exportMsg.textContent = "保存中…";
    try {
      const res = await fetch("/api/config/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name, content }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; path?: string; error?: string }
        | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      hint(`配置已保存: ${data.path}`);
      closeExportModal();
    } catch {
      // 本机服务不可用 (如直接以 file:// 打开等) -> 退回浏览器下载
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      hint("未找到本机服务，已改为浏览器下载");
      closeExportModal();
    }
  });
  const importBtn = $<HTMLButtonElement>("importConfig");
  const fileInput = $<HTMLInputElement>("importFile");
  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? "");
        const p = parseConfig(text, availableCeIds(), allTitles());
        if (!p) throw new Error("bad");
        applyParsed(p);
        renderSupportOptions();
        renderCeList();
        renderServantList();
        recalc(); // recalc 末尾会把导入结果持久化到 localStorage
        hint(`已从文件导入配置：${f.name}`);
      } catch {
        hint("导入失败：文件不是有效的配置 JSON（可先用「导出配置到文件」生成）");
      }
      fileInput.value = "";
    };
    reader.readAsText(f, "utf-8");
  });
}

function bindRefreshButton() {
  const btn = $<HTMLButtonElement>("refreshData");
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "正在从 Mooncell 拉取数据（约 2~3 分钟）…";
    $<HTMLSpanElement>("dataStatus").textContent = "更新中，请勿关闭页面…";
    try {
      const res = await fetch("api/refresh", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string; log?: string };
      if (data.ok) {
        $<HTMLSpanElement>("dataStatus").textContent = "更新成功，正在加载新数据…";
        await reloadData();
        await loadDataStatus();
      } else {
        $<HTMLSpanElement>("dataStatus").textContent = `更新失败：${data.error ?? "未知错误"}`;
      }
    } catch (e) {
      $<HTMLSpanElement>("dataStatus").textContent = `更新失败：${esc((e as Error).message)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

// ---------------------------------------------------------------------------
// 计算
// ---------------------------------------------------------------------------

function recalc() {
  const resultEl = $<HTMLDivElement>("result");
  const filters = currentViewFilters();

  let lockedAll: ServantInfo[];
  try {
    lockedAll = state.locked.map(svInfoWithExtra);
  } catch (e) {
    resultEl.innerHTML = `<div class="error-box">${esc((e as Error).message)}</div>`;
    return;
  }
  // 筛选约束一切: 不满足筛选的锁定从者不参与计算 (提示并移出)
  const locked = lockedAll.filter((info) => servantPassesFilters(info, filters));
  const droppedLocked = lockedAll.filter((info) => !servantPassesFilters(info, filters));

  // 可用从者池: 已持有且未被锁定, 且满足当前筛选 (职阶/特性/稀有度)
  const freePool = [...state.ownedSv]
    .filter((t) => !state.locked.includes(t))
    .map(svInfoWithExtra)
    .filter((info) => servantPassesFilters(info, filters));

  const needed = state.ownSlots - locked.length;
  if (freePool.length < needed) {
    if (state.ownedSv.size === 0) {
      resultEl.innerHTML = `<div class="error-box">尚未选择任何持有从者：请在上方「从者」面板勾选你拥有的从者（可用「全选」或按职阶/特性筛选后「反选」）。</div>`;
    } else if (
      filters.classes.size > 0 ||
      filters.traits.size > 0 ||
      filters.rarity.size > 0
    ) {
      resultEl.innerHTML = `<div class="error-box">可用从者不足：当前筛选（职阶/特性/稀有度）后只剩 ${freePool.length} 名可补位，还需要 ${needed} 名。请放宽筛选、减少上阵人数或锁定更多从者。</div>`;
    } else {
      resultEl.innerHTML = `<div class="error-box">持有从者数量不足：已选 ${state.ownedSv.size} 名，还需要 ${needed} 名可补位。请在上方「从者」面板勾选更多从者。</div>`;
    }
    persist();
    return;
  }

  // 被筛选挡掉的锁定从者提示
  const filterWarnings = droppedLocked.map(
    (info) => `锁定从者「${info.name}」不满足当前职阶/特性/稀有度筛选，已移出本次计算（放宽筛选后会自动恢复）`,
  );

  const ownedCes: { catalog: BondCeCatalog; mlb: boolean }[] = [];
  for (const [id, mlb] of state.ownedCes) {
    const c = catalogById.get(id);
    if (c && ownEquipUsable(c)) ownedCes.push({ catalog: c, mlb });
  }

  const ceItems = toCeItems(ownedCes);
  const supportOptions = supportCeOptions(catalog);
  const supportSel =
    state.supportMode === "none"
      ? []
      : state.supportMode === "auto"
        ? supportOptions
        : supportOptions.filter((o) => o.key === state.supportMode);
  const supportSel2 =
    state.supportMode2 === "none"
      ? []
      : state.supportMode2 === "auto"
        ? supportOptions
        : supportOptions.filter((o) => o.key === state.supportMode2);

  const input = {
    costLimit: state.costLimit,
    ownSlots: state.ownSlots,
    maxCes: state.maxCes,
    includeSupport: state.includeSupport,
    supportOptions: supportSel,
    supportOptions2: supportSel2,
    ceItems,
    lockedServants: locked,
    freePool,
    autoPickFree: state.autoPickFree,
  };

  const top = optimizePlans(input, state.deepSearch);
  renderResult(top, filterWarnings);
  persist();
}

function renderTeam(r: OptimizeResult): string {
  // 全队共享礼装 (带来源标签): 自己装备 + 助战 + 冠位
  const taggedCes: { ce: CeItem; tag: string }[] = [
    ...r.chosenCe.filter((c) => c.scope === "party").map((ce) => ({ ce, tag: "自己" })),
    ...(r.supportCe ? [{ ce: r.supportCe, tag: "助战" }] : []),
    ...(r.supportCe2 ? [{ ce: r.supportCe2, tag: "冠位" }] : []),
  ];
  const appliesTo = (ce: CeItem, sv: ServantInfo) =>
    ce.traits.length === 0 || ce.traits.some((t) => servantMatchesTrait(sv, t));

  const slotHtml = (slot: (typeof r.slots)[number], pos: string) => {
    const sv = slot.servant!;
    // auto 形态: 展示按优化器选中的战斗形象 (buildResult 已按该形态计算加成)
    let displaySv = sv;
    if (slot.formLabel && sv.forms?.length) {
      const i = sv.forms.findIndex((f) => f.label === slot.formLabel);
      if (i >= 0) displaySv = svSnapshots(sv)[i];
    }
    const badges = traitBadges(displaySv);
    // 对该从者生效的礼装构成 (佩戴礼装在下方单独列出)
    const parts = taggedCes
      .filter(({ ce: c }) => appliesTo(c, displaySv))
      .map(({ ce: c, tag }) => `<div class="bd">${tag} · ${esc(c.name)} +${round(c.bonus)}%</div>`)
      .join("");
    const formTip =
      slot.formLabel && sv.forms?.length
        ? `<div class="form-tip">⚠ 需使用「${esc(slot.formLabel)}」形态（可在此从者卡片手动锁定）</div>`
        : "";
    return `<div class="slot">
      <div class="pos">${pos}${slot.locked ? ' <span class="locked-tag">· 锁定</span>' : ""}</div>
      <div class="sv">${esc(sv.name)} <span class="sv-cost">★cost ${sv.cost}</span></div>
      <div class="sv-traits">${badges.length ? badges.map(esc).join(" / ") : "—"}</div>
      <div class="bonus">该从者全队加成 +${round(slot.partyBonus)}%</div>
      ${formTip}
      ${parts ? `<div class="bonus-detail">${parts}</div>` : ""}
    </div>`;
  };

  let teamHtml = "";
  if (r.support) {
    const ce = r.support.ce;
    const ce2 = r.support2?.ce ?? null;
    teamHtml += `<div class="slot support-slot">
      <div class="pos">助战位（好友${ce2 ? " ×2" : ""}，cost 不计入）</div>
      <div class="ce">${ce ? `① <span class="ce-name2">${esc(ce.name)}</span> ${esc(ce.label)} · cost ${ce.cost}<span class="sv-cost">（不计入）</span>` : "① 无礼装"}</div>
      ${ce2 ? `<div class="ce">② <span class="ce-name2">${esc(ce2.name)}</span> ${esc(ce2.label)} · cost ${ce2.cost}<span class="sv-cost">（不计入）</span></div>` : ""}
      <div class="bonus">效果已计入下方各从者加成</div>
    </div>`;
  }
  const front = r.slots.slice(0, 3).map((s, i) => slotHtml(s, `前排 ${i + 1}`));
  const back = r.slots.slice(3).map((s, i) => slotHtml(s, `后排 ${i + 1}`));
  teamHtml += [...front, ...back].join("");

  // 佩戴礼装 (自己, 单独列出, 可与上阵人数不同)
  const ownCes = r.chosenCe
    .map(
      (c, i) =>
        `  <span class="eq-item">${i + 1}. ${esc(c.name)} ${esc(c.label)} · cost ${c.cost === 0 ? "0（免费）" : c.cost}</span>`,
    )
    .join("");
  const equippedHtml = ownCes
    ? `<div class="equipped-ces"><div class="eq-title">佩戴礼装（自己 · ${r.chosenCe.length} 张）</div><div class="eq-list">${ownCes}</div></div>`
    : "";

  return `
    ${equippedHtml}
    <div class="team">${teamHtml}</div>`;
}

function renderResult(results: OptimizeResult[], warnings: string[] = []) {
  const el = $<HTMLDivElement>("result");
  if (results.length === 0 || !results[0].feasible) {
    const err = results[0]?.error ?? "无法组队";
    el.innerHTML = `<div class="error-box">无法组队：${esc(err)}</div>`;
    return;
  }
  const r0 = results[0];
  const warnHtml = warnings.length
    ? `<div class="notes" style="color:var(--bad)">⚠ ${warnings.map(esc).join("<br>⚠ ")}</div>`
    : "";

  // 对比表
  const planLabel = (i: number, r: OptimizeResult) => {
    if (i === 0) return `<span class="best">🤖 智能方案</span>`;
    if (r.isCostMax) return `<span class="best" style="color:var(--good)">cost最佳</span>`;
    return `<span style="color:var(--accent2)">加成最佳</span>`;
  };
  const rows = results
    .map((r, i) => {
      const isBest = i === 0;
      return `<tr class="${isBest ? "best-row" : ""}">
        <td>${planLabel(i, r)}</td>
        <td>${isBest ? '<span class="best">' : ""}+${r.totalPct}%${isBest ? "</span>" : ""}</td>
        <td>${r.totalCost} / ${r.costLimit}</td>
        <td>${r.supportCe ? esc(r.supportCe.name) + "（" + esc(r.supportCe.label) + "）" : "无"}</td>
      </tr>`;
    })
    .join("");

  const details = results
    .map((r, i) => {
      const title = i === 0
        ? `<span class="rank-best">🤖 智能方案</span> · 加成第一，同加成尽量上高星 · 总Cost ${r.totalCost}/${r.costLimit} · 全队加成 +${r.totalPct}%`
        : r.isCostMax
          ? `<span style="color:var(--good)">💪 cost最佳</span> · 尽可能用满 Cost · 总Cost ${r.totalCost}/${r.costLimit} · 全队加成 +${r.totalPct}%`
          : `<span style="color:var(--accent2)">⚡ 加成最佳</span> · 纯加成最大化 · 总Cost ${r.totalCost}/${r.costLimit} · 全队加成 +${r.totalPct}%`;
      return `<details class="team-details" ${i === 0 ? "open" : ""}>
        <summary>${title}</summary>
        ${renderTeam(r)}
      </details>`;
    })
    .join("");

  const avg = r0.totalPct / r0.ownSlots;

  el.innerHTML = `
    ${warnHtml}
    <div class="summary-grid">
      <div class="summary-item"><div class="k">最优方案 · 自己 Cost</div><div class="v ${r0.totalCost > r0.costLimit ? "bad" : ""}">${r0.totalCost} / ${r0.costLimit}</div></div>
      <div class="summary-item"><div class="k">最优方案 · 全队总羁绊加成</div><div class="v good">+${r0.totalPct}%</div></div>
      <div class="summary-item"><div class="k">平均每人加成</div><div class="v">+${round(avg)}%</div></div>
    </div>
    ${r0.support ? `<div class="notes">助战位（好友）的从者与礼装 Cost <strong>不计入</strong>你的 Cost 上限。</div>` : ""}
    ${results.length > 1 ? `<table class="compare-table">
      <thead><tr><th>方案</th><th>全队加成</th><th>自己 Cost</th><th>助战礼装</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : ""}
    ${details}`;
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bindEvents() {
  $<HTMLInputElement>("costLimit").addEventListener("input", (e) => {
    state.costLimit = Math.max(1, Number((e.target as HTMLInputElement).value) || 113);
    recalc();
  });
  $<HTMLInputElement>("ownSlots").addEventListener("input", (e) => {
    state.ownSlots = Math.min(6, Math.max(1, Number((e.target as HTMLInputElement).value) || 5));
    renderServantList();
    recalc();
  });
  $<HTMLInputElement>("maxCes").addEventListener("input", (e) => {
    state.maxCes = Math.min(6, Math.max(0, Number((e.target as HTMLInputElement).value) || 5));
    recalc();
  });
  const applyPreset = (own: number, ces: number, sup2: string, msg: string) => {
    state.ownSlots = own;
    state.maxCes = ces;
    state.supportMode2 = sup2;
    syncSettingsInputs();
    recalc();
    hint(msg);
  };
  $<HTMLButtonElement>("presetCrown").addEventListener("click", () =>
    applyPreset(5, 6, "auto", "冠位战模式：上阵 5 / 礼装 6（第 6 张免费）/ 冠位助战自动选最优"),
  );
  $<HTMLButtonElement>("presetNormal").addEventListener("click", () =>
    applyPreset(5, 5, "none", "普通模式：上阵 5 / 礼装 5 / 冠位助战无"),
  );
  $<HTMLInputElement>("includeSupport").addEventListener("change", (e) => {
    state.includeSupport = (e.target as HTMLInputElement).checked;
    recalc();
  });
  $<HTMLSelectElement>("supportCeMode").addEventListener("change", (e) => {
    state.supportMode = (e.target as HTMLSelectElement).value;
    recalc();
  });
  $<HTMLSelectElement>("supportCeMode2").addEventListener("change", (e) => {
    state.supportMode2 = (e.target as HTMLSelectElement).value;
    recalc();
  });
  $<HTMLInputElement>("autoPickFree").addEventListener("change", (e) => {
    state.autoPickFree = (e.target as HTMLInputElement).checked;
    recalc();
  });
  $<HTMLInputElement>("deepSearch").addEventListener("change", (e) => {
    state.deepSearch = (e.target as HTMLInputElement).checked;
    recalc();
  });

  $<HTMLInputElement>("svSearch").addEventListener("input", (e) => {
    state.svSearch = (e.target as HTMLInputElement).value;
    renderServantList();
  });
  document.querySelectorAll<HTMLInputElement>(".rarityFilter").forEach((cb) => {
    cb.addEventListener("change", () => {
      state.rarityFilter = new Set(
        [...document.querySelectorAll<HTMLInputElement>(".rarityFilter")]
          .filter((x) => x.checked)
          .map((x) => x.value),
      );
      renderServantList();
      recalc();
    });
  });

  $<HTMLButtonElement>("ceSelectAll").addEventListener("click", () => {
    for (const c of catalog) {
      state.ownedCes.set(c.id, true); // 默认满破
    }
    renderCeList();
    recalc();
  });
  $<HTMLButtonElement>("ceSelectNone").addEventListener("click", () => {
    state.ownedCes.clear();
    renderCeList();
    recalc();
  });

  $<HTMLInputElement>("ceOnly5").addEventListener("change", (e) => {
    state.ceOnly5 = (e.target as HTMLInputElement).checked;
    renderCeList();
    recalc();
  });

  // 事件委托: 礼装列表
  $<HTMLDivElement>("ceList").addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains("ce-owned")) {
      const id = t.dataset.id!;
      if ((t as HTMLInputElement).checked) {
        state.ownedCes.set(id, true); // 默认满破
      } else {
        state.ownedCes.delete(id);
      }
      renderCeList();
      recalc();
    } else if (t.classList.contains("ce-mlb")) {
      const id = t.dataset.id!;
      state.ownedCes.set(id, (t as HTMLInputElement).checked);
      renderCeList();
      recalc();
    }
  });

  // 礼装卡面弹窗 (点击缩略图看大图)
  const artModal = $<HTMLDivElement>("artModal");
  const artImg = $<HTMLImageElement>("artImg");
  const artName = $<HTMLHeadingElement>("artName");
  const showArt = (id: string) => {
    artImg.src = `data/ce-img/${encodeURIComponent(id)}.png`;
    artName.textContent = catalogById.get(id)?.name ?? `礼装 ${id}`;
    artModal.hidden = false;
  };
  $<HTMLDivElement>("ceList").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("img.ce-art");
    if (t) showArt((t as HTMLElement).dataset.id!);
  });
  $<HTMLButtonElement>("artClose").addEventListener("click", () => (artModal.hidden = true));
  artModal.addEventListener("click", (e) => {
    if (e.target === artModal) artModal.hidden = true;
  });

  // 事件委托: 从者列表
  $<HTMLDivElement>("svList").addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    const title = t.dataset.title!;
    if (t.classList.contains("sv-owned")) {
      if ((t as HTMLInputElement).checked) state.ownedSv.add(title);
      else state.ownedSv.delete(title);
      recalc();
    } else if (t.classList.contains("sv-costume")) {
      // 灵衣勾选 (有灵衣的从者才显示; 默认勾上, 可反选国服未实装的)
      if ((t as HTMLInputElement).checked) state.extraTraits.set(title, ["持有灵衣之人"]);
      else state.extraTraits.delete(title);
      renderServantList();
      recalc();
    } else if (t.classList.contains("form-sel")) {
      // 战斗形象选择: 空=自动(搜索所有形态), 否则手动锁定该形态
      const key = (t as HTMLSelectElement).value;
      if (key) state.formSel.set(title, key);
      else state.formSel.delete(title);
      renderServantList();
      recalc();
    }
  });

  $<HTMLDivElement>("svList").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("button.lock");
    if (!t) return;
    const title = (t as HTMLElement).dataset.title!;
    if (state.locked.includes(title)) {
      state.locked = state.locked.filter((x) => x !== title);
    } else {
      if (state.locked.length >= state.ownSlots) return;
      state.locked.push(title);
    }
    renderServantList();
    recalc();
  });

  $<HTMLDivElement>("lockedBar").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest("button.unlock");
    if (!t) return;
    const title = (t as HTMLElement).dataset.title!;
    state.locked = state.locked.filter((x) => x !== title);
    renderServantList();
    recalc();
  });

  // 职阶筛选 chips (多选 = 任一符合; 点「全部」清空)
  $<HTMLSpanElement>("classFilter").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest(".trait-chip") as HTMLElement | null;
    if (!chip) return;
    const cls = chip.dataset.class ?? "";
    if (cls === "") {
      state.classFilter.clear();
    } else if (state.classFilter.has(cls)) {
      state.classFilter.delete(cls);
    } else {
      state.classFilter.add(cls);
    }
    renderClassChips();
    renderServantList();
    recalc();
  });
  // 特性筛选 chips
  $<HTMLSpanElement>("traitFilter").addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest(".trait-chip") as HTMLElement | null;
    if (!chip) return;
    const t = chip.dataset.trait!;
    if (state.traitFilter.has(t)) state.traitFilter.delete(t);
    else state.traitFilter.add(t);
    renderTraitChips();
    renderServantList();
    recalc();
  });

  // 从者: 全选 / 反选 (作用于当前筛选结果)
  $<HTMLButtonElement>("svSelectAll").addEventListener("click", () => {
    for (const s of visibleServants()) state.ownedSv.add(s.title);
    renderServantList();
    recalc();
  });
  $<HTMLButtonElement>("svSelectInvert").addEventListener("click", () => {
    for (const s of visibleServants()) {
      if (state.ownedSv.has(s.title)) state.ownedSv.delete(s.title);
      else state.ownedSv.add(s.title);
    }
    renderServantList();
    recalc();
  });
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main() {
  try {
    await loadData();
    renderSupportOptions();
    renderClassChips();

    // 恢复配置: URL 参数优先 (分享链接), 其次 localStorage
    let applied = false;
    const urlCfg = new URLSearchParams(location.search).get("cfg");
    if (urlCfg) {
      try {
        const p = parseConfig(decodeConfig(urlCfg), availableCeIds(), allTitles());
        if (p) {
          applyParsed(p);
          applied = true;
          persist(); // 链接配置也存入本地, 之后刷新页面依然生效
        }
      } catch {
        /* 无效链接忽略 */
      }
    }
    if (!applied) applied = applySavedConfig();

    renderTraitChips();
    renderCeList();
    renderServantList();
    bindEvents();
    bindRefreshButton();
    bindConfigButtons();
    void loadDataStatus();
    recalc();
  } catch (e) {
    $<HTMLDivElement>("result").innerHTML =
      `<div class="error-box">数据加载失败：${esc((e as Error).message)}<br>请确认 public/data/ 下存在 ces.json 与 servants.json，或点击「一键更新数据」重新拉取</div>`;
  }
}

void main();
