#!/usr/bin/env python3
"""Confronta due giri dello smoke test passo per passo.

    compare.py <out-dir-A> <out-dir-B> [--diff-dir DIR] [--max-lines N] [--fuzz N]

A è di solito la baseline, B il giro da verificare. Per ogni passo confronta
esito, URL, errori di console e di pagina, richieste fallite e risposte >= 400,
chiamate API, toast, testo visibile, valori dei campi e screenshot (differenza
pixel per pixel con Pillow; l'immagine della differenza — B schiarito, pixel
diversi in rosso — va in DIR, di default <B>/diff/).

Esce con 0 se i due giri sono identici, 1 se c'è almeno una differenza,
2 se mancano i report.
"""

import argparse
import difflib
import json
import os
import sys

try:
    from PIL import Image, ImageChops
except ImportError:  # pragma: no cover - Pillow sta nel venv del backend
    Image = ImageChops = None

LIST_FIELDS = [
    ("console", "console (error/warning)"),
    ("pageErrors", "errori di pagina"),
    ("failedRequests", "richieste fallite"),
    ("httpErrors", "risposte >= 400"),
    ("api", "chiamate API"),
    ("toasts", "toast"),
    ("fields", "campi"),
]


def load(out_dir):
    path = os.path.join(out_dir, "report.json")
    if not os.path.isfile(path):
        print(f"compare.py: {path} non esiste", file=sys.stderr)
        sys.exit(2)
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def udiff(a, b, name_a, name_b, max_lines):
    lines = list(difflib.unified_diff(a, b, name_a, name_b, lineterm="", n=2))
    if len(lines) > max_lines:
        extra = len(lines) - max_lines
        lines = lines[:max_lines] + [f"… ({extra} righe di diff omesse)"]
    return lines


def pixel_diff(path_a, path_b, out_path, fuzz):
    """(pixel diversi, totale, nota). Salva l'immagine della differenza se ce n'è."""
    if Image is None:
        return None, None, "Pillow non disponibile"
    a = Image.open(path_a).convert("RGB")
    b = Image.open(path_b).convert("RGB")
    note = ""
    if a.size != b.size:
        note = f"dimensioni diverse: {a.size[0]}x{a.size[1]} contro {b.size[0]}x{b.size[1]}"
        w, h = max(a.size[0], b.size[0]), max(a.size[1], b.size[1])
        pa, pb = Image.new("RGB", (w, h), (255, 0, 255)), Image.new("RGB", (w, h), (0, 255, 0))
        pa.paste(a, (0, 0))
        pb.paste(b, (0, 0))
        a, b = pa, pb
    diff = ImageChops.difference(a, b)
    if diff.getbbox() is None:
        return 0, a.size[0] * a.size[1], note
    r, g, bl = diff.split()
    mx = ImageChops.lighter(ImageChops.lighter(r, g), bl)
    mask = mx.point(lambda v: 255 if v > fuzz else 0)
    count = mask.histogram()[255]
    if count:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        base = Image.blend(b, Image.new("RGB", b.size, (255, 255, 255)), 0.7)
        red = Image.new("RGB", b.size, (230, 0, 0))
        Image.composite(red, base, mask).save(out_path)
    return count, a.size[0] * a.size[1], note


def main():
    ap = argparse.ArgumentParser(description="Confronta due report dello smoke test youty")
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--diff-dir", default=None, help="dove salvare le immagini di differenza (default <B>/diff)")
    ap.add_argument("--max-lines", type=int, default=60, help="righe massime di ogni diff di testo")
    ap.add_argument("--fuzz", type=int, default=0, help="differenza per canale tollerata (0-255, default 0)")
    opt = ap.parse_args()

    ra, rb = load(opt.a), load(opt.b)
    diff_dir = opt.diff_dir or os.path.join(opt.b, "diff")
    ma, mb = ra.get("meta", {}), rb.get("meta", {})
    print(f"A: {opt.a}  (repo {ma.get('repo')}, giorno {ma.get('date')}, ora simulata {ma.get('now')})")
    print(f"B: {opt.b}  (repo {mb.get('repo')}, giorno {mb.get('date')}, ora simulata {mb.get('now')})")
    if ma.get("now") != mb.get("now"):
        print("ATTENZIONE: i due giri simulano istanti diversi: date e orari nei testi saranno diversi"
              " (rilancia con SMOKE_DATE=%s)" % (ma.get("date") or "?"))

    sa = {s["name"]: s for s in ra.get("steps", [])}
    sb = {s["name"]: s for s in rb.get("steps", [])}
    only_a = [n for n in sa if n not in sb]
    only_b = [n for n in sb if n not in sa]
    common = [n for n in sa if n in sb]
    problems = 0
    changed_steps = []

    if only_a:
        problems += len(only_a)
        print(f"\n== Passi solo in A ({len(only_a)}): " + ", ".join(only_a))
    if only_b:
        problems += len(only_b)
        print(f"\n== Passi solo in B ({len(only_b)}): " + ", ".join(only_b))
    order_a = [n for n in sa if n in sb]
    order_b = [n for n in sb if n in sa]
    if order_a != order_b:
        problems += 1
        print("\n== L'ordine dei passi è diverso")

    live_a, live_b = ra.get("liveEndpoints", []), rb.get("liveEndpoints", [])
    if live_a != live_b:
        problems += 1
        print("\n== Endpoint del feed live diversi")
        for line in udiff(live_a, live_b, "A", "B", opt.max_lines):
            print("   " + line)

    px_total = 0
    for name in common:
        a, b = sa[name], sb[name]
        out = []
        if a.get("ok") != b.get("ok") or (a.get("error") or "") != (b.get("error") or ""):
            out.append(f"  esito: A {'ok' if a.get('ok') else 'ERRORE'}{' — ' + a['error'] if a.get('error') else ''}"
                       f" · B {'ok' if b.get('ok') else 'ERRORE'}{' — ' + b['error'] if b.get('error') else ''}")
        if a.get("url") != b.get("url"):
            out.append(f"  url: A {a.get('url')} · B {b.get('url')}")
        for key, label in LIST_FIELDS:
            la, lb = a.get(key) or [], b.get(key) or []
            if la != lb:
                out.append(f"  {label}:")
                out.extend("    " + line for line in udiff(la, lb, "A", "B", opt.max_lines))
        ta, tb = (a.get("text") or "").split("\n"), (b.get("text") or "").split("\n")
        if ta != tb:
            out.append("  testo della pagina:")
            out.extend("    " + line for line in udiff(ta, tb, "A", "B", opt.max_lines))
        shot_a, shot_b = a.get("screenshot"), b.get("screenshot")
        if shot_a and shot_b:
            pa, pb = os.path.join(opt.a, shot_a), os.path.join(opt.b, shot_b)
            if os.path.isfile(pa) and os.path.isfile(pb):
                target = os.path.join(diff_dir, os.path.basename(shot_b))
                count, total, note = pixel_diff(pa, pb, target, opt.fuzz)
                if count is None:
                    out.append(f"  screenshot: non confrontato ({note})")
                elif count or note:
                    px_total += count
                    pct = 100.0 * count / total if total else 0
                    out.append(f"  screenshot: {count} pixel diversi ({pct:.3f}%)"
                               + (f", {note}" if note else "") + (f" → {target}" if count else ""))
            else:
                out.append("  screenshot: file mancante")
        elif bool(shot_a) != bool(shot_b):
            out.append(f"  screenshot: A {shot_a or a.get('screenshotError')} · B {shot_b or b.get('screenshotError')}")
        if a.get("quiet") != b.get("quiet"):
            out.append(f"  nota: pagina ferma A={a.get('quiet')} B={b.get('quiet')} (cattura forse prematura)")
        if out:
            real = [o for o in out if not o.startswith("  nota:")]
            if real:
                problems += 1
                changed_steps.append(name)
            print(f"\n== {name}")
            print("\n".join(out))

    fail_a = sum(1 for s in sa.values() if not s.get("ok"))
    fail_b = sum(1 for s in sb.values() if not s.get("ok"))
    print("\n" + "-" * 72)
    print(f"passi: A {len(sa)} ({fail_a} falliti) · B {len(sb)} ({fail_b} falliti) · in comune {len(common)}")
    if problems:
        print(f"DIVERSI: {len(changed_steps)} passi con differenze"
              + (f", {len(only_a)} solo in A, {len(only_b)} solo in B" if only_a or only_b else "")
              + (f" · {px_total} pixel diversi in totale" if px_total else ""))
        if changed_steps:
            print("  " + ", ".join(changed_steps))
        return 1
    print("IDENTICI")
    return 0


if __name__ == "__main__":
    sys.exit(main())
