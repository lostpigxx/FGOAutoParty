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
    return {
        "name": b.get("中文名", "").strip(),
        "jpName": b.get("日文名", "").strip(),
        "rarity": int(re.search(r"(\d)", b.get("稀有度", "0")).group(1) if b.get("稀有度") else 0),
        "attr1": b.get("属性1", "").strip(),
        "attr2": b.get("属性2", "").strip(),
        "gender": b.get("性别", "").strip(),
        "subAttr": b.get("副属性", "").strip(),
        "className": b.get("职阶", "").strip(),
        "traits": traits,
        "hasCostume": has_costume,
    }


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    # 1. 概念礼装
    print("== 概念礼装分类成员 ==", file=sys.stderr)
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
