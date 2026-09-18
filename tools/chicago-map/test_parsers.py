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
