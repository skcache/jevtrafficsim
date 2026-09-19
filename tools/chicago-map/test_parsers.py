#!/usr/bin/env python3
"""Parser checks for the Chicago importer (no network, no pytest needed).

Run:  ./.venv/bin/python test_parsers.py
"""

from __future__ import annotations

import sys

import extract_chicago as ex

FAILURES: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        FAILURES.append(f"{label}: expected {expected!r}, got {actual!r}")


def check_speed(label: str, actual, expected) -> None:
    if actual is None or abs(actual - expected) > 0.01:
        FAILURES.append(f"{label}: expected ~{expected!r}, got {actual!r}")


# --- speed parsing -----------------------------------------------------------------
check_speed("mph", ex.parse_speed_mps("30 mph"), 13.41)
check_speed("mph uppercase", ex.parse_speed_mps("45 MPH"), 20.12)
check_speed("km/h", ex.parse_speed_mps("50 km/h"), 13.89)
check_speed("kph", ex.parse_speed_mps("50 kph"), 13.89)
check_speed("kmh", ex.parse_speed_mps("50kmh"), 13.89)
check_speed("bare number (US convention: mph)", ex.parse_speed_mps("25"), 11.18)
check_speed("bare large number (km/h)", ex.parse_speed_mps("110"), 30.56)
check_speed("decimal", ex.parse_speed_mps("22.5 mph"), 10.06)
check_speed("first of a list", ex.parse_speed_mps("20 mph; 30 mph"), 8.94)
check("junk", ex.parse_speed_mps("signals"), None)
check("walk", ex.parse_speed_mps("walk"), None)
check("empty", ex.parse_speed_mps(""), None)
check("none", ex.parse_speed_mps(None), None)
check("negative clamps out", ex.parse_speed_mps("-5 mph"), None)
check("absurd clamps out", ex.parse_speed_mps("900 mph"), None)

# --- lane parsing ------------------------------------------------------------------
check("lanes int", ex.parse_lanes("3", 1), 3)
check("lanes first of list", ex.parse_lanes("2;3", 1), 2)
check("lanes messy", ex.parse_lanes("2 lanes", 1), 2)
check("lanes decimal floors", ex.parse_lanes("2.6", 1), 2)
check("lanes zero falls back", ex.parse_lanes("0", 1), 1)
check("lanes absurd clamps", ex.parse_lanes("40", 1), 8)
check("lanes missing uses fallback", ex.parse_lanes(None, 4), 4)
check("lanes junk uses fallback", ex.parse_lanes("bus", 2), 2)

# --- directional lanes ---------------------------------------------------------------
# These tests never pass node ids: `directional_lanes` cannot see them, so numeric
# node ordering can never come back as a way to pick lanes:forward vs backward.
# `reversed` is OSMnx's marker for "this edge runs against the way as drawn".

# One-way: `lanes` is the directional count.
check(
    "one-way 3 lanes",
    ex.directional_lanes({"lanes": "3", "oneway": "yes", "reversed": False}, True, "secondary"),
    3,
)
check(
    "one-way 3 lanes, edge reversed",
    ex.directional_lanes({"lanes": "3", "oneway": "yes", "reversed": True}, True, "secondary"),
    3,
)
check(
    "one-way directional tag wins",
    ex.directional_lanes(
        {"lanes": "2", "lanes:forward": "3", "oneway": "yes", "reversed": False}, True, "primary"
    ),
    3,
)

# Two-way with `lanes` as the TOTAL: never hand the total to both directions.
check(
    "two-way lanes=2 splits to 1 each",
    ex.directional_lanes({"lanes": "2", "reversed": False}, False, "residential"),
    1,
)
check(
    "two-way lanes=2 splits to 1 each (reversed edge)",
    ex.directional_lanes({"lanes": "2", "reversed": True}, False, "residential"),
    1,
)
check(
    "two-way lanes=4 splits to 2 each",
    ex.directional_lanes({"lanes": "4", "reversed": False}, False, "secondary"),
    2,
)
check(
    "two-way lanes=4 splits to 2 each (reversed edge)",
    ex.directional_lanes({"lanes": "4", "reversed": True}, False, "secondary"),
    2,
)
check(
    "two-way lanes=3 gives the odd lane to forward",
    ex.directional_lanes({"lanes": "3", "reversed": False}, False, "tertiary"),
    2,
)
check(
    "two-way lanes=3 reversed edge gets the remainder",
    ex.directional_lanes({"lanes": "3", "reversed": True}, False, "tertiary"),
    1,
)

# lanes:both_ways is a shared centre lane: removed before the split.
check(
    "both_ways removed before split",
    ex.directional_lanes(
        {"lanes": "3", "lanes:both_ways": "1", "reversed": False}, False, "tertiary"
    ),
    1,
)
check(
    "both_ways on a 5-lane road",
    ex.directional_lanes(
        {"lanes": "5", "lanes:both_ways": "1", "reversed": False}, False, "primary"
    ),
    2,
)

# Two-way WITH directional tags: forward edge takes forward, reversed takes backward.
two_way_tagged = {
    "lanes": "3",
    "lanes:forward": "2",
    "lanes:backward": "1",
    "oneway": "no",
}
check(
    "two-way tagged, aligned edge",
    ex.directional_lanes({**two_way_tagged, "reversed": False}, False, "secondary"),
    2,
)
check(
    "two-way tagged, reversed edge",
    ex.directional_lanes({**two_way_tagged, "reversed": True}, False, "secondary"),
    1,
)

# The regression that started all this: a 4-lane way tagged 3 forward / 1 backward.
# Under the old node-id rule, whichever edge happened to start at the smaller node id
# received lanes:forward regardless of how the way was drawn.
lane_regression = {
    "lanes": "4",
    "lanes:forward": "3",
    "lanes:backward": "1",
    "oneway": "no",
}
check(
    "way-direction regression: aligned edge keeps forward lanes",
    ex.directional_lanes({**lane_regression, "reversed": False}, False, "primary"),
    3,
)
check(
    "way-direction regression: reversed edge keeps backward lanes",
    ex.directional_lanes({**lane_regression, "reversed": True}, False, "primary"),
    1,
)

# Missing and malformed data fall back to the central class table.
check(
    "missing lane data uses class fallback",
    ex.directional_lanes({}, False, "residential"),
    ex.LANES_FALLBACK["residential"],
)
check(
    "malformed lane data uses class fallback",
    ex.directional_lanes({"lanes": "bus", "lanes:forward": "n/a"}, True, "motorway"),
    ex.LANES_FALLBACK["motorway"],
)
check(
    "zero lanes never escapes",
    ex.directional_lanes({"lanes": "0", "reversed": False}, False, "residential"),
    1,
)
check(
    "absurd total clamps, then splits",
    ex.directional_lanes({"lanes": "40", "reversed": False}, False, "motorway"),
    4,
)
check(
    "absurd one-way lanes clamp to 8",
    ex.directional_lanes({"lanes": "40", "oneway": "yes", "reversed": False}, True, "motorway"),
    8,
)
check(
    "split is exact: 3 total never becomes 2 + 2",
    ex.split_two_way_lanes(3, 0),
    (2, 1),
)

# --- class mapping -----------------------------------------------------------------
check("motorway -> highway", ex.KIND_BY_CLASS["motorway"], "highway")
check("motorway_link -> highway", ex.KIND_BY_CLASS["motorway_link"], "highway")
check("trunk -> highway", ex.KIND_BY_CLASS["trunk"], "highway")
check("primary -> arterial", ex.KIND_BY_CLASS["primary"], "arterial")
check("tertiary -> arterial", ex.KIND_BY_CLASS["tertiary"], "arterial")
check("residential -> local", ex.KIND_BY_CLASS["residential"], "local")
check("service -> local", ex.KIND_BY_CLASS["service"], "local")
if "footway" in ex.KIND_BY_CLASS or "footway" in ex.DRIVING_CLASSES:
    FAILURES.append("footway must not be a driving class")
if "pedestrian" in ex.DRIVING_CLASSES:
    FAILURES.append("pedestrian must not be a driving class")

# --- capacity ----------------------------------------------------------------------
check("capacity is lanes * length / storage", ex.capacity_of(2, 150.0), 40)
check("capacity clamps to a minimum", ex.capacity_of(1, 4.0), ex.MIN_CAPACITY)
if not 7.0 <= ex.STORAGE_M_PER_CAR_EQUIVALENT <= 8.0:
    FAILURES.append("storage metres per car-equivalent should stay in the 7-8 m band")

# --- building metric area -----------------------------------------------------------
from shapely.geometry import Polygon  # noqa: E402  (kept next to its use)

lon0, lat0 = -87.6375, 41.881
mpd_lon, mpd_lat = ex.metres_per_degree(lat0)
d = 0.001
plain = Polygon([(lon0, lat0), (lon0 + d, lat0), (lon0 + d, lat0 + d), (lon0, lat0 + d)])
expected = (d * mpd_lon) * (d * mpd_lat)
if abs(ex.metric_area_m2(plain) - expected) > expected * 0.01:
    FAILURES.append(
        f"metric area: expected ~{expected:.0f} m2, got {ex.metric_area_m2(plain):.0f}"
    )

hole = Polygon(
    [(lon0, lat0), (lon0 + d, lat0), (lon0 + d, lat0 + d), (lon0, lat0 + d)],
    [[
        (lon0 + d * 0.4, lat0 + d * 0.4),
        (lon0 + d * 0.6, lat0 + d * 0.4),
        (lon0 + d * 0.6, lat0 + d * 0.6),
        (lon0 + d * 0.4, lat0 + d * 0.6),
    ]],
)
holed_area = ex.metric_area_m2(hole)
if not 0 < holed_area < expected:
    FAILURES.append(f"metric area must subtract holes: got {holed_area:.0f} of {expected:.0f}")

# --- node control ------------------------------------------------------------------
check(
    "traffic_signals tag wins",
    ex.control_of({"highway": "traffic_signals", "street_count": 4}),
    "signal",
)
check("stop tag", ex.control_of({"highway": "stop", "street_count": 3}), "stop")
check("crossing tag is not a control", ex.control_of({"highway": "crossing", "street_count": 4}), None)
check("give_way tag", ex.control_of({"highway": "give_way"}), "stop")
check("untagged", ex.control_of({"street_count": 4}), None)

# --- roundabout --------------------------------------------------------------------
check(
    "roundabout edge detected",
    ex.is_roundabout_edge({"junction": "roundabout", "highway": "tertiary"}),
    True,
)
check(
    "circular edge detected",
    ex.is_roundabout_edge({"junction": "circular", "highway": "secondary"}),
    True,
)
check("normal junction is not a ring", ex.is_roundabout_edge({"junction": "yes"}), False)

# --- merge signature (layer normalisation) -----------------------------------------
sig_none = ex.merge_signature({"highway": "residential", "name": "W Adams St", "layer": None})
sig_zero = ex.merge_signature({"highway": "residential", "name": "W Adams St", "layer": "0"})
check("layer None == layer 0 for merging", sig_none, sig_zero)
sig_upper = ex.merge_signature({"highway": "residential", "name": "W Adams St", "layer": "1"})
if sig_none == sig_upper:
    FAILURES.append("layer 1 must not merge with layer 0")
sig_other_name = ex.merge_signature({"highway": "residential", "name": "W Jackson Blvd"})
if sig_none == sig_other_name:
    FAILURES.append("different street names must not merge")

if FAILURES:
    print(f"FAILED ({len(FAILURES)}):")
    for line in FAILURES:
        print("  -", line)
    sys.exit(1)
print("all parser checks passed")
