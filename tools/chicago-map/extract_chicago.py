#!/usr/bin/env python3
"""
Chicago showcase-map preprocessing (Phase 1).

ONE-TIME, offline-by-design pipeline. It downloads central-Chicago OpenStreetMap
data once, normalizes it into frozen checked-in artifacts under `data/chicago/`,
and never runs during `pnpm build`, `pnpm dev`, `pnpm test`, or at runtime.

    cd tools/chicago-map
    python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
    ./.venv/bin/python extract_chicago.py            # uses the cached raw graph
    ./.venv/bin/python extract_chicago.py --refresh  # re-downloads from Overpass

Outputs (committed):
    data/chicago/metadata.json      provenance, extent, projection, counts
    data/chicago/{tiny..metro}.json five nested scales of ONE extract
    data/chicago/buildings.geojson  real building footprints (clipped)
    data/chicago/water.geojson      river + lake polygons (clipped)
    data/chicago/parks.geojson      parks / green space (clipped)
    data/chicago/landmarks.geojson  stadiums and venue areas (clipped)

Design rules this file encodes (see the Phase-1 issue):
  * ONE master extent; all five scales are nested subsets of the same graph, so
    the same street has identical geography in Tiny and Metro.
  * Simplification collapses only meaningless interstitial shape nodes and never
    touches control nodes, road-class transitions, bridges, ramps or roundabout
    rings. Presentation geometry keeps the original curved shape.
  * Connectivity comes from the OSM graph. Visual line crossings never create
    intersections, so grade-separated roads stay separate.
  * Controls come from source semantics: `highway=traffic_signals` and
    `highway=stop` nodes. No degree-based signal synthesis, ever. A conservative
    stop fallback applies only to all-local at-grade intersections.
  * Directionality follows OSM `oneway`; motorways, ramps and roundabout rings
    stay one-way. No reverse roads are invented.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import networkx as nx
import osmnx as ox
from shapely.geometry import LineString, Polygon, box, mapping
from shapely.ops import unary_union

# --------------------------------------------------------------------------
# Frozen configuration (changing any of these is a deliberate asset revision)
# --------------------------------------------------------------------------

ASSET_VERSION = 1

#: Master extent (west, south, east, north) in EPSG:4326 — 6.9 x 4.45 km,
#: ~31 km². Chosen after measuring graph size (a wider box produced 8 400+
#: intersections, far past the Phase-1 budget): it still contains the Loop,
#: the Chicago River downtown crossings, River North, West Loop, Near West Side
#: / United Center (-87.674, 41.881), Grant Park, the lakefront edge, South
#: Loop, Museum Campus / Soldier Field (41.862, -87.617), I-90/94 and I-290 with
#: their interchanges.
MASTER_BBOX = (-87.6790, 41.8610, -87.5960, 41.9010)

#: Five nested scales (each bbox strictly contains the previous one).
SCALE_BBOXES: dict[str, tuple[float, float, float, float]] = {
    "tiny": (-87.6350, 41.8790, -87.6220, 41.8880),   # compact Loop core
    "small": (-87.6400, 41.8760, -87.6170, 41.8910),  # Loop + river edge
    "medium": (-87.6480, 41.8710, -87.6100, 41.8950),  # downtown + crossings + Grant Park
    "large": (-87.6720, 41.8620, -87.6000, 41.9000),  # + West Loop / South Loop / expressway
    "metro": MASTER_BBOX,                             # full central-Chicago extent
}

#: Scale name -> the sim's CitySize value (the browser's five sizes).
SCALE_SIZES = ["small", "small-medium", "medium", "medium-large", "large"]

#: Plausibility band for parsed speed limits (11-162 km/h). Values outside are
#: treated as missing so the class default applies.
MIN_SPEED_MPS = 3.0
MAX_SPEED_MPS = 45.0

#: OSM highway classes imported as driving roads. Everything else is excluded —
#: footways, cycleways, steps, paths and pedestrian ways never become car routes.
DRIVING_CLASSES = {
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "unclassified", "residential", "living_street", "road", "service",
}

#: OSM class -> simulation RoadKind (bridge is applied on top when bridge=yes).
KIND_BY_CLASS = {
    "motorway": "highway", "motorway_link": "highway",
    "trunk": "highway", "trunk_link": "highway",
    "primary": "arterial", "primary_link": "arterial",
    "secondary": "arterial", "secondary_link": "arterial",
    "tertiary": "arterial", "tertiary_link": "arterial",
    "unclassified": "local", "residential": "local", "living_street": "local",
    "road": "local", "service": "local",
}

#: Limited-access classes: no at-grade signal may ever be synthesized on these.
LIMITED_ACCESS_CLASSES = {"motorway", "motorway_link", "trunk", "trunk_link"}

#: Deterministic speed fallback per OSM class, in metres per second (the
#: simulator's unit). Used only when `maxspeed` is missing or unparsable.
SPEED_FALLBACK_MPS = {
    "motorway": 29.0, "motorway_link": 18.0,
    "trunk": 25.0, "trunk_link": 16.0,
    "primary": 17.0, "primary_link": 13.0,
    "secondary": 14.0, "secondary_link": 12.0,
    "tertiary": 12.0, "tertiary_link": 11.0,
    "unclassified": 10.0, "residential": 8.0, "living_street": 5.0,
    "road": 8.0, "service": 6.0,
}

#: Deterministic lane fallback per OSM class.
LANES_FALLBACK = {
    "motorway": 4, "motorway_link": 1, "trunk": 3, "trunk_link": 1,
    "primary": 3, "primary_link": 1, "secondary": 2, "secondary_link": 1,
    "tertiary": 2, "tertiary_link": 1, "unclassified": 2, "residential": 1,
    "living_street": 1, "road": 1, "service": 1,
}

#: Physical storage model: one car-equivalent occupies this many metres of one
#: lane. capacity = lanes * length / STORAGE_M_PER_CAR_EQUIVALENT (clamped).
STORAGE_M_PER_CAR_EQUIVALENT = 7.5
MIN_CAPACITY = 2

#: Region grid over the MASTER extent (fixed, so a street keeps its region id in
#: every scale). Deterministic spatial partition, no seed.
REGION_COLS = 8
REGION_ROWS = 6

#: Intersection consolidation: pairs of junctions closer than this that share
#: no control conflict are contracted into one simulation intersection. OSM
#: models channelized downtown crossings as two nodes a few metres apart; the
#: simulator wants one. Never applied to roundabouts, bridges, ramps or
#: limited-access roads. 20 m was chosen by measurement: 12 m left 4 600+
#: Metro intersections, 25 m gained little more.
CONSOLIDATE_MAX_M = 20.0

#: Corridor grouping: roads sharing a ref/name of these kinds with at least this
#: many directed members become a named corridor.
CORRIDOR_MIN_ROADS = 8
CORRIDOR_KINDS = {"highway", "arterial"}

#: Geometry quantization.
COORD_DECIMALS = 6   # lng/lat, ~0.11 m
METRIC_DECIMALS = 2  # local metres, cm

RAW_DIR = Path(__file__).parent / "raw"
RAW_GRAPH = RAW_DIR / "chicago_drive.graphml"

#: WGS84 metres per degree series at a given latitude (documented projection).
WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563


def metres_per_degree(lat_deg: float) -> tuple[float, float]:
    """(metres per degree lon, metres per degree lat) on the WGS84 ellipsoid."""
    phi = math.radians(lat_deg)
    sin_phi = math.sin(phi)
    e2 = WGS84_F * (2 - WGS84_F)
    w = math.sqrt(1 - e2 * sin_phi * sin_phi)
    m_per_deg_lat = (math.pi / 180) * WGS84_A * (1 - e2) / (w**3)
    m_per_deg_lon = (math.pi / 180) * WGS84_A * math.cos(phi) / w
    return m_per_deg_lon, m_per_deg_lat


ORIGIN_LAT = (MASTER_BBOX[1] + MASTER_BBOX[3]) / 2
ORIGIN_LON = (MASTER_BBOX[0] + MASTER_BBOX[2]) / 2
M_PER_DEG_LON, M_PER_DEG_LAT = metres_per_degree(ORIGIN_LAT)


def to_metric(lon: float, lat: float) -> tuple[float, float]:
    """WGS84 -> local metres (equirectangular tangent plane at the extent centre)."""
    return (
        (lon - ORIGIN_LON) * M_PER_DEG_LON,
        (lat - ORIGIN_LAT) * M_PER_DEG_LAT,
    )


# --------------------------------------------------------------------------
# Download
# --------------------------------------------------------------------------

def configure_osmnx() -> None:
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(RAW_DIR / "cache")
    ox.settings.log_console = False
    ox.settings.useful_tags_node = [
        "osmid", "highway", "junction", "crossing", "traffic_calming",
    ]
    ox.settings.useful_tags_way = [
        "osmid", "highway", "name", "ref", "oneway", "lanes", "lanes:forward",
        "lanes:backward", "maxspeed", "bridge", "tunnel", "layer", "junction",
        "access", "service",
    ]


def download_graph(refresh: bool) -> nx.MultiDiGraph:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_GRAPH.exists() and not refresh:
        print(f"· cached raw graph: {RAW_GRAPH}")
        return ox.load_graphml(RAW_GRAPH)
    print(f"· downloading drive network for bbox {MASTER_BBOX} (minutes)")
    started = time.time()
    graph = ox.graph_from_bbox(
        bbox=MASTER_BBOX,
        network_type="drive",
        simplify=False,        # keep every shape node; we simplify deliberately
        retain_all=True,       # keep fragments inside the box
        truncate_by_edge=True, # include edges that merely touch the extent
    )
    print(
        f"  downloaded {graph.number_of_nodes()} nodes / {graph.number_of_edges()} edges "
        f"in {time.time() - started:.0f}s"
    )
    ox.save_graphml(graph, RAW_GRAPH)
    return graph


# --------------------------------------------------------------------------
# Tag helpers
# --------------------------------------------------------------------------

def norm(value) -> str | None:
    """OSMnx stores multi-valued tags as lists; normalize to a clean string."""
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        for item in value:
            text = norm(item)
            if text:
                return text
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    text = str(value).strip()
    if text in {"", "nan", "None"}:
        return None
    return text


def is_truthy(value) -> bool:
    text = norm(value)
    return text is not None and text.lower() in {"yes", "true", "1", "viaduct", "boardwalk"}


def parse_speed_mps(raw) -> float | None:
    """OSM `maxspeed` -> metres per second.

    Handles "30 mph", "50 km/h", "50 kmh", bare numbers (US tagging convention:
    mph for street values <= 70, km/h otherwise) and multi-values ("30; 45") by
    taking the first parsable entry. Non-numeric values ("signals") give None.
    """
    text = norm(raw)
    if text is None:
        return None
    text = text.split(";")[0].strip().lower().replace(",", ".")
    match = re.search(r"\d+(?:\.\d+)?", text)
    if match is None:
        return None
    number = float(match.group(0))
    if not math.isfinite(number) or number <= 0:
        return None
    if "mph" in text:
        metres_per_second = number * 0.44704
    elif "km/h" in text or "kmh" in text or "kph" in text:
        metres_per_second = number / 3.6
    elif "knot" in text:
        metres_per_second = number * 0.514444
    else:
        # US tagging convention: bare street numbers are mph, large ones km/h.
        metres_per_second = number * 0.44704 if number <= 70 else number / 3.6
    # Plausibility band (11-162 km/h): anything outside is bad data, and the
    # caller falls back to the central class default instead of importing junk.
    if not MIN_SPEED_MPS <= metres_per_second <= MAX_SPEED_MPS:
        return None
    return metres_per_second


def parse_lanes(raw, fallback: int) -> int:
    """OSM `lanes` -> sane positive integer, clamped to [1, 8]."""
    text = norm(raw)
    if text is None:
        return fallback
    match = re.search(r"-?\d+(?:\.\d+)?", text.split(";")[0])
    if match is None:
        return fallback
    try:
        value = float(match.group(0))
    except ValueError:
        return fallback
    if not math.isfinite(value):
        return fallback
    # Floor, never round up: a fractional lane tag is junk, and overstating
    # capacity is worse than understating it.
    return max(1, min(8, int(value)))


def control_of(node_attrs: dict) -> str | None:
    """Source-declared control at a node, if any."""
    highway = norm(node_attrs.get("highway"))
    if highway == "traffic_signals":
        return "signal"
    if highway in {"stop", "give_way"}:
        # `give_way` is a yield: the simulator models controlled approaches as
        # signal / stop / uncontrolled, and yield belongs with stop.
        return "stop"
    return None


def capacity_of(lanes: int, length_m: float) -> int:
    """Storage capacity in car-equivalent footprints.

    One central physical approximation (never scattered per road): a lane holds
    `length / STORAGE_M_PER_CAR_EQUIVALENT` car-equivalents. The simulator's
    occupancy unit is one car-equivalent (car 1.0, truck 2.0, bicycle 0.3), and
    its 90% admission threshold means a 7 m minimum length yields a usable link.
    """
    return max(MIN_CAPACITY, int(round(lanes * length_m / STORAGE_M_PER_CAR_EQUIVALENT)))


def is_roundabout_edge(data: dict) -> bool:
    junction = (norm(data.get("junction")) or "").lower()
    return junction in {"roundabout", "circular"}


# --------------------------------------------------------------------------
# Simplification (deliberate, deterministic)
# --------------------------------------------------------------------------

#: Node tags that make a node meaningful for driving even at degree 2.
#: NOTE: `crossing` is deliberately NOT here — pedestrian crosswalk nodes sit on
#: road nodes all over downtown and carry no junction meaning for cars.
CONTROL_NODE_TAGS = {
    "traffic_signals", "stop", "give_way", "motorway_junction",
    "mini_roundabout", "turning_circle",
}


def merge_signature(data: dict) -> tuple:
    """Attributes that must match for two edges to merge through a node."""
    oneway = norm(data.get("oneway"))
    layer = norm(data.get("layer")) or "0"
    try:
        layer = str(int(float(layer)))
    except ValueError:
        pass
    return (
        norm(data.get("highway")),
        norm(data.get("name")),
        norm(data.get("ref")),
        (oneway or "").lower(),
        norm(data.get("bridge")),
        norm(data.get("tunnel")),
        layer,
        norm(data.get("junction")),
        norm(data.get("service")),
    )


def restrict_to_driving(graph: nx.MultiDiGraph) -> nx.MultiDiGraph:
    """Drop non-driving ways (emergency bays, busways, footpaths) BEFORE any
    simplification.

    Simplifying first would let those ways behave like streets: they would merge
    into chains, count as junction approaches, and then vanish at emit time,
    leaving intersections with only incoming or only outgoing roads. Filtering
    first keeps topology and emission consistent.
    """
    keep = [
        (u, v, key)
        for u, v, key, data in graph.edges(keys=True, data=True)
        if norm(data.get("highway")) in DRIVING_CLASSES
    ]
    pruned = graph.edge_subgraph(keep).copy()
    pruned.remove_nodes_from([node for node, degree in pruned.degree() if degree == 0])
    print(
        f"    · driving filter: {graph.number_of_nodes()}/{graph.number_of_edges()} "
        f"-> {pruned.number_of_nodes()}/{pruned.number_of_edges()}"
    )
    return pruned


def simplify_graph(graph: nx.MultiDiGraph) -> nx.MultiDiGraph:
    """Collapse interstitial nodes and consolidate channelized junction pairs.

    Two deterministic passes are repeated to a fixed point: `collapse_pass`
    removes meaningless shape nodes, then `consolidate_pass` contracts pairs of
    junctions that are a few metres apart (OSM models a channelized downtown
    crossing as two nodes; the simulator wants one). Neither pass ever touches
    roundabout rings, bridges, ramps or limited-access roads.
    """
    current = restrict_to_driving(graph)
    for _round in range(6):
        collapsed = collapse_pass(current)
        consolidated = consolidate_pass(collapsed)
        if (consolidated.number_of_nodes() == current.number_of_nodes()
                and consolidated.number_of_edges() == current.number_of_edges()):
            current = consolidated
            break
        current = consolidated
    return current


def collapse_pass(graph: nx.MultiDiGraph) -> nx.MultiDiGraph:
    """One deterministic pass of interstitial-node collapse.

    A node is removed when it is a pure pass-through for EVERY street crossing
    it — the classic mid-block shape node of a two-way street (2 in, 2 out) and
    of a one-way chain (1 in, 1 out). Each incoming edge is paired with the one
    outgoing edge that continues the same street (same class/name/oneway/
    bridge/tunnel/layer, and a different neighbour), so the merged road keeps the
    original curved geometry and the original directionality.

    Nodes with unequal in/out counts are real merges or splits and stay. Nodes
    with control tags, roundabout rings, more than two edges per side, or an
    ambiguous pairing stay. Road-class transitions, bridge ends and ramp joins
    therefore always survive as intersections.
    """
    out_by: dict[int, list[tuple[int, int, dict]]] = defaultdict(list)
    in_by: dict[int, list[tuple[int, int, dict]]] = defaultdict(list)
    for u, v, key, data in graph.edges(keys=True, data=True):
        out_by[u].append((v, key, data))
        in_by[v].append((u, key, data))

    keep: dict[int, bool] = {}
    successor: dict[tuple[int, int, int], tuple[int, int, int]] = {}

    for node, attrs in graph.nodes(data=True):
        ins = in_by.get(node, [])
        outs = out_by.get(node, [])
        highway = norm(attrs.get("highway"))
        if not ins or not outs or (highway and highway in CONTROL_NODE_TAGS):
            keep[node] = True
            continue
        if len(ins) != len(outs) or len(ins) > 2:
            keep[node] = True
            continue
        if any(is_roundabout_edge(d) for _n, _k, d in ins + outs):
            keep[node] = True
            continue
        pairs: list[tuple[tuple[int, int, int], tuple[int, int, int]]] = []
        used: set[tuple[int, int, int]] = set()
        ok = True
        for from_node, in_key, in_data in ins:
            signature = merge_signature(in_data)
            candidates = [
                (to_node, out_key)
                for to_node, out_key, out_data in outs
                if to_node != from_node
                and merge_signature(out_data) == signature
                and (node, to_node, out_key) not in used
            ]
            if len(candidates) != 1:
                ok = False
                break
            to_node, out_key = candidates[0]
            used.add((node, to_node, out_key))
            pairs.append(
                ((from_node, node, in_key), (node, to_node, out_key))
            )
        keep[node] = not ok
        if ok:
            for in_edge, out_edge in pairs:
                successor[in_edge] = out_edge

    simplified = nx.MultiDiGraph()
    simplified.graph.update(graph.graph)
    for node, attrs in graph.nodes(data=True):
        if keep[node]:
            simplified.add_node(node, **attrs)

    consumed: set[tuple[int, int, int]] = set()
    for u, v, key, data in graph.edges(keys=True, data=True):
        if not keep[u] or (u, v, key) in consumed:
            continue
        chain = [(v, key, data)]
        consumed.add((u, v, key))
        previous_edge = (u, v, key)
        current = v
        while not keep[current]:
            next_edge = successor.get(previous_edge)
            if next_edge is None:
                break
            _from_node, to_node, next_key = next_edge
            next_data = graph.edges[_from_node, to_node, next_key]
            chain.append((to_node, next_key, next_data))
            consumed.add(next_edge)
            previous_edge = next_edge
            current = to_node
        target = chain[-1][0]
        merged = dict(chain[0][2])
        osm_ids: list[str] = []
        for _n, _k, d in chain:
            value = norm(d.get("osmid"))
            if value is not None:
                osm_ids.append(value)
        merged["osmid"] = ";".join(dict.fromkeys(osm_ids))
        merged["length"] = sum(float(d.get("length") or 0.0) for _n, _k, d in chain)
        merged["geometry"] = merge_geometry(graph, u, chain)
        merged["oneway"] = norm(chain[0][2].get("oneway"))
        simplified.add_edge(u, target, key=key, **merged)
    return simplified


def merge_geometry(graph: nx.MultiDiGraph, from_node: int, chain) -> LineString:
    """Concatenate the original curved segments into one presentation line."""
    coords: list[tuple[float, float]] = []
    previous = from_node
    for node, _key, data in chain:
        geometry = data.get("geometry")
        if geometry is None:
            segment = [
                (graph.nodes[previous]["x"], graph.nodes[previous]["y"]),
                (graph.nodes[node]["x"], graph.nodes[node]["y"]),
            ]
        else:
            segment = list(geometry.coords)
            start = (graph.nodes[previous]["x"], graph.nodes[previous]["y"])
            if math.dist(segment[0], start) > math.dist(segment[-1], start):
                segment = list(reversed(segment))
        if coords and math.dist(coords[-1], segment[0]) < 1e-9:
            coords.extend(segment[1:])
        else:
            coords.extend(segment)
        previous = node
    if len(coords) < 2:
        coords = [
            (graph.nodes[from_node]["x"], graph.nodes[from_node]["y"]),
            (graph.nodes[chain[-1][0]]["x"], graph.nodes[chain[-1][0]]["y"]),
        ]
    return LineString(coords)


def consolidate_pass(graph: nx.MultiDiGraph) -> nx.MultiDiGraph:
    """Contract junction pairs joined by a very short, ordinary link.

    A pair (A, B) is merged only when ALL hold:
      * the connecting edge is shorter than CONSOLIDATE_MAX_M;
      * neither endpoint is a roundabout ring node;
      * the link is not a bridge and not limited-access (ramps/interchanges);
      * at most one endpoint carries a control tag (signal beats stop beats
        uncontrolled on the merged node);
      * the pair does not already share a neighbour that would turn a parallel
        edge into a self-loop after contraction.
    """
    undirected: dict[frozenset, list[tuple[int, int, dict]]] = defaultdict(list)
    for u, v, _key, data in graph.edges(keys=True, data=True):
        if u != v:
            undirected[frozenset((u, v))].append((u, v, data))

    neighbours: dict[int, set[int]] = defaultdict(set)
    for u, v, _key, _data in graph.edges(keys=True, data=True):
        if u != v:
            neighbours[u].add(v)
            neighbours[v].add(u)

    parent: dict[int, int] = {}

    def find(node: int) -> int:
        parent.setdefault(node, node)
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def control_rank(attrs: dict) -> int:
        control = control_of(attrs)
        return {"signal": 2, "stop": 1}.get(control or "", 0)

    def roundabout_node(node: int) -> bool:
        for u, v, _key, data in graph.edges(node, keys=True, data=True):
            if is_roundabout_edge(data):
                return True
        for u, v, _key, data in graph.in_edges(node, keys=True, data=True):
            if is_roundabout_edge(data):
                return True
        return False

    candidates: list[tuple[float, int, int]] = []
    for pair, edges in undirected.items():
        a, b = sorted(pair)
        data = min(edges, key=lambda item: float(item[2].get("length") or 0.0))[2]
        length = float(data.get("length") or 0.0)
        if length > CONSOLIDATE_MAX_M:
            continue
        osm_class = norm(data.get("highway"))
        if osm_class in LIMITED_ACCESS_CLASSES or is_truthy(data.get("bridge")):
            continue
        if control_rank(graph.nodes[a]) and control_rank(graph.nodes[b]):
            continue
        if roundabout_node(a) or roundabout_node(b):
            continue
        # After contraction, shared neighbours would create parallel edges, and a
        # direct two-way pair would become a self-loop.
        if neighbours[a] & neighbours[b]:
            continue
        candidates.append((length, a, b))

    for _length, a, b in sorted(candidates):
        ra, rb = find(a), find(b)
        if ra == rb:
            continue
        keep_node, drop_node = (ra, rb) if control_rank(graph.nodes[ra]) >= control_rank(graph.nodes[rb]) else (rb, ra)
        parent[drop_node] = keep_node

    if not parent:
        return graph

    def representative(node: int) -> int:
        return find(node)

    # Group members by representative once (O(N)), absorbing the strongest control.
    members: dict[int, list[int]] = defaultdict(list)
    for node in graph.nodes():
        members[representative(node)].append(node)

    consolidated = nx.MultiDiGraph()
    consolidated.graph.update(graph.graph)
    for root, group in members.items():
        attrs = dict(graph.nodes[root])
        best = max(group, key=lambda member: control_rank(graph.nodes[member]))
        attrs["highway"] = graph.nodes[best].get("highway")
        consolidated.add_node(root, **attrs)

    seen: set[tuple[int, int, int]] = set()
    for u, v, key, data in graph.edges(keys=True, data=True):
        ru, rv = representative(u), representative(v)
        if ru == rv:
            continue  # contracted away (self-loop)
        if (ru, rv, key) in seen:
            key = max(seen_key for _a, _b, seen_key in seen if (_a, _b) == (ru, rv)) + 1
        seen.add((ru, rv, key))
        consolidated.add_edge(ru, rv, key=key, **dict(data))
    return consolidated


# --------------------------------------------------------------------------
# Per-scale compilation
# --------------------------------------------------------------------------

def bearing_diagonal(points: list[tuple[float, float]]) -> bool:
    """True when a road's mean bearing sits well off the Chicago grid axes."""
    if len(points) < 2:
        return False
    dx = points[-1][0] - points[0][0]
    dy = points[-1][1] - points[0][1]
    if dx == 0 and dy == 0:
        return False
    bearing = math.degrees(math.atan2(dy, dx)) % 90.0
    return 20.0 < bearing < 70.0


def region_of(x: float, y: float) -> int:
    """Deterministic region id from the fixed grid over the master extent."""
    west, south, east, north = MASTER_BBOX
    x0, y0 = to_metric(west, south)
    x1, y1 = to_metric(east, north)
    col = min(REGION_COLS - 1, max(0, int((x - x0) / max(1e-9, (x1 - x0)) * REGION_COLS)))
    row = min(REGION_ROWS - 1, max(0, int((y - y0) / max(1e-9, (y1 - y0)) * REGION_ROWS)))
    return row * REGION_COLS + col


def compile_scale(
    graph: nx.MultiDiGraph,
    scale: str,
    exclude: frozenset[int] = frozenset(),
    _depth: int = 0,
) -> dict:
    west, south, east, north = SCALE_BBOXES[scale]
    nodes = {
        node: attrs
        for node, attrs in graph.nodes(data=True)
        if west <= attrs["x"] <= east
        and south <= attrs["y"] <= north
        and node not in exclude
    }
    raw_edges = [
        (u, v, key, data)
        for u, v, key, data in graph.edges(keys=True, data=True)
        if u in nodes and v in nodes and norm(data.get("highway")) in DRIVING_CLASSES
    ]
    # Drop nodes with no incident edge (isolated after subsetting).
    used = {u for u, v, _k, _d in raw_edges} | {v for u, v, _k, _d in raw_edges}
    nodes = {node: attrs for node, attrs in nodes.items() if node in used}

    # Parallel OSM ways between the same two nodes (dual/triple carriageway
    # fragments) would break the simulator's one-road-per-direction assumption.
    # Keep the highest-capacity one, ties broken by ascending ids.
    best_by_pair: dict[tuple[int, int], tuple[int, int, int, dict]] = {}
    for u, v, key, data in raw_edges:
        pair = (u, v)
        current = best_by_pair.get(pair)
        if current is None:
            best_by_pair[pair] = (u, v, key, data)
            continue
        new_length = float(data.get("length") or 0.0)
        old_length = float(current[3].get("length") or 0.0)
        new_lanes = parse_lanes(data.get("lanes"), 1)
        old_lanes = parse_lanes(current[3].get("lanes"), 1)
        if new_lanes * new_length > old_lanes * old_length:
            best_by_pair[pair] = (u, v, key, data)
    raw_edges = sorted(
        best_by_pair.values(), key=lambda item: (int(item[0]), int(item[1]), int(item[2]))
    )

    # Boundary stubs: a scale bbox cuts roads, which can leave a node with only
    # incoming or only outgoing edges (or none, when its one parallel way lost
    # the dedupe above). Such a node can never be passed through, cannot carry a
    # signal (the engine requires approaches) and is unreachable as a
    # destination — drop it and re-index, so the emitted city is dense and every
    # intersection is usable.
    for _round in range(4):
        incoming_nodes = {v for _u, v, _k, _d in raw_edges}
        outgoing_nodes = {u for u, _v, _k, _d in raw_edges}
        usable = {
            node
            for node in nodes
            if node in incoming_nodes and node in outgoing_nodes
        }
        if len(usable) == len(nodes):
            break
        nodes = {node: attrs for node, attrs in nodes.items() if node in usable}
        raw_edges = [
            (u, v, key, data) for u, v, key, data in raw_edges if u in usable and v in usable
        ]

    ordered_nodes = sorted(nodes.items(), key=lambda item: int(item[0]))
    index_of = {node: index for index, (node, _attrs) in enumerate(ordered_nodes)}

    incident: dict[int, list[tuple[int, int, dict]]] = defaultdict(list)
    for u, v, _key, data in raw_edges:
        incident[u].append((u, v, data))
        incident[v].append((u, v, data))

    intersections = []
    for node, attrs in ordered_nodes:
        x, y = to_metric(attrs["x"], attrs["y"])
        touches = incident.get(node, [])
        classes = {norm(d.get("highway")) for _u, _v, d in touches}
        roundabout = any(is_roundabout_edge(d) for _u, _v, d in touches)
        degree = len({(u, v) for u, v, _d in touches})
        control = control_of(attrs)
        if control is None:
            at_grade = all(
                (norm(d.get("highway")) or "") not in LIMITED_ACCESS_CLASSES for _u, _v, d in touches
            )
            all_local = classes <= {"unclassified", "residential", "living_street", "road", "service"}
            if not roundabout and at_grade and all_local and degree >= 3:
                control = "stop"  # conservative fallback: ordinary local junctions only
            else:
                control = "uncontrolled"
        intersections.append(
            {
                "id": index_of[node],
                "osmid": int(node),
                "x": round(x, METRIC_DECIMALS),
                "y": round(y, METRIC_DECIMALS),
                "lon": round(attrs["x"], COORD_DECIMALS),
                "lat": round(attrs["y"], COORD_DECIMALS),
                "control": control,
                "region": region_of(x, y),
                "roundabout": roundabout,
                "degree": degree,
            }
        )

    roads = []
    emitted_pairs: set[tuple[int, int]] = set()
    bridge_edges: list[int] = []
    for u, v, _key, data in sorted(
        raw_edges, key=lambda item: (int(item[0]), int(item[1]), int(item[2]))
    ):
        osm_class = norm(data.get("highway"))
        if osm_class not in DRIVING_CLASSES:
            continue
        geometry = data.get("geometry")
        if geometry is None:
            coords = [
                (nodes[u]["x"], nodes[u]["y"]),
                (nodes[v]["x"], nodes[v]["y"]),
            ]
        else:
            coords = list(geometry.coords)
            start = (nodes[u]["x"], nodes[u]["y"])
            if math.dist(coords[0], start) > math.dist(coords[-1], start):
                coords = list(reversed(coords))
        metric = [to_metric(lon, lat) for lon, lat in coords]
        points: list[list[float]] = []
        cumulative = [0.0]
        for index, (x, y) in enumerate(metric):
            px, py = round(x, METRIC_DECIMALS), round(y, METRIC_DECIMALS)
            if points and math.dist(points[-1], (px, py)) < 0.5:
                continue
            points.append([px, py])
            if index > 0:
                cumulative.append(
                    cumulative[-1] + math.dist(points[-2], points[-1])
                )
        if len(points) < 2:
            points = [
                [round(metric[0][0], METRIC_DECIMALS), round(metric[0][1], METRIC_DECIMALS)],
                [round(metric[-1][0], METRIC_DECIMALS), round(metric[-1][1], METRIC_DECIMALS)],
            ]
            cumulative = [0.0, round(math.dist(points[0], points[1]), METRIC_DECIMALS)]
        length = round(cumulative[-1], METRIC_DECIMALS)
        if length < 0.5:
            # Degenerate geometry (duplicate points): keep the connection with a
            # minimal length rather than dropping the edge and stranding a node.
            length = 0.5

        forward_lanes = norm(data.get("lanes:forward"))
        backward_lanes = norm(data.get("lanes:backward"))
        base_lanes = parse_lanes(data.get("lanes"), LANES_FALLBACK.get(osm_class, 1))
        lanes = parse_lanes(
            forward_lanes if u == min(u, v) else backward_lanes,
            base_lanes,
        )
        speed = parse_speed_mps(data.get("maxspeed")) or SPEED_FALLBACK_MPS.get(osm_class, 8.0)
        bridge = is_truthy(data.get("bridge"))
        kind = "bridge" if bridge else KIND_BY_CLASS.get(osm_class, "local")
        capacity = capacity_of(lanes, length)
        road_id = len(roads)
        roundabout_edge = is_roundabout_edge(data)
        oneway = (norm(data.get("oneway")) or "no").lower() in {"yes", "true", "1", "-1"}
        if roundabout_edge:
            # OSM convention: a roundabout ring is one-way even when the way has
            # no explicit oneway tag. Ring direction must never be invented.
            oneway = True
        emitted_pairs.add((u, v))
        roads.append(
            {
                "id": road_id,
                "from": index_of[u],
                "to": index_of[v],
                "kind": kind,
                "osmClass": osm_class,
                "name": norm(data.get("name")),
                "ref": norm(data.get("ref")),
                "oneway": oneway,
                "lanes": lanes,
                "speedMps": round(speed, 2),
                "capacity": capacity,
                "lengthM": length,
                "bridge": bridge,
                "tunnel": is_truthy(data.get("tunnel")),
                "layer": int(float(norm(data.get("layer")) or 0)),
                "roundabout": roundabout_edge,
                "points": points,
                "cumulative": [round(value, METRIC_DECIMALS) for value in cumulative],
            }
        )
        if bridge:
            bridge_edges.append(road_id)

    # Bridge groups: contiguous bridge edges sharing a name form one crossing.
    parent = {road_id: road_id for road_id in bridge_edges}

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    by_node: dict[int, list[int]] = defaultdict(list)
    for road_id in bridge_edges:
        road = roads[road_id]
        by_node[road["from"]].append(road_id)
        by_node[road["to"]].append(road_id)
    for _node, road_ids in sorted(by_node.items()):
        names = {roads[road_id]["name"] or roads[road_id]["ref"] for road_id in road_ids}
        if len(names) == 1:
            for other in road_ids[1:]:
                union(road_ids[0], other)
    groups: dict[int, dict] = {}
    for road_id in bridge_edges:
        root = find(road_id)
        entry = groups.setdefault(
            root,
            {
                "id": len(groups),
                "name": roads[road_id]["name"] or roads[road_id]["ref"] or "Bridge",
                "roadIds": [],
            },
        )
        entry["roadIds"].append(road_id)
    bridge_groups = sorted(groups.values(), key=lambda entry: entry["id"])
    group_of = {
        road_id: entry["id"] for entry in bridge_groups for road_id in entry["roadIds"]
    }
    for road in roads:
        road["bridgeGroup"] = group_of.get(road["id"])

    # Corridors from real ref/name of highway and arterial roads.
    groups_by_name: dict[str, list[int]] = defaultdict(list)
    for road in roads:
        if road["kind"] not in CORRIDOR_KINDS:
            continue
        key = road["ref"] or road["name"]
        if key:
            groups_by_name[key].append(road["id"])
    corridors = []
    corridor_of: dict[int, int] = {}
    for name in sorted(groups_by_name):
        road_ids = sorted(groups_by_name[name])
        if len(road_ids) < CORRIDOR_MIN_ROADS:
            continue
        classes = {roads[road_id]["osmClass"] for road_id in road_ids}
        if classes & LIMITED_ACCESS_CLASSES:
            kind = "highway"
        else:
            sample = roads[road_ids[0]]["points"]
            kind = "diagonal" if bearing_diagonal(sample) else "arterial"
        corridor_id = len(corridors)
        corridors.append({"id": corridor_id, "name": name, "kind": kind, "roadIds": road_ids})
        for road_id in road_ids:
            corridor_of[road_id] = corridor_id
    for road in roads:
        road["corridor"] = corridor_of.get(road["id"])

    # Post-emission consistency: an edge can still be dropped while building its
    # geometry, leaving an intersection with only incoming or only outgoing
    # roads. Recompile without those nodes — the node set strictly shrinks, so
    # this terminates. (Compared in OSM-id space: `roads` carries dense ids.)
    emitted_incoming = {v for _u, v in emitted_pairs}
    emitted_outgoing = {u for u, _v in emitted_pairs}
    stranded = {
        node
        for node, _attrs in ordered_nodes
        if node not in emitted_incoming or node not in emitted_outgoing
    }
    if stranded and _depth < 4:
        print(f"    · {scale}: dropping {len(stranded)} stranded intersection(s)")
        return compile_scale(graph, scale, exclude | frozenset(stranded), _depth + 1)

    counts = {
        "intersections": len(intersections),
        "roads": len(roads),
        "signals": sum(1 for i in intersections if i["control"] == "signal"),
        "stops": sum(1 for i in intersections if i["control"] == "stop"),
        "bridges": sum(1 for road in roads if road["bridge"]),
        "bridgeGroups": len(bridge_groups),
        "highways": sum(1 for road in roads if road["kind"] == "highway"),
        "arterials": sum(1 for road in roads if road["kind"] == "arterial"),
        "locals": sum(1 for road in roads if road["kind"] == "local"),
        "roundaboutNodes": sum(1 for i in intersections if i["roundabout"]),
        "corridors": len(corridors),
        "regions": len({i["region"] for i in intersections}),
    }
    return {
        "version": ASSET_VERSION,
        "scale": scale,
        "size": SCALE_SIZES[["tiny", "small", "medium", "large", "metro"].index(scale)],
        "bbox": list(SCALE_BBOXES[scale]),
        "intersections": intersections,
        "roads": roads,
        "corridors": corridors,
        "bridges": bridge_groups,
        "counts": counts,
    }


# --------------------------------------------------------------------------
# Static features
# --------------------------------------------------------------------------

def clip_and_round(geometries, clip_box: Polygon, simplify_m: float, decimals: int):
    """Clip to the extent, simplify in metres, quantize coordinates."""
    out = []
    for geometry in geometries:
        if geometry is None or geometry.is_empty:
            continue
        clipped = geometry.intersection(clip_box)
        if clipped.is_empty:
            continue
        simplified = clipped.simplify(simplify_m, preserve_topology=True)
        if simplified.is_empty:
            continue
        out.append(simplified)
    return out


def round_coords(geometry, decimals: int) -> list[dict]:
    """Quantize a geometry to a LIST of Polygon geometries (deterministic bytes).

    MultiPolygons are exploded into one Polygon per part. The browser renderer
    treats every feature as a single outer ring, so a river/lake MultiPolygon
    would otherwise render as its first part only.
    """
    if geometry.geom_type == "MultiPolygon":
        # Flatten: each part already comes back as a one-element list.
        return [poly for part in geometry.geoms for poly in round_coords(part, decimals)]
    if geometry.geom_type == "Polygon":
        rings = [
            [[round(x, decimals), round(y, decimals)] for x, y in ring.coords]
            for ring in [geometry.exterior, *geometry.interiors]
        ]
        return [{"type": "Polygon", "coordinates": rings}]
    raise ValueError(f"unexpected geometry {geometry.geom_type}")


def tiles(bbox, cols: int, rows: int):
    """Split a bbox into a grid of sub-boxes (Overpass-friendly query sizes)."""
    west, south, east, north = bbox
    for col in range(cols):
        for row in range(rows):
            yield (
                west + (east - west) * col / cols,
                south + (north - south) * row / rows,
                west + (east - west) * (col + 1) / cols,
                south + (north - south) * (row + 1) / rows,
            )


def feature_collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def extract_features(bbox, out_dir: Path) -> dict:
    """Buildings, water, parks and stadium areas from the same extent."""
    clip_box = box(*bbox)
    stats = {}

    print("· buildings (tiled)")
    building_features = []
    for tile in tiles(bbox, 3, 3):
        for attempt in range(3):
            try:
                buildings = ox.features_from_bbox(bbox=tile, tags={"building": True})
                break
            except Exception as error:  # Overpass timeouts are expected on big tiles
                print(f"    tile retry {attempt + 1}: {error}")
                time.sleep(5)
        else:
            print("    tile skipped after retries")
            continue
        for geometry, row in zip(buildings.geometry, buildings.itertuples()):
            area = geometry.area * 1.2e9 if geometry.geom_type == "Polygon" else 0.0
            if area < 150:  # sheds and kiosks; real blocks are far larger
                continue
            for clipped in clip_and_round([geometry], clip_box, 1.5, COORD_DECIMALS):
                for part in round_coords(clipped, COORD_DECIMALS):
                    building_features.append(
                        {
                            "type": "Feature",
                            "properties": {
                                "name": norm(getattr(row, "name", None)),
                                "levels": norm(getattr(row, "building_levels", None)),
                                "area": int(area),
                            },
                            "geometry": part,
                        }
                    )
    stats["buildings"] = len(building_features)

    print("· water")
    water = ox.features_from_bbox(
        bbox=bbox, tags={"natural": ["water", "bay"], "water": True, "waterway": ["river", "canal"]}
    )
    water_geoms = []
    for geometry in water.geometry:
        if geometry is None or geometry.is_empty:
            continue
        water_geoms.append(geometry.buffer(0))
    merged = unary_union([g for g in water_geoms if not g.is_empty]) if water_geoms else None
    water_features = []
    if merged is not None and not merged.is_empty:
        for clipped in clip_and_round([merged], clip_box, 2.0, COORD_DECIMALS):
            for part in round_coords(clipped, COORD_DECIMALS):
                water_features.append(
                    {
                        "type": "Feature",
                        "properties": {"kind": "water"},
                        "geometry": part,
                    }
                )
    stats["water"] = len(water_features)

    print("· parks")
    parks = ox.features_from_bbox(
        bbox=bbox,
        tags={
            "leisure": ["park", "garden", "nature_reserve", "recreation_ground"],
            "landuse": ["grass", "recreation_ground", "cemetery", "forest"],
            "natural": ["wood", "scrub", "grassland"],
        },
    )
    park_features = []
    for geometry, row in zip(parks.geometry, parks.itertuples()):
        if geometry is None or geometry.is_empty or geometry.area < 1e-8:
            continue
        for clipped in clip_and_round([geometry], clip_box, 3.0, COORD_DECIMALS):
            park_features.extend(
                {
                    "type": "Feature",
                    "properties": {"name": norm(getattr(row, "name", None))},
                    "geometry": part,
                }
                for part in round_coords(clipped, COORD_DECIMALS)
            )
    stats["parks"] = len(park_features)

    print("· landmarks")
    landmarks = ox.features_from_bbox(bbox=bbox, tags={"leisure": ["stadium"], "building": ["stadium"]})
    landmark_features = []
    for geometry, row in zip(landmarks.geometry, landmarks.itertuples()):
        if geometry is None or geometry.is_empty:
            continue
        for clipped in clip_and_round([geometry], clip_box, 1.5, COORD_DECIMALS):
            landmark_features.extend(
                {
                    "type": "Feature",
                    "properties": {
                        "name": norm(getattr(row, "name", None)),
                        "kind": "stadium",
                    },
                    "geometry": part,
                }
                for part in round_coords(clipped, COORD_DECIMALS)
            )
    stats["landmarks"] = len(landmark_features)

    (out_dir / "buildings.geojson").write_text(
        json.dumps(feature_collection(building_features), separators=(",", ":"))
    )
    (out_dir / "water.geojson").write_text(
        json.dumps(feature_collection(water_features), separators=(",", ":"))
    )
    (out_dir / "parks.geojson").write_text(
        json.dumps(feature_collection(park_features), separators=(",", ":"))
    )
    (out_dir / "landmarks.geojson").write_text(
        json.dumps(feature_collection(landmark_features), separators=(",", ":"))
    )
    return stats


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Extract the Chicago showcase map")
    parser.add_argument("--refresh", action="store_true", help="re-download from Overpass")
    parser.add_argument("--out", default="../../data/chicago", help="output directory")
    parser.add_argument("--skip-features", action="store_true", help="roads only")
    args = parser.parse_args()

    out_dir = (Path(__file__).parent / args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    configure_osmnx()
    graph = download_graph(args.refresh)
    print(f"· raw graph {graph.number_of_nodes()} nodes / {graph.number_of_edges()} edges")

    started = time.time()
    simplified = simplify_graph(graph)
    print(
        f"· simplified to {simplified.number_of_nodes()} nodes / "
        f"{simplified.number_of_edges()} edges in {time.time() - started:.0f}s"
    )

    scales = {}
    for scale in SCALE_BBOXES:
        payload = compile_scale(simplified, scale)
        path = out_dir / f"{scale}.json"
        path.write_text(json.dumps(payload, separators=(",", ":")))
        scales[scale] = payload["counts"]
        print(f"  {scale:6s} {payload['counts']}  {path.stat().st_size / 1e6:.2f} MB")

    feature_stats = {} if args.skip_features else extract_features(MASTER_BBOX, out_dir)

    metadata = {
        "source": "OpenStreetMap (ODbL 1.0)",
        "attribution": "© OpenStreetMap contributors",
        "attributionUrl": "https://www.openstreetmap.org/copyright",
        "extraction": {
            "snapshotDate": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "tool": "tools/chicago-map/extract_chicago.py",
            "toolVersion": ASSET_VERSION,
            "networkType": "drive",
            "osmnx": ox.__version__,
        },
        "masterBbox": list(MASTER_BBOX),
        "scaleBboxes": {name: list(bbox) for name, bbox in SCALE_BBOXES.items()},
        "projection": {
            "kind": "local equirectangular tangent plane (WGS84 series metres per degree)",
            "originLon": ORIGIN_LON,
            "originLat": ORIGIN_LAT,
            "metresPerDegreeLon": M_PER_DEG_LON,
            "metresPerDegreeLat": M_PER_DEG_LAT,
            "metricDecimals": METRIC_DECIMALS,
            "coordDecimals": COORD_DECIMALS,
        },
        "capacityModel": {
            "storageMetresPerCarEquivalent": STORAGE_M_PER_CAR_EQUIVALENT,
            "minCapacity": MIN_CAPACITY,
            "formula": "clamp(round(lanes * lengthM / storage), min, inf)",
        },
        "regionGrid": {"cols": REGION_COLS, "rows": REGION_ROWS, "basis": "master extent"},
        "counts": scales,
        "features": feature_stats,
    }
    (out_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    total = sum(path.stat().st_size for path in out_dir.glob("*"))
    print(f"· wrote {len(list(out_dir.glob('*')))} files, {total / 1e6:.2f} MB total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
