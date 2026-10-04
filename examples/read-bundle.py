"""Reads a .mcbundle with nothing but the Python standard library: the sections of the book, and for each exercise its printed
label, the region to cut out of the PDF, the instruction regions and the hidden answer regions.

    python read_bundle.py book.mcbundle [section-id]
"""
import json
import sys
import zipfile


def read_bundle(path):
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        manifest = json.loads(z.read('bundle.json'))
        frames = json.loads(z.read('frames.json'))['frames']
        outline = json.loads(z.read('outline.json'))['entries'] if 'outline.json' in names else []
    return manifest, frames, outline


def main():
    manifest, frames, outline = read_bundle(sys.argv[1])
    only = sys.argv[2] if len(sys.argv) > 2 else None
    doc = manifest['document']
    print(f"{doc['title']} by {doc.get('author', '?')} ({doc.get('license', {}).get('name', 'no licence stated')}), "
          f"{doc['pageCount']} pages")

    # Sections are outline entries; an entry with an id can hold exercises. Depth 0 is a chapter, depth 1 a section.
    book = [f for f in frames if f.get('authority') == 'book']
    by_section = {}
    for frame in book:
        by_section.setdefault(frame['section'], []).append(frame)

    for entry in outline:
        sid = entry.get('id')
        if sid is None or sid not in by_section or (only and sid != only):
            continue
        exercises = by_section[sid]
        print(f"\n{entry.get('label', sid)}  {entry['title']}  (page {entry['page'] + 1}, {len(exercises)} exercises)")
        for frame in exercises[:3]:
            r = frame['rect']
            print(f"  {frame['label']}: page {frame['page'] + 1}, x {r['left']:.3f}-{r['right']:.3f}, y {r['top']:.3f}-{r['bottom']:.3f}")
            print(f"     instruction regions: {len(frame.get('context', []))}, answer regions (hidden): {len(frame.get('solution', []))}")
        if len(exercises) > 3:
            print(f"  ... {len(exercises) - 3} more")


if __name__ == '__main__':
    main()
