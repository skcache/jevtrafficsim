#!/usr/bin/env python3
"""Derive urban block polygons from the Chicago street network.

Presentation only. Simulation geography is untouched: this writes ONE frozen
asset (data/chicago/blocks.geojson) that the map draws as the city fabric at
neighborhood zoom, so the map reads as roads carving coherent blocks instead of
thousands of individual footprints floating beside roads.

Method
------
1. Take the meaningful street centrelines — the same "primary" presentation
   class the renderer uses (expressways, ramps, and the grid streets that carry
   Chicago's named avenues), from the metro scale so one block set serves every
   scale and switching scale never reshapes the city.
2. Build a planar arrangement with the master extent boundary and polygonize it
   into faces.
3. Drop the exterior face, clip to the extent, and reject pathological faces
   with COUNTED rules: invalid, too small, or sliver-thin (Polsby-Popper
   compactness). Nothing is dropped silently — the report prints every count.
4. Simplify lightly and write WGS84, matching the other frozen assets.

Usage: tools/chicago-map/.venv/bin/python tools/chicago-map/build_blocks.py
"""
from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "chicago"

# A Chicago block is roughly 1 500–20 000 m². Below this a face is a fragment of
# a bigger shape (or a curb loop), not a block anyone reads as a city block.
MIN_BLOCK_AREA_M2 = 600.0
# Polsby-Popper: 1 is a circle, near 0 is a hair. Slivers are clipping debris.
MIN_COMPACTNESS = 0.05
SIMPLIFY_M = 0.6

PRIMARY_CLASSES = {"motorway", "trunk", "primary", "secondary"}


def is_block_boundary(osm_class: str) -> bool:
    """The same rule the renderer applies for its primary presentation class."""
    return osm_class in PRIMARY_CLASSES or osm_class.endswith("_link")


def compactness(polygon) -> float:
    area = polygon.area
    perimeter = polygon.length
    return (4 * 3.141592653589793 * area) / (perimeter * perimeter) if perimeter > 0 else 1.0


def main() -> int:
    meta = json.loads((DATA / "metadata.json").read_text())
    projection = meta["projection"]
    min_lon, min_lat, max_lon, max_lat = meta["masterBbox"]
    origin_lon = projection["originLon"]
    origin_lat = projection["originLat"]
    m_per_lon = projection["metresPerDegreeLon"]
    m_per_lat = projection["metresPerDegreeLat"]

    def to_lnglat(x: float, y: float) -> list[float]:
        return [
            round(origin_lon + x / m_per_lon, 7),
            round(origin_lat + y / m_per_lat, 7),
        ]

    metro = json.loads((DATA / "metro.json").read_text())
    extent = box(
        (min_lon - origin_lon) * m_per_lon,
        (min_lat - origin_lat) * m_per_lat,
        (max_lon - origin_lon) * m_per_lon,
        (max_lat - origin_lat) * m_per_lat,
    )

    # Deduplicate: each street is two directed roads sharing one geometry.
    lines: dict[tuple, LineString] = {}
    for road in metro["roads"]:
        if not is_block_boundary(road.get("osmClass", "")):
            continue
        points = [(float(x), float(y)) for x, y in road.get("points", [])]
        if len(points) < 2:
            continue
        key = tuple((round(x, 1), round(y, 1)) for x, y in points)
        reverse = tuple(reversed(key))
        if key in lines or reverse in lines:
            continue
        lines[key] = LineString(points)

    boundaries = list(lines.values()) + [extent.boundary]
    merged = unary_union(boundaries)
    faces = list(polygonize(merged))

    corners = [Point(extent.bounds[0], extent.bounds[1]), Point(extent.bounds[2], extent.bounds[1]),
               Point(extent.bounds[2], extent.bounds[3]), Point(extent.bounds[0], extent.bounds[3])]
    counts = {"faces": len(faces), "exterior": 0, "invalid": 0, "tiny": 0, "sliver": 0, "kept": 0}
    features = []
    for face in faces:
        # The exterior face is the one that contains the extent's corners.
        if any(face.contains(corner) for corner in corners):
            counts["exterior"] += 1
            continue
        if not face.is_valid:
            repaired = face.buffer(0)
            if not isinstance(repaired, Polygon) or repaired.is_empty:
                counts["invalid"] += 1
                continue
            face = repaired
        if face.area < MIN_BLOCK_AREA_M2:
            counts["tiny"] += 1
            continue
        if compactness(face) < MIN_COMPACTNESS:
            counts["sliver"] += 1
            continue
        clipped = face.intersection(extent).simplify(SIMPLIFY_M, preserve_topology=True)
        if not isinstance(clipped, Polygon) or clipped.is_empty or clipped.area < MIN_BLOCK_AREA_M2:
            counts["tiny"] += 1
            continue
        ring = [to_lnglat(x, y) for x, y in clipped.exterior.coords]
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "areaM2": round(clipped.area),
                    "compactness": round(compactness(clipped), 3),
                },
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            }
        )
        counts["kept"] += 1

    out = DATA / "blocks.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")))
    print("block derivation report")
    print(f"  street lines used : {len(lines)}")
    print(f"  faces             : {counts['faces']}")
    print(f"  exterior dropped  : {counts['exterior']}")
    print(f"  invalid dropped   : {counts['invalid']}")
    print(f"  tiny dropped      : {counts['tiny']}")
    print(f"  sliver dropped    : {counts['sliver']}")
    print(f"  kept              : {counts['kept']}")
    print(f"  written           : {out.relative_to(ROOT)} ({out.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
