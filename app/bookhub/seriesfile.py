"""A whole series as one download.

Comic volumes (CBZ, and CBR opened with bsdtar) are joined into a single CBZ whose pages run volume after
volume, so any comic reader shows the series as one long book. Other books cannot be joined sensibly, so they
come as one ZIP holding each volume's own file. The library's files are only read, never changed.
"""
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

COMIC = ("CBZ", "CBR")
PICTURES = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp")


class SeriesFileError(Exception):
    pass


def _natural(name):
    """Page names in reading order: "page2" before "page10"."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def _pages(path, scratch):
    """Every picture in a comic archive, in reading order, as (name inside the archive, bytes getter)."""
    if path.suffix.lower() == ".cbz" or zipfile.is_zipfile(path):
        z = zipfile.ZipFile(path)
        names = sorted((n for n in z.namelist() if n.lower().endswith(PICTURES) and not n.startswith("__MACOSX")), key=_natural)
        return [(n, (lambda n=n: z.read(n))) for n in names]
    out = scratch / path.stem
    out.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.run(["bsdtar", "-xf", str(path), "-C", str(out)], check=True, capture_output=True, timeout=300)
    except (OSError, subprocess.SubprocessError) as exc:
        raise SeriesFileError("Could not open %s: %s" % (path.name, exc))
    # An archive can hold a link named page.jpg that points at a file elsewhere on the server; never follow one.
    inside = out.resolve()
    files = sorted((f for f in out.rglob("*") if f.is_file() and not f.is_symlink() and f.suffix.lower() in PICTURES
                    and inside in f.resolve().parents),
                   key=lambda f: _natural(str(f.relative_to(out))))
    return [(str(f.relative_to(out)), f.read_bytes) for f in files]


def build(library, volumes, series):
    """Write the series to a temporary file. Returns (path, download name); the caller deletes the path."""
    files = []
    for b in volumes:
        fmt = next((f for f in COMIC if f in b["formats"]), None) or next(iter(sorted(b["formats"])), None)
        path = library.file_path(b, fmt) if fmt else None
        if path and Path(path).exists():
            files.append((b, fmt, Path(path)))
    if not files:
        raise SeriesFileError("None of the volumes has a file to download.")
    safe = re.sub(r'[\\/:*?"<>|]+', "", series).strip() or "Series"
    joined = all(fmt in COMIC for _, fmt, _ in files)
    handle = tempfile.NamedTemporaryFile(suffix=".cbz" if joined else ".zip", delete=False)
    handle.close()
    target = Path(handle.name)
    scratch = Path(tempfile.mkdtemp())
    try:
        # Pictures are already compressed, so storing them is as small and much faster.
        with zipfile.ZipFile(target, "w", zipfile.ZIP_STORED if joined else zipfile.ZIP_DEFLATED) as out:
            for v, (b, fmt, path) in enumerate(files, 1):
                if not joined:
                    out.write(path, "%03d - %s.%s" % (v, b.get("shown_title") or b["title"], fmt.lower()))
                    continue
                for p, (name, read) in enumerate(_pages(path, scratch), 1):
                    out.writestr("%03d-%04d%s" % (v, p, Path(name).suffix.lower()), read())
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return target, "%s (whole series).%s" % (safe, "cbz" if joined else "zip")
