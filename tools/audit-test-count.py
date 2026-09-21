#!/usr/bin/env python3
"""Audit test counts per file at HEAD vs a reference commit (default 1c4869a)."""
import re
import subprocess
import sys

REPO = "/Users/21sk/Documents/jevtrafficsim"
REF = sys.argv[1] if len(sys.argv) > 1 else "1c4869a"

PAT = re.compile(r"^\s*(?:it|test)(?:\.\w+)?\(")


def count_from_text(text: str) -> int:
    return sum(1 for line in text.splitlines() if PAT.match(line))


def files_at(ref: str) -> list[str]:
    out = subprocess.run(
        ["git", "ls-tree", "--name-only", f"{ref}:tests"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout
    return sorted(f for f in out.splitlines() if f.endswith(".ts"))


def show_at(ref: str, path: str) -> str:
    return subprocess.run(
        ["git", "show", f"{ref}:tests/{path}"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout


def count_worktree(path: str) -> int:
    with open(f"{REPO}/tests/{path}") as fh:
        return count_from_text(fh.read())


head_files = files_at("HEAD")
ref_files = files_at(REF)

print(f"REF={REF}  files_ref={len(ref_files)}  files_head={len(head_files)}")
missing = set(ref_files) - set(head_files)
added = set(head_files) - set(ref_files)
if missing:
    print("FILES REMOVED since REF:", sorted(missing))
if added:
    print("FILES ADDED since REF:", sorted(added))

print(f"\n{'file':44s} {'ref':>5s} {'head':>5s} {'delta':>6s}")
total_ref = total_head = 0
for path in sorted(set(ref_files) | set(head_files)):
    r = count_from_text(show_at(REF, path)) if path in ref_files else 0
    h = count_worktree(path) if path in head_files else 0
    total_ref += r
    total_head += h
    flag = "  <-- DELTA" if r != h else ""
    print(f"{path:44s} {r:5d} {h:5d} {h - r:+6d}{flag}")
print(f"\nTOTAL ref={total_ref}  head={total_head}  delta={total_head - total_ref:+d}")
