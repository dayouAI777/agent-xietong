# -*- coding: utf-8 -*-
"""朽木 gpt-image 生图客户端 v2
=========================================================
用法（在 C:/Users/Administrator/WorkBuddy/2026-11-03-21-21-45 目录下）:

  单张:
    python gen/gen_image.py "一位年轻女性站在雨后的老街，写实摄影"

  换模型 / 换尺寸 / 指定文件名:
    python gen/gen_image.py "提示词" -m gpt-image-2.5-sunburst -s 1536x1024 -o out/a.png

  同提示词出 3 张（各跑一次，不是一次请求多张）:
    python gen/gen_image.py "提示词" -n 3 -d out/

  批量（每行一个提示词，空行和 # 开头的行跳过）:
    python gen/gen_image.py -f prompts.txt -d out/

key: 优先读环境变量 UMAPIS_KEY，没有则读 密匙.txt 第一行
端点: 优先读环境变量 UMAPIS_BASE，默认 http://129.225.181.1:3000
=========================================================
"""
import argparse, base64, json, os, sys, time, urllib.request, urllib.error

KEY_FILE = r"C:\Users\Administrator\Desktop\生图API\密匙.txt"
DEFAULT_BASE = "http://129.225.181.1:3000"
API_PATH = "/v1/images/generations"
MODELS = ["gpt-image-2.5", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare",
          "gpt-image-2", "codex-gpt-image-2", "plus-codex-gpt-image-2"]

# 首尾质量词（2026-11-05 用户确认，GPT 系模型同样吃这套权重语法，实测质感提升）
QW_HEAD = "(masterpiece:1.2, best quality:1.2, highly detailed anime illustration, ultra-detailed:1.2)"
QW_TAIL = "(worst quality, low quality:1.4), (bad anatomy:1.2)"


def apply_quality_words(p):
    """首尾拼质量词；提示词里已含则不重复。"""
    p = p.strip()
    if "masterpiece" not in p:
        p = QW_HEAD + "\n\n" + p
    if "worst quality" not in p:
        p = p + "\n" + QW_TAIL
    return p


try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def get_key():
    k = os.environ.get("UMAPIS_KEY", "").strip()
    if k:
        return k
    with open(KEY_FILE, encoding="utf-8") as f:
        return f.readline().strip()


def get_base():
    b = os.environ.get("UMAPIS_BASE", "").strip() or DEFAULT_BASE
    return b.rstrip("/")


def gen(prompt, model, size, quality, key, retries=2):
    """出 1 张，返回 (bytes, 元信息dict)。失败自动重试。"""
    payload = {"model": model, "prompt": prompt, "size": size, "n": 1}
    if quality:
        payload["quality"] = quality
    url = get_base() + API_PATH
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={"Authorization": "Bearer " + key,
                         "Content-Type": "application/json"},
                method="POST")
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=300) as r:
                d = json.loads(r.read())
            it = d["data"][0]
            if it.get("b64_json"):
                img = base64.b64decode(it["b64_json"])
            else:
                img = urllib.request.urlopen(it["url"], timeout=120).read()
            it["elapsed"] = round(time.time() - t0, 1)
            return img, it
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")[:300]
            last = f"HTTP {e.code}: {body}"
        except Exception as e:
            last = f"{type(e).__name__}: {str(e)[:200]}"
        if attempt < retries:
            print(f"  重试 {attempt+1}/{retries} ... ({last})")
            time.sleep(3)
    raise RuntimeError(last)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", help="提示词")
    ap.add_argument("-f", "--file", help="批量提示词文件，每行一条")
    ap.add_argument("-o", "--out", help="输出文件路径（单张时用）")
    ap.add_argument("-d", "--dir", default="gen/out", help="输出目录，默认 gen/out")
    ap.add_argument("-m", "--model", default="gpt-image-2.5", help="模型名")
    ap.add_argument("-s", "--size", default="1024x1024",
                    help="尺寸或比例：1024x1024 / 1536x1024 / 1024x1536，也支持比例字符串如 \"16:9\" \"9:16\"")
    ap.add_argument("-q", "--quality", default=None, help="standard / hd")
    ap.add_argument("-n", "--n", type=int, default=1, help="同提示词出几张")
    ap.add_argument("--no-qw", action="store_true",
                    help="不加首尾质量词（默认自动加 masterpiece.../worst quality...）")
    ap.add_argument("--list-models", action="store_true")
    a = ap.parse_args()

    if a.list_models:
        print("\n".join(MODELS))
        return

    if a.file:
        raw = open(a.file, encoding="utf-8").read()
        if "\n---\n" in raw:
            # 多条用 --- 分隔（每条内部可多行）
            prompts = [p.strip() for p in raw.split("\n---\n") if p.strip()]
        else:
            # 整份文件当作一条：去掉 # 注释行，保留换行
            body = "\n".join(l for l in raw.splitlines()
                             if not l.strip().startswith("#"))
            prompts = [body.strip()] if body.strip() else []
            if a.n > 1:
                prompts = prompts * a.n   # -f 时 -n 也生效（同一提示词跑 n 次）
    elif a.prompt:
        prompts = [a.prompt] * max(1, a.n)
    else:
        ap.error("要么给提示词，要么用 -f 给文件")

    key = get_key()
    os.makedirs(a.dir, exist_ok=True)
    stamp = time.strftime("%m%d_%H%M")
    ok = 0
    for i, p in enumerate(prompts, 1):
        if not a.no_qw:
            p = apply_quality_words(p)
        out = a.out if (a.out and len(prompts) == 1) else os.path.join(
            a.dir, f"{stamp}_{i:02d}.png")
        if not os.path.isabs(out) and not os.path.dirname(out):
            out = os.path.join(a.dir, out)
        if not os.path.splitext(out)[1]:
            out += ".png"
        try:
            print(f"[{i}/{len(prompts)}] {p[:40]}...")
            img, meta = gen(p, a.model, a.size, a.quality, key)
            _d = os.path.dirname(out)
            if _d:
                os.makedirs(_d, exist_ok=True)
            open(out, "wb").write(img)
            # 同步落一份提示词，方便回看与复现
            with open(out + ".prompt.txt", "w", encoding="utf-8") as f:
                f.write(f"时间: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
                f.write(f"模型: {a.model}\n")
                f.write(f"请求尺寸: {a.size}  实际尺寸: {meta.get('width')}x{meta.get('height')}\n")
                f.write(f"耗时: {meta.get('elapsed')}s\n")
                f.write("-" * 40 + "\n")
                f.write(p + "\n")
            print(f"  OK {out} {len(img)//1024}KB "
                  f"{meta.get('width')}x{meta.get('height')} {meta['elapsed']}s")
            ok += 1
        except Exception as e:
            print(f"  FAIL {e}")
    print(f"完成 {ok}/{len(prompts)}")
    # 一张都没出就非 0 退出，让内核（看板）正确标记 failed，而不是假 done
    if ok == 0:
        sys.exit(1)

    # 出图后自动重建提示词总索引
    if ok:
        try:
            import subprocess
            here = os.path.dirname(os.path.abspath(__file__))
            subprocess.run([sys.executable, os.path.join(here, "rebuild_index.py")],
                           capture_output=True, timeout=30)
        except Exception as e:
            print(f"  索引更新失败: {e}")


if __name__ == "__main__":
    main()
