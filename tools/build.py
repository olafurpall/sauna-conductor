#!/usr/bin/env python3
"""Build the hosted copy of Sauna Conductor (GitHub Pages).

Copies index.html, css/ and js/ into an output folder (default: docs/) and adds
?v=<version>-<hash> to every stylesheet, script and module import, so a new
version never mixes with cached files from the old one.

    python3 tools/build.py [--out docs] [--cname sauna.roadtalk.io]
"""
import argparse, hashlib, pathlib, re, shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
IMPORT_RE = re.compile(r"""((?:\bfrom|\bimport)\s*\(?\s*)(['"])(\.{1,2}/[^'"?]+\.js)\2""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='docs')
    ap.add_argument('--cname', default='')
    a = ap.parse_args()
    out = (ROOT / a.out).resolve()

    vendor = sorted(p for p in (ROOT / 'js' / 'vendor').rglob('*') if p.is_file()) if (ROOT / 'js' / 'vendor').exists() else []
    pages = [ROOT / 'index.html'] + [p for p in [ROOT / 'privacy.html'] if p.exists()]
    # The installable app: manifest, service worker, icons (copied unchanged; sw.js gets the version).
    statics = [p for p in [ROOT / 'manifest.webmanifest', ROOT / 'favicon.ico'] if p.exists()] + sorted(p for p in (ROOT / 'icons').glob('*') if p.is_file())
    sw = ROOT / 'sw.js'
    files = pages + sorted((ROOT / 'css').rglob('*.css')) + sorted(p for p in (ROOT / 'js').rglob('*.js') if p not in vendor) + vendor + statics + ([sw] if sw.exists() else [])
    h = hashlib.sha1()
    for f in files:
        h.update(f.relative_to(ROOT).as_posix().encode())
        h.update(f.read_bytes())
    version = re.search(r"VERSION\s*=\s*'([^']+)'", (ROOT / 'js' / 'app.js').read_text()).group(1)
    tag = f"{version}-{h.hexdigest()[:8]}"

    if out.exists():
        for child in out.iterdir():
            if child.name == 'CNAME' and not a.cname:
                continue
            shutil.rmtree(child) if child.is_dir() else child.unlink()
    out.mkdir(parents=True, exist_ok=True)

    for f in files:
        rel = f.relative_to(ROOT)
        dst = out / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if f in vendor or f in statics:      # third-party files and images are copied unchanged
            shutil.copyfile(f, dst)
            continue
        if f == sw:                          # a new version replaces the cached app
            dst.write_text(f.read_text().replace("const VERSION = 'dev';", f"const VERSION = '{tag}';"))
            continue
        text = f.read_text()
        if f.suffix == '.js':
            text = IMPORT_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}?v={tag}{m.group(2)}", text)
        elif f.suffix == '.html':
            text = text.replace('href="css/app.css"', f'href="css/app.css?v={tag}"')
            text = text.replace('src="js/main.js"', f'src="js/main.js?v={tag}"')
        dst.write_text(text)

    (out / '.nojekyll').write_text('')
    if a.cname:
        (out / 'CNAME').write_text(a.cname + '\n')
    (out / 'version.txt').write_text(tag + '\n')
    print(f"Built {tag} into {out} ({len(files)} files)")


if __name__ == '__main__':
    main()
