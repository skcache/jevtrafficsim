# Screenshots

Visual history of the Chicago showcase, one directory per phase or task. The
point is that a reviewer — human or agent — can pull the repo and see what each
phase actually looked like, without running the app.

**Start here:** [`INDEX.md`](INDEX.md) — every phase with its shots inline.
GitHub renders it directly.

```
docs/screenshots/
  INDEX.md            generated; the review entry point
  manifest.json       source of truth; INDEX.md is generated from it
  phase-0-baseline/   the rejected showcase city (the "before")
  phase-1/            real Chicago geography
  phase-2/            physical traffic presentation
  phase-3/            (next) final product UI
```

## Convention

- One directory per phase or task: `phase-N/` for a numbered rescue phase,
  `task-NN/` for a standalone task.
- Files are `NN-slug.png`, numbered in review order, so a directory listing
  reads as the review sequence.
- Captured at 1440×900 from a production build, full colour, PNG — text stays
  legible for close reading.
- Every shot gets a `view` (where the camera was) and a `shows` (what it
  proves) in the manifest. A shot without a claim is not worth committing.

## Adding shots

```bash
# 1. build and serve the app the shots should show
pnpm build && npx next start -p 3113

# 2. start a Chromium with a debugging port (any CDP browser works)
#    (the capture script connects to http://127.0.0.1:9223 by default)

# 3. write a shot list (see scripts/screenshots/phase-3.example.json) and run it
node scripts/capture-screenshots.mjs \
  --phase phase-3 --title "Phase 3 — final product UI" \
  --task "Onboarding, metrics, chaos controls, design system" \
  --url http://localhost:3113 \
  --list scripts/screenshots/phase-3.json
```

That writes the PNGs into `docs/screenshots/phase-3/`, appends the phase to
`manifest.json`, and regenerates `INDEX.md`. Captures are taken against whatever
`HEAD` is unless you pass `--commit <sha>`.

Editing the manifest by hand is fine too — add the phase or shot, then:

```bash
node scripts/capture-screenshots.mjs --index
```

## Why this is in git

Normally `docs/` is local-only in this repo. Screenshots are the exception: a
visual change is only reviewable if the reviewer can see it, and git is the only
channel that works for both a person and an agent. The history showing a few
megabytes of PNGs is an accepted cost for a project this size.

**At the final cleanup pass, delete this directory and the capture script** and
drop the `.gitignore` exception:

```bash
git rm -r docs/screenshots scripts/capture-screenshots.mjs scripts/screenshots
# then remove the "docs/*" + "!docs/screenshots/" pair from .gitignore
```
