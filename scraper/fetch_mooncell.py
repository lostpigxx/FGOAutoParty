#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 Mooncell (fgo.wiki) 抓取概念礼装与从者数据。

输出:
  data/raw_ces.json     - 全部概念礼装的 wikitext 原文
  data/ces.json         - 解析后的礼装字段 (含牵绊效果、特性条件)
  data/raw_servants.json - 全部从者页 wikitext 原文
  data/servants.json    - 从者列表 (名称, 稀有度, 属性, 性别, 副属性, 职阶, 特性)
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://fgo.wiki/api.php"
HEADERS = {"User-Agent": "FGO-TeamBuilder/0.1 (personal tool; contact: local)"}
DELAY = 0.35

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
os.makedirs(DATA_DIR, exist_ok=True)


def api_get(params, retries=4):
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            print(f"  retry {attempt + 1}/{retries} after error: {e}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def _api_batch(params, retries=4):
    """通用 MediaWiki GET (批量 titles 用)"""
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError("unreachable")


def all_category_members(category, limit=500):
    titles = []
    cont = {}
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": f"Category:{category}",
            "cmlimit": str(limit),
            "format": "json",
        }
        params.update(cont)
        data = api_get(params)
        for m in data["query"]["categorymembers"]:
            titles.append(m["title"])
        if "continue" in data:
            cont = data["continue"]
        else:
            break
        time.sleep(DELAY)
    return titles


def fetch_wikitext_batch(titles):
    params = {
        "action": "query",
        "titles": "|".join(titles),
        "prop": "revisions",
        "rvprop": "content",
        "rvslots": "main",
        "format": "json",
        "formatversion": "2",
    }
    data = api_get(params)
    out = {}
    for page in data.get("query", {}).get("pages", []):
        revs = page.get("revisions") or []
        if revs and "slots" in revs[0]:
            slot = revs[0]["slots"]["main"]
            out[page["title"]] = slot.get("content") or slot.get("*") or ""
    return out


def fetch_all_wikitext(titles, batch=40, label=""):
    out = {}
    for i in range(0, len(titles), batch):
        chunk = titles[i:i + batch]
        try:
            out.update(fetch_wikitext_batch(chunk))
        except Exception as e:  # noqa: BLE001
            print(f"  !! batch {i}-{i+len(chunk)} failed: {e}", file=sys.stderr)
        if label:
            print(f"  {label}: {min(i+batch, len(titles))}/{len(titles)}", file=sys.stderr)
        time.sleep(DELAY)
    return out


# ---------------------------------------------------------------------------
# wikitext 模板解析
# ---------------------------------------------------------------------------

def extract_template_body(wikitext, name):
    """扫描 {{name ...}} 模板体 (括号深度法, 兼容嵌套模板)。"""
    start = wikitext.find("{{" + name)
    if start == -1:
        return None
    depth = 0
    i = start + 2
    while i < len(wikitext):
        if wikitext.startswith("{{", i):
            depth += 1
            i += 2
        elif wikitext.startswith("}}", i):
            if depth == 0:
                return wikitext[start + 2 + len(name):i]
            depth -= 1
            i += 2
        else:
            i += 1
    return None


def parse_template(wikitext, name):
    """提取 {{name ...}} 模板的参数 dict (取第一个匹配)。"""
    body = extract_template_body(wikitext, name)
    if body is None:
        return {}
    body = body.lstrip("\n\r ")
    params = {}
    cur_key = None
    cur_val = []
    for line in body.splitlines():
        lm = re.match(r"^\s*\|([^=]+)=(.*)$", line)
        if lm:
            if cur_key is not None:
                params[cur_key] = "\n".join(cur_val).strip()
            cur_key = lm.group(1).strip()
            cur_val = [lm.group(2)]
        else:
            if cur_key is not None:
                cur_val.append(line)
    if cur_key is not None:
        params[cur_key] = "\n".join(cur_val).strip()
    return params


def parse_all_templates(wikitext, name):
    """提取页面中所有 {{name ...}} 模板的参数 dict。"""
    results = []
    pos = 0
    while True:
        idx = wikitext.find("{{" + name, pos)
        if idx == -1:
            break
        body = extract_template_body(wikitext[idx:], name)
        if body is None:
            break
        body = body.lstrip("\n\r ")
        params = {}
        cur_key = None
        cur_val = []
        for line in body.splitlines():
            lm = re.match(r"^\s*\|([^=]+)=(.*)$", line)
            if lm:
                if cur_key is not None:
                    params[cur_key] = "\n".join(cur_val).strip()
                cur_key = lm.group(1).strip()
                cur_val = [lm.group(2)]
            else:
                if cur_key is not None:
                    cur_val.append(line)
        if cur_key is not None:
            params[cur_key] = "\n".join(cur_val).strip()
        results.append(params)
        pos = idx + 2 + len(name)
    return results


# ---------------------------------------------------------------------------
# 概念礼装解析
# ---------------------------------------------------------------------------

BOND_CLAUSE_RE = re.compile(
    r"牵绊值增加\s*([\d.]+)%"
    r"|获得.{0,8}牵绊值增加\s*([\d.]+)%"
    r"|牵绊值提升\s*([\d.]+)%"
    r"|牵绊获得量提升\s*([\d.]+)%"
    r"|絆ポイント.{0,14}?([\d.]+)%"
)
SUPPORT_CLAUSE_RE = re.compile(r"助战时增加\s*([\d.]+)%|サポート時.{0,6}([\d.]+)%")
TRAIT_RE = re.compile(r"\{\{特攻\|([^|}]+)")


def parse_bond_effect(text):
    """从礼装持有技能文本解析牵绊加成。

    返回 list[dict]:
      {bonus, scope: party|self|support, mlb, supportBonus}
    """
    if not text:
        return []
    results = []
    for line in text.splitlines():
        mlb = "最大解放" in line or "MAX" in line.upper()
        m = BOND_CLAUSE_RE.search(line)
        if not m:
            continue
        bonus = float(next(g for g in m.groups() if g))
        # 所有羁绊加成礼装均对全队生效 (含特性条件类: 全队中符合特性者共享)
        # 唯一例外: 助战时(サポート時)有额外数值的礼装 (如午茶时光)
        if "助战时" in line or "サポート時" in line or "支援时" in line:
            scope = "support"
        else:
            scope = "party"
        support_bonus = None
        if scope == "support":
            sm = SUPPORT_CLAUSE_RE.search(line)
            if sm:
                support_bonus = float(next(g for g in sm.groups() if g))
        results.append({
            "bonus": bonus,
            "scope": scope,
            "mlb": mlb,
            "supportBonus": support_bonus,
        })
    return results


def parse_ce(wikitext):
    params = parse_template(wikitext, "概念礼装")
    if not params:
        return None
    skill = params.get("持有技能", "")
    # 特性条件: {{特攻|特性名|...}} 的 OR 列表
    traits = list(dict.fromkeys(TRAIT_RE.findall(skill)))
    return {
        "id": params.get("礼装id", "").strip(),
        "name": params.get("名称", "").strip(),
        "jpName": params.get("日文名称", "").strip(),
        "rarity": int(params.get("稀有度", "0").strip() or 0),
        "cost": int(params.get("cost", "0").strip() or 0),
        "icon": params.get("图标", "").strip(),
        "category": params.get("礼装分类", "").strip(),
        "skill": skill,
        "traits": traits,
        "bond": parse_bond_effect(skill),
    }


# ---------------------------------------------------------------------------
# 从者解析
# ---------------------------------------------------------------------------

def parse_servant(wikitext):
    blocks = parse_all_templates(wikitext, "基础数值")
    if not blocks:
        return None
    b = blocks[0]
    if not b.get("中文名"):
        return None
    traits = []
    i = 1
    while f"特性{i}" in b:
        v = b[f"特性{i}"].strip()
        if v and v not in traits:
            traits.append(v)
        i += 1
    # 有灵衣开放区块 = 该从者有灵衣 (玩家默认视为已解锁「持有灵衣之人」特性)
    has_costume = "===灵衣开放===" in wikitext or "{{灵衣开放素材" in wikitext
    base = {
        "name": b.get("中文名", "").strip(),
        "jpName": b.get("日文名", "").strip(),
        "collectionNo": int(re.search(r"(\d+)", b.get("序号", "0")).group(1) if b.get("序号") else 0),
        "rarity": int(re.search(r"(\d)", b.get("稀有度", "0")).group(1) if b.get("稀有度") else 0),
        "attr1": b.get("属性1", "").strip(),
        "attr2": b.get("属性2", "").strip(),
        "gender": b.get("性别", "").strip(),
        "subAttr": b.get("副属性", "").strip(),
        "className": b.get("职阶", "").strip(),
        "traits": traits,
        "hasCostume": has_costume,
    }
    # 显式 COST 覆盖 (全游戏仅 玛修: COST=0, 所有形态不占 cost; 普通从者无此字段 -> 由稀有度推导)
    for blk in blocks:
        if blk.get("COST") is not None:
            m = re.search(r"(\d+)", blk["COST"])
            if m:
                base["cost"] = int(m.group(1))
            break
    forms = parse_servant_forms(wikitext, blocks)
    if forms:
        base["forms"] = forms
    return base


# ---------------------------------------------------------------------------
# 战斗形象/灵衣 形态解析
#   少数从者的属性/性别/副属性/特性随「战斗形象」或「灵衣」变化 (如 U-奥尔加玛丽:
#   形象1、2 为恶/星, 形象3 为善/人)。Mooncell 页面用两种方式描述:
#     a) 特性N 后的「特性N备注=(战斗形象1 2)」等
#     b) 基础数值下散文: 「战斗形象1、2时为恶属性…，战斗形象3时为善属性…」
#   输出 forms: [{key,label,attr1?,attr2?,gender?,subAttr?,traits[]}]
# ---------------------------------------------------------------------------

# 备注文本中, 表明该特性只在「某件灵衣/特殊战斗形态」下存在的词 (非 战斗形象N 也非纯背景说明)
_COSTUME_HINTS = (
    "灵衣", "泳装", "简易", "回忆", "兔女郎", "菩萨", "龙体", "人形", "之孔",
    "魔性", "兔子", "总统", "泳", "圣诞", "万圣",
)
# 纯背景/剧情说明类备注: 特性恒常存在, 不随战斗形象变化
_LORE_HINTS = ("拟似从者", "亚从者", "职阶技能", "通关LB6", "通关Lostbelt", "幕间", "技能")


def parse_servant_forms(wikitext, blocks):
    """解析 战斗形象1/2/3 + 灵衣 + 第二灵基家族 的形态特性; 无差异时返回 []。"""
    b = blocks[0]
    stage_notes = {1: [], 2: [], 3: []}  # 形象N -> 特性列表
    costume_notes = []  # 只在灵衣形态出现的特性
    lore_traits = []  # 背景说明类备注的特性 (如 (亚从者) 的 天地从者): 恒常, 所有形态都有
    i = 1
    while f"特性{i}" in b:
        val = b.get(f"特性{i}", "").strip()
        note = b.get(f"特性{i}备注", "").strip()
        if val and note:
            ns = note.strip("()（） ")
            # 备注如 (战斗形象1 2) / (战斗形象3) / (战斗形象3 灵衣) —— 取 战斗形象 后所有数字
            stages = sorted(
                {
                    int(x)
                    for seg in re.findall(r"战斗形象([0-9、\s]+)", ns)
                    for x in re.findall(r"\d+", seg)
                }
            )
            if stages:
                for s in stages:
                    if 1 <= s <= 3 and val not in stage_notes[s]:
                        stage_notes[s].append(val)
            elif any(h in ns for h in _COSTUME_HINTS) and not any(h in ns for h in _LORE_HINTS):
                if val not in costume_notes:
                    costume_notes.append(val)
            else:
                # (拟似从者/亚从者/通关LB6 等背景说明) -> 特性恒常
                if val not in lore_traits:
                    lore_traits.append(val)
        i += 1

    # 散文: 战斗形象X时为 [[属性：A|A]]·[[属性：B|B]]属性、[[副属性：S|S]]之力、[[性别：G|G]]
    # 给出 各形象 的 属性1/属性2/副属性/性别 (比编号字段 属性22/副属性2 更完整)
    prose_stage_attr = {}  # stage -> {attr1?, attr2?, gender?, subAttr?}
    for ln in wikitext.splitlines():
        if "战斗形象" not in ln or "时" not in ln:
            continue
        for m in re.finditer(r"战斗形象([0-9、\s]+)时", ln):
            stages = sorted({int(x) for x in re.findall(r"\d+", m.group(1))})
            if not stages:
                continue
            clause = ln[m.end():]
            # 截到下一个 战斗形象…时 或句末
            nxt = re.search(r"战斗形象[0-9、\s]+时", clause)
            seg = clause[: nxt.start()] if nxt else clause
            links = re.findall(r"\[\[([^\]|]+)\|([^\]]+)\]\]", seg)
            rec = {}
            attr_vals = []
            for target, shown in links:
                t = target.strip()
                if t.startswith("属性："):
                    attr_vals.append(shown.strip())
                elif t.startswith("副属性："):
                    rec["subAttr"] = shown.strip()
                elif t.startswith("性别："):
                    rec["gender"] = shown.strip()
            if len(attr_vals) >= 2:  # 「秩序」·「善」两个属性链接
                rec["attr1"], rec["attr2"] = attr_vals[0], attr_vals[1]
            elif len(attr_vals) == 1:
                rec["attr2"] = attr_vals[0]
            if rec:
                for s in stages:
                    if 1 <= s <= 3:
                        prose_stage_attr.setdefault(s, {}).update(rec)

    if not (
        any(stage_notes.values()) or costume_notes or prose_stage_attr
    ):
        return []

    # 灵衣形态 (仅当页面列出 灵衣开放素材; 其属性/特性 = 形象1 的 + 专属灵衣备注特性)
    costumes = []
    for block in parse_all_templates(wikitext, "灵衣开放素材"):
        no = re.search(r"(\d+)", block.get("序号", ""))
        nm = block.get("中文名称", "").strip()
        if no:
            costumes.append({"key": f"灵衣{no.group(1)}", "label": nm or f"灵衣{no.group(1)}"})

    base_attr1 = b.get("属性1", "").strip()
    base_attr2 = b.get("属性2", "").strip()
    base_gender = b.get("性别", "").strip()
    base_sub = b.get("副属性", "").strip()

    # 无散文时, 用编号字段兜底: 属性2=形象1, 属性22=形象2, 属性23=形象3 (副属性同理)
    def _num_field(prefix):
        vals = {1: b.get(prefix, "").strip()}
        for n in (2, 3):
            if b.get(f"{prefix}{n}"):
                vals[n] = b[f"{prefix}{n}"].strip()
        return vals

    attr2_fb = _num_field("属性2")
    sub_fb = _num_field("副属性")

    # 恒常特性: 无备注 + 背景说明类备注 (亚从者/拟似从者 等)
    always = []
    i = 1
    while f"特性{i}" in b:
        val = b.get(f"特性{i}", "").strip()
        note = b.get(f"特性{i}备注", "").strip()
        if val and not note and val not in always:
            always.append(val)
        i += 1
    for t in lore_traits:
        if t not in always:
            always.append(t)

    forms = []
    for s in (1, 2, 3):
        pa = prose_stage_attr.get(s, {})
        traits = list(always)
        for t in stage_notes[s]:
            if t not in traits:
                traits.append(t)
        forms.append({
            "key": f"形象{s}",
            "label": f"战斗形象{s}",
            "attr1": pa.get("attr1", base_attr1),
            "attr2": pa.get("attr2", attr2_fb.get(s, base_attr2)),
            "gender": pa.get("gender", base_gender),
            "subAttr": pa.get("subAttr", sub_fb.get(s, base_sub)),
            "traits": traits,
        })
    for c in costumes:
        base_form = forms[0]
        traits = list(base_form["traits"])
        for t in costume_notes:
            if t not in traits:
                traits.append(t)
        forms.append({
            "key": c["key"],
            "label": c["label"],
            "attr1": base_form["attr1"],
            "attr2": base_form["attr2"],
            "gender": base_form["gender"],
            "subAttr": base_form["subAttr"],
            "traits": traits,
        })

    # ---- 第二灵基家族 (同从者第二块 基础数值; 目前仅 玛修 Paladin 等: 稀有度/副属性/特性不同) ----
    if len(blocks) > 1:
        no_re = re.search(r"(\d+)", b.get("序号", ""))
        main_no = no_re.group(1) if no_re else None
        main_traits = set()
        k = 1
        while f"特性{k}" in b:
            v = b[f"特性{k}"].strip()
            if v:
                main_traits.add(v)
            k += 1
        for alt in blocks[1:]:
            if not alt.get("中文名"):
                continue
            ano = re.search(r"(\d+)", alt.get("序号", ""))
            if main_no and ano and ano.group(1) != main_no:
                continue
            alt_traits = []
            k = 1
            while f"特性{k}" in alt:
                v = alt[f"特性{k}"].strip()
                if v and v not in alt_traits:
                    alt_traits.append(v)
                k += 1
            # 与主家族完全相同则跳过 (避免重复)
            if (
                alt.get("稀有度") == b.get("稀有度")
                and alt.get("属性1") == b.get("属性1")
                and alt.get("属性2") == b.get("属性2")
                and alt.get("性别") == b.get("性别")
                and alt.get("副属性") == b.get("副属性")
                and set(alt_traits) == main_traits
            ):
                continue
            # 该家族可切换形态 = 其立绘名单 (Paladin / 常夏的泳装Ver.03 / ...)
            seen = set()
            k = 1
            while f"立绘{k}" in alt:
                label = alt[f"立绘{k}"].strip()
                k += 1
                if not label or label in seen:
                    continue
                seen.add(label)
                forms.append({
                    "key": f"形态:{label}",
                    "label": label,
                    "attr1": alt.get("属性1", "").strip(),
                    "attr2": alt.get("属性2", "").strip(),
                    "gender": alt.get("性别", "").strip(),
                    "subAttr": alt.get("副属性", "").strip(),
                    "traits": list(alt_traits),
                })
    return forms


# ---------------------------------------------------------------------------
# 礼装卡面图下载
#   列表会展示的羁绊礼装 (自己佩戴最高加成 ≥5%) 下载卡面原图 (512px) 到
#   data/ce-img/{礼装id}.png, 并同步 public/data/ce-img/ 与 dist/data/ce-img/。
# ---------------------------------------------------------------------------

def _own_max_bonus(ce):
    """与前端 ownEquipUsable 对齐: 自己佩戴(普通/满破)最高加成 >= 5 才需要图"""
    vals = []
    for e in ce.get("bond", []):
        try:
            vals.append(float(e.get("bonus", 0)))
        except (TypeError, ValueError):
            continue
    return max(vals) if vals else 0


def download_ce_art(ces, raw, out_dir, copy_dirs=()):
    """下载礼装卡面; 返回 (成功数, 缺失列表)。out_dir 已存在时逐张更新。"""
    import time
    want = [c for c in ces if _own_max_bonus(c) >= 5 and c.get("id")]
    # 候选文件名: 页面 图片名/页面标题 × png/jpg
    cand_file = {}  # ce id -> 候选文件标题列表
    page_of = {}  # ce id -> 页面标题
    for c in want:
        title = c.get("name", "")
        rt = None
        if title in raw:
            rt = title
        else:
            for k in raw:
                if title and (k.startswith(title) or title in k) and len(k) <= len(title) + 8:
                    rt = k
                    break
        if not rt:
            continue
        page_of[c["id"]] = rt
        names = []
        m = re.search(r"^\|图片名=([^\n|]+)", raw[rt], re.M)
        if m:
            names.append(m.group(1).strip())
        if rt not in names:
            names.append(rt)
        files = []
        for n in names:
            for ext in (".png", ".jpg", ".jpeg"):
                files.append(f"文件:{n}{ext}")
        cand_file[c["id"]] = files
    # 批量 imageinfo 探测存在性
    found_url = {}  # file title -> url
    pending = sorted({f for files in cand_file.values() for f in files})
    def _api(params):
        url = "https://fgo.wiki/api.php?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.loads(r.read().decode("utf-8"))
    for i in range(0, len(pending), 40):
        chunk = pending[i : i + 40]
        try:
            d = _api({"action": "query", "titles": "|".join(chunk), "prop": "imageinfo",
                      "iiprop": "url|size", "format": "json", "formatversion": "2"})
            for pg in d["query"]["pages"]:
                if "missing" not in pg and pg.get("imageinfo"):
                    found_url[pg["title"]] = pg["imageinfo"][0]["url"]
        except Exception as e:  # noqa: BLE001
            print(f"  imageinfo 查询失败: {e}", file=sys.stderr)
        time.sleep(0.2)
    os.makedirs(out_dir, exist_ok=True)
    ok, missing = 0, []
    for c in want:
        cid = c["id"]
        rt = page_of.get(cid)
        url = None
        if rt:
            for f in cand_file.get(cid, []):
                if f in found_url:
                    url = found_url[f]
                    break
            if url is None:
                # 兜底: 页面直接引用的图片文件
                try:
                    d = _api({"action": "query", "titles": rt, "prop": "images",
                              "format": "json", "formatversion": "2"})
                    for im in d["query"]["pages"][0].get("images", []):
                        t = im["title"]
                        if re.search(r"\.(png|jpe?g|webp)$", t, re.I) and t in found_url:
                            url = found_url[t]
                            break
                except Exception:  # noqa: BLE001
                    pass
        if not url:
            missing.append(c.get("name", cid))
            continue
        dest = os.path.join(out_dir, f"{cid}.png")
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            with open(dest, "wb") as f:
                f.write(data)
            ok += 1
        except Exception as e:  # noqa: BLE001
            missing.append(f"{c.get('name')}: {e}")
        time.sleep(0.2)
    import shutil
    for d in copy_dirs:
        os.makedirs(d, exist_ok=True)
        shutil.copytree(out_dir, d, dirs_exist_ok=True)
    return ok, missing


# ---------------------------------------------------------------------------
# 从者头像图下载 (64px 缩略, 命名 {页面标题}.png)
#   来源: 页面「再临阶段图标」模板的 status 图标 (456/481), 兜底 prop=images 头像。
# ---------------------------------------------------------------------------

def _status_first_icon(wt):
    """取首个「再临阶段图标」块的 图标 首项 (基础 1 阶段头像)"""
    for m in re.finditer(r"\{\{再临阶段图标\s*\n?([\s\S]*?)\}\}", wt):
        mm = re.search(r"^\|图标=([^\n|]+)", m.group(1), re.M)
        if mm:
            toks = [x.strip() for x in mm.group(1).split(";;") if x.strip()]
            if toks:
                return toks[0]
    return None


def _pick_avatar(files):
    """从页面引用的文件中挑 头像: 优先 初始/1阶段, 排除 灵衣/2-3阶段/满破/图标"""
    av = [f for f in files if "头像" in f]
    if not av:
        return None
    def score(f):
        s = 0
        if "灵衣" in f or "２" in f or "2阶段" in f or "3阶段" in f or "三破" in f or "二破" in f or "满破" in f:
            s += 10
        if "初始" in f or "1阶段" in f or "一破" in f:
            s -= 2
        if re.search(r"头像1阶段|头像初始", f):
            s -= 1
        return s
    return min(av, key=score)


def download_sv_avatars(raw, out_dir, copy_dirs=(), width=64):
    """下载从者头像; 返回 (成功, 缺失列表)。"""
    import time
    picks = {}  # 页面标题 -> 文件名 (不带 文件: 前缀)
    for t, wt in raw.items():
        st = _status_first_icon(wt)
        if st:
            picks[t] = st
    # 兜底: prop=images 头像扫描 (仅未覆盖页)
    todo = [t for t in raw if t not in picks]
    for i in range(0, len(todo), 40):
        chunk = todo[i : i + 40]
        try:
            d = _api_batch({"action": "query", "titles": "|".join(chunk), "prop": "images",
                            "imlimit": 200, "format": "json", "formatversion": "2"})
            for pg in d["query"]["pages"]:
                if pg["title"] not in picks:
                    pick = _pick_avatar([im["title"] for im in pg.get("images", [])])
                    if pick:
                        picks[pg["title"]] = pick.replace("文件:", "", 1)
        except Exception as e:  # noqa: BLE001
            print(f"  images 查询失败: {e}", file=sys.stderr)
        time.sleep(0.2)
    print(f"  发现头像 {len(picks)}/{len(raw)}", file=sys.stderr)
    # 批量 imageinfo(64px 缩略); MediaWiki 规范化会把 _ 显示为空格, key 统一归一
    norm = lambda x: x.replace("_", " ")
    file_to_url = {}
    pending = sorted(set(norm(f) for f in picks.values()))
    for i in range(0, len(pending), 40):
        chunk = pending[i : i + 40]
        try:
            d = _api_batch({"action": "query", "titles": "|".join("文件:" + f for f in chunk),
                            "prop": "imageinfo", "iiprop": "url|size", "iiurlwidth": width,
                            "format": "json", "formatversion": "2"})
            for pg in d["query"]["pages"]:
                if "missing" not in pg and pg.get("imageinfo"):
                    file_to_url[norm(pg["title"].replace("文件:", "", 1))] = (
                        pg["imageinfo"][0].get("thumburl") or pg["imageinfo"][0]["url"]
                    )
        except Exception as e:  # noqa: BLE001
            print(f"  imageinfo 失败: {e}", file=sys.stderr)
        time.sleep(0.2)
    # 真实缺失(status 文件未收录)的页面: prop=images 头像兜底
    need_fb = [t for t, f in picks.items() if norm(f) not in file_to_url]
    for i in range(0, len(need_fb), 40):
        chunk = need_fb[i : i + 40]
        try:
            d = _api_batch({"action": "query", "titles": "|".join(chunk), "prop": "images",
                            "imlimit": 200, "format": "json", "formatversion": "2"})
            for pg in d["query"]["pages"]:
                pick = _pick_avatar([im["title"] for im in pg.get("images", [])])
                if not pick:
                    continue
                ii = _api_batch({"action": "query", "titles": pick, "prop": "imageinfo",
                                 "iiprop": "url|size", "iiurlwidth": width,
                                 "format": "json", "formatversion": "2"})
                for q in ii["query"]["pages"]:
                    if "missing" not in q and q.get("imageinfo"):
                        picks[pg["title"]] = q["title"].replace("文件:", "", 1)
                        file_to_url[norm(picks[pg["title"]])] = (
                            q["imageinfo"][0].get("thumburl") or q["imageinfo"][0]["url"]
                        )
        except Exception as e:  # noqa: BLE001
            print(f"  头像兜底失败: {e}", file=sys.stderr)
        time.sleep(0.2)
    os.makedirs(out_dir, exist_ok=True)
    # 清理旧文件 (来源策略变化可能遗留)
    for old in os.listdir(out_dir):
        os.unlink(os.path.join(out_dir, old))
    ok, missing = 0, []
    for t, f in picks.items():
        url = file_to_url.get(norm(f))
        if not url:
            missing.append(t)
            continue
        dest = os.path.join(out_dir, f"{t}.png")
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            with open(dest, "wb") as fh:
                fh.write(data)
            ok += 1
        except Exception as e:  # noqa: BLE001
            missing.append(f"{t}: {e}")
        time.sleep(0.12)
    import shutil
    for d in copy_dirs:
        os.makedirs(d, exist_ok=True)
        shutil.copytree(out_dir, d, dirs_exist_ok=True)
    return ok, missing


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    ce_titles = all_category_members("概念礼装")
    print(f"  共 {len(ce_titles)} 张礼装页", file=sys.stderr)
    raw = fetch_all_wikitext(ce_titles, label="礼装")
    with open(os.path.join(DATA_DIR, "raw_ces.json"), "w", encoding="utf-8") as f:
        json.dump(raw, f, ensure_ascii=False, indent=1)

    ces = []
    for title, wt in raw.items():
        ce = parse_ce(wt)
        if ce:
            ces.append(ce)
    with open(os.path.join(DATA_DIR, "ces.json"), "w", encoding="utf-8") as f:
        json.dump(ces, f, ensure_ascii=False, indent=1)
    print(f"  解析出 {len(ces)} 张礼装", file=sys.stderr)

    # 2. 从者
    print("== 英灵图鉴分类成员 ==", file=sys.stderr)
    try:
        sv_titles = all_category_members("英灵图鉴")
    except Exception as e:  # noqa: BLE001
        print(f"  分类获取失败: {e}", file=sys.stderr)
        sv_titles = []
    print(f"  共 {len(sv_titles)} 个从者页", file=sys.stderr)
    sv_raw = fetch_all_wikitext(sv_titles, label="从者")
    with open(os.path.join(DATA_DIR, "raw_servants.json"), "w", encoding="utf-8") as f:
        json.dump(sv_raw, f, ensure_ascii=False, indent=1)

    servants = []
    for title, wt in sv_raw.items():
        sv = parse_servant(wt)
        if sv and sv["name"]:
            sv["title"] = title
            servants.append(sv)
    with open(os.path.join(DATA_DIR, "servants.json"), "w", encoding="utf-8") as f:
        json.dump(servants, f, ensure_ascii=False, indent=1)
    print(f"  解析出 {len(servants)} 名从者", file=sys.stderr)

    # 3. 同步到 public/data/ (前端直接加载, 无需每次爬虫)
    import shutil
    public_dir = os.path.join(HERE, "..", "public", "data")
    os.makedirs(public_dir, exist_ok=True)
    for f in ("ces.json", "servants.json"):
        shutil.copy(os.path.join(DATA_DIR, f), os.path.join(public_dir, f))
    print("  已同步到 public/data/", file=sys.stderr)

    # 3.5 礼装卡面图 (列表展示的 ≥5% 礼装; 需要网络, 失败不影响主流程)
    try:
        art_dir = os.path.join(DATA_DIR, "ce-img")
        dist_art = os.path.join(HERE, "..", "dist", "data", "ce-img")
        ok, missing = download_ce_art(ces, raw, art_dir, copy_dirs=(os.path.join(public_dir, "ce-img"), dist_art))
        print(f"  礼装卡面图下载完成: {ok} 张", file=sys.stderr)
        if missing:
            print(f"  缺失 {len(missing)} 张: {missing[:10]}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"  礼装卡面图下载失败(跳过): {e}", file=sys.stderr)

    # 3.6 从者头像 (96px; 需要网络, 失败不影响主流程)
    try:
        av_dir = os.path.join(DATA_DIR, "sv-avatar")
        dist_av = os.path.join(HERE, "..", "dist", "data", "sv-avatar")
        ok2, miss2 = download_sv_avatars(
            sv_raw, av_dir, copy_dirs=(os.path.join(public_dir, "sv-avatar"), dist_av)
        )
        print(f"  从者头像下载完成: {ok2} 张", file=sys.stderr)
        if miss2:
            print(f"  缺失 {len(miss2)} 张: {miss2[:10]}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(f"  从者头像下载失败(跳过): {e}", file=sys.stderr)

    # 3. 摘要
    bond_ces = [c for c in ces if c["bond"]]
    print(f"\n== 牵绊加成礼装共 {len(bond_ces)} 张 ==", file=sys.stderr)
    for c in sorted(bond_ces, key=lambda x: (-max(e["bonus"] for e in x["bond"]), x["name"])):
        eff = "; ".join(
            f"{e['scope']}+{e['bonus']:g}%{'[MLB]' if e['mlb'] else ''}"
            + (f"(助战{e['supportBonus']:g}%)" if e["supportBonus"] is not None else "")
            for e in c["bond"]
        )
        cond = f" 特性:{c['traits']}" if c["traits"] else ""
        print(f"  {c['name']} ★{c['rarity']} cost{c['cost']}: {eff}{cond}", file=sys.stderr)

    print("\n== 完成 ==", file=sys.stderr)


if __name__ == "__main__":
    main()
