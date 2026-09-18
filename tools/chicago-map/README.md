# Chicago showcase-map preprocessing

One-time, offline-by-design pipeline that turns central-Chicago OpenStreetMap
data into the frozen artifacts the browser showcase renders.

**The web application never runs Python and never touches the network for map
data.** This tool is run by hand, rarely, and its output is committed.

```
pnpm build / pnpm dev / pnpm test / production runtime
    → read data/chicago/*.json (frozen, committed)

tools/chicago-map/extract_chicago.py (this directory)
    → the only thing that talks to Overpass
```

## Running it

```bash
cd tools/chicago-map
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python extract_chicago.py            # cached raw graph
./.venv/bin/python extract_chicago.py --refresh  # re-download from Overpass
./.venv/bin/python extract_chicago.py --skip-features
```

`raw/` (the downloaded GraphML plus the OSMnx cache) is gitignored; the
normalized artifacts under `data/chicago/` are committed.

## Data source and licence

OpenStreetMap, fetched through OSMnx (`network_type="drive"`). The browser shows
the required attribution — **© OpenStreetMap contributors**, linked to
<https://www.openstreetmap.org/copyright> — and `metadata.json` records the
snapshot date, extent, projection and tool version.

## What the pipeline does

1. **Download once** — the master extent (see `MASTER_BBOX`) covers the Loop,
   the Chicago River downtown crossings, River North, West Loop, Near West Side
   / United Center, Grant Park, the lakefront edge, South Loop, Museum Campus /
   Soldier Field, I-90/94 and I-290 with their interchanges. Fetched
   *unsimplified* so control nodes can be preserved deliberately.
2. **Collapse interstitial nodes** (`collapse_pass`) — a node is merged into its
   neighbours only when it is a pure through path (one in, one out), carries no
   control/junction tag, is not on a roundabout ring, and both incident edges
   agree on class, name, ref, oneway, bridge, tunnel, layer, junction and
   service. Road-class transitions, bridge ends and ramp joins always survive.
3. **Consolidate channelized junction pairs** (`consolidate_pass`) — OSM models
   a downtown crossing as two nodes a few metres apart; the simulator wants one.
   Pairs closer than `CONSOLIDATE_MAX_M` are contracted unless they are bridges,
   ramps, limited-access, roundabout rings, both signalized, or share a
   neighbour (which would create a self-loop or parallel edge).
   Both passes repeat to a fixed point.
4. **Compile five nested scales** — each scale is a bbox subset of the *same*
   graph, so a street has identical geography in Tiny and in Metro. Ids are
   assigned in ascending OSM node order, so the output is byte-stable.
5. **Assign controls from source semantics** — `highway=traffic_signals` →
   `signal`, `highway=stop` → `stop`. A conservative stop fallback applies only
   to at-grade intersections whose incident roads are *all* local classes. No
   degree-based signal synthesis exists anywhere in this pipeline.
6. **Extract static features** — building footprints, water, parks and stadium
   areas from the same extent, clipped to the box, simplified and quantized.

## Coordinate model

The simulator works in local metres; MapLibre works in WGS84 lng/lat. Both come
from one documented projection so the presentation is exactly the simulation
geometry:

```
x = (lon − originLon) · metresPerDegreeLon
y = (lat − originLat) · metresPerDegreeLat
```

`metresPerDegreeLon/Lat` are WGS84 series values at the extent centre latitude
(equirectangular tangent plane, <0.1 % distortion across the extent), recorded in
`metadata.json` and in every scale file. The TypeScript side inverts exactly this
formula — there is no runtime GIS service and no second geometry.

## Semantics the simulator relies on

| Concept | Rule |
| --- | --- |
| Directionality | OSM `oneway` decides; motorways, ramps and roundabout rings stay one-way. No reverse roads are invented. |
| Road kind | `motorway*`/`trunk*` → `highway`; `primary*`/`secondary*`/`tertiary*` → `arterial`; `residential`/`unclassified`/`living_street`/`service`/`road` → `local`; `bridge=yes` → `bridge` (the OSM class is kept in `osmClass`). |
| Speed | `maxspeed` parsed (mph, km/h, knots, bare numbers per US convention), else a per-class fallback in m/s. |
| Lanes | `lanes` (or `lanes:forward`/`lanes:backward`) parsed, clamped to 1–8, else a per-class fallback. |
| Capacity | `clamp(round(lanes · lengthM / 7.5), 2, ∞)` car-equivalents — one car occupies ~7.5 m of a lane. |
| Grade separation | Connectivity comes from the OSM graph only. Lines that cross visually are never joined. |
| Roundabouts | Ring topology preserved, ring direction preserved, no control synthesized on ring nodes. |
| Bridges | `bridge=yes` edges are grouped into contiguous crossings (`bridges[].roadIds`) so a bridge closure blocks the crossing, not a fragment. |
| Regions | Fixed 8×6 grid over the master extent, so a street keeps its region id in every scale. No seed. |
| Corridors | Grouped from real `ref`/`name` of highway and arterial roads with at least `CORRIDOR_MIN_ROADS` members. |

## Budgets

Metro targets ≤ ~1,500 intersections and ≤ ~4,500 directed roads. The pipeline
prints the counts for every scale on each run; if the extent ever exceeds the
budget, tighten `CONSOLIDATE_MAX_M` or the master bbox — never the semantics.
