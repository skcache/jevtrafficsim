#!/usr/bin/env python3
"""
Timing-derivation oracle for jevtrafficsim fixtures.

WHY THIS EXISTS
---------------
The traffic physics migration (sim/road-traffic.ts + sim/traffic.ts) replaced
"run at free-flow, stop dead at the road end" with a longitudinal model:

    trafficSpeed = speedLimit * typeMultiplier * roadSpeedFactor     (m/s)
    target       = min(trafficSpeed, sqrt(2*a*d_remaining))          if blocked ahead
                 = trafficSpeed                                      otherwise
    speed        = approachSpeed(speed, target, dt)                  (2.2 / 3.6 m/s^2)
    move         = speed * dt                                        (leftover crosses
                                                                      road ends)

and the road speed factor evolves per tick with build/recover time constants:

    pressure = max(occupancy ratio term, queue term, wait term)
    target   = 1 - pressure * (1 - 0.12)
    factor  += (target - factor) * (1 - exp(-dt / tau))              tau = 5000 build,
                                                                           30000 recover

This script is an INDEPENDENT, exact float64 re-implementation of the DOCUMENTED
model plus the queue/transfer/control rules. Fixture expectations are DERIVED
here from the physics -- never copied from the TypeScript implementation's
output. If this oracle and the implementation ever disagree on a fixture, that
is a finding to investigate.

Tick order replicated (sim/traffic.ts stepTraffic):
  0. road traffic factors (from pre-tick occupancy/queues, pre-increment time)
  1. clock += dt
  2. signals advance (mechanics ring; maxGreen force-switch)
  3. trip time for every non-arrived vehicle
  4. pending retries (id order)
  5. queued retries (queuedSinceMs asc, id asc) -- stop-sign grant is shared
     with the movement phase within one tick
  6. movement (route-length-bounded leftover loop; blocked crossing -> queued)
  7. wait accrual for still pending/queued vehicles

Usage: python3 tools/model-timing.py <scenario> [args]
"""

from __future__ import annotations

import math
import sys
from dataclasses import dataclass, field

DT_MS = 100.0
DT_S = 0.1
ACCEL = 2.2
DECEL = 3.6

MIN_FACTOR = 0.12
FREE_OCC = 0.45
SEVERE_OCC = 0.95
SEVERE_QUEUE_SHARE = 0.6
SEVERE_WAIT_MS = 25_000.0
BUILD_TAU = 5_000.0
RECOVER_TAU = 30_000.0

STOP_MIN_MS = 1_500.0
SPILLBACK_RATIO = 0.9
EPS = 1e-9

TYPE_MULT = {"car": 1.0, "truck": 0.7, "bicycle": 0.8}
TYPE_FOOT = {"car": 1.0, "truck": 2.0, "bicycle": 0.3}


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else v


def braking_limit(distance_m: float) -> float:
    if not distance_m > 0:
        return 0.0
    return math.sqrt(2 * DECEL * distance_m)


def approach_speed(current: float, target: float, dt_s: float = DT_S) -> float:
    desired = max(0.0, target)
    if desired > current:
        return min(desired, current + ACCEL * dt_s)
    return max(desired, current - DECEL * dt_s)


def target_factor(occ_ratio: float, queued: float, capacity: float, worst_wait_ms: float) -> float:
    ratio_term = clamp01((clamp01(occ_ratio) - FREE_OCC) / (SEVERE_OCC - FREE_OCC))
    queue_term = clamp01(queued / (capacity * SEVERE_QUEUE_SHARE)) if capacity > 0 else 0.0
    wait_term = clamp01(worst_wait_ms / SEVERE_WAIT_MS)
    pressure = max(ratio_term, queue_term, wait_term)
    return 1 - pressure * (1 - MIN_FACTOR)


@dataclass
class Road:
    id: int
    length: float
    speed_limit: float = 10.0
    capacity: float = 8.0
    closed: bool = False


@dataclass
class Vehicle:
    id: int
    type: str = "car"
    route: list[int] = field(default_factory=list)
    road_id: int | None = None
    progress: float = 0.0
    speed: float = 0.0
    route_index: int = 0
    wait_ms: float = 0.0
    trip_ms: float = 0.0
    state: str = "pending"
    queued_since: float | None = None


@dataclass
class Signal:
    """Timing ring over N groups; group membership given by road ids."""
    groups: list[list[int]]
    timing: tuple[float, float, float, float] = (300.0, 1000.0, 200.0, 100.0)
    stage: str = "green"
    phase: int = 0
    elapsed: float = 0.0

    def step(self) -> None:
        self.elapsed += DT_MS
        if len(self.groups) < 2:
            return  # single-group signals hold green
        min_g, max_g, yellow, allred = self.timing
        if self.stage == "green":
            if self.elapsed >= max_g:
                self.stage = "yellow"
                self.elapsed = 0.0
            return
        if self.stage == "yellow":
            if self.elapsed >= yellow:
                self.stage = "all-red"
                self.elapsed = 0.0
            return
        if self.elapsed >= allred:
            self.stage = "green"
            self.phase = (self.phase + 1) % len(self.groups)
            self.elapsed = 0.0

    def permits(self, incoming: int) -> bool:
        if self.stage != "green":
            return False
        return incoming in self.groups[self.phase]

    def window_start(self, phase: int, within: int = 6000) -> list[int]:
        """Ticks at which the given phase turns green within the first N ticks."""
        starts = []
        sig = Signal([list(g) for g in self.groups], self.timing)
        for tick in range(1, within + 1):
            before = (sig.stage, sig.phase)
            sig.step()
            if (sig.stage, sig.phase) != before and sig.stage == "green" and sig.phase == phase:
                starts.append(tick)
        return starts


@dataclass
class World:
    roads: list[Road]
    controls: dict[int, str] = field(default_factory=dict)  # center id -> control kind
    signals: dict[int, Signal] = field(default_factory=dict)
    center_of_road: dict[int, int] = field(default_factory=dict)  # approach road -> center it leads to
    factor: dict[int, float] = field(default_factory=dict)
    occupancy: dict[int, float] = field(default_factory=dict)
    vehicles: list[Vehicle] = field(default_factory=list)
    time_ms: float = 0.0
    grants: int = 0
    events: list[tuple[int, str]] = field(default_factory=list)
    # Optional per-tick hook, called BEFORE step_road_traffic each tick:
    # fn(tick, world) -- used to emulate engine-level incident effects
    # (crash capacity clamps, closures) without implementing the engine.
    on_tick: object = None
    tick_count: int = 0

    # ---- road traffic factor ----
    def step_road_traffic(self) -> None:
        queued: dict[int, float] = {}
        worst: dict[int, float] = {}
        for v in self.vehicles:
            if v.road_id is None or v.state != "queued":
                continue
            queued[v.road_id] = queued.get(v.road_id, 0) + 1
            if v.queued_since is not None:
                waited = self.time_ms - v.queued_since
                if waited > worst.get(v.road_id, 0.0):
                    worst[v.road_id] = waited
        candidates = set(self.factor.keys())
        for rid, units in self.occupancy.items():
            if units > 0:
                candidates.add(rid)
        for rid in sorted(candidates):
            road = self.roads[rid]
            units = self.occupancy.get(rid, 0.0)
            ratio = units / road.capacity if road.capacity > 0 else 0.0
            target = target_factor(ratio, queued.get(rid, 0), road.capacity, worst.get(rid, 0.0))
            current = self.factor.get(rid, 1.0)
            tau = BUILD_TAU if target < current else RECOVER_TAU
            k = 1 - math.exp(-DT_MS / tau)
            nxt = current + (target - current) * k
            if nxt >= 0.999 and target >= 0.999:
                self.factor.pop(rid, None)
            else:
                self.factor[rid] = nxt

    def speed_factor(self, rid: int) -> float:
        return self.factor.get(rid, 1.0)

    # ---- control ----
    def control_granted(self, incoming: int, queued_since: float | None) -> bool:
        center = self.center_of_road.get(incoming)
        kind = self.controls.get(center, "uncontrolled") if center is not None else "uncontrolled"
        if kind == "uncontrolled":
            return True
        if kind == "signal":
            sig = self.signals[center]
            return sig.permits(incoming)
        if kind == "stop":
            if queued_since is None:
                return False
            if self.time_ms - queued_since < STOP_MIN_MS:
                return False
            return self.grants < 1
        return True

    # ---- capacity ----
    def has_capacity(self, road: Road, footprint: float) -> bool:
        current = self.occupancy.get(road.id, 0.0)
        projected = current + footprint
        if projected > road.capacity + EPS:
            return False
        if current <= EPS:
            return True
        return projected <= road.capacity * SPILLBACK_RATIO + EPS

    def add_occupancy(self, rid: int, units: float) -> None:
        self.occupancy[rid] = self.occupancy.get(rid, 0.0) + units

    def remove_occupancy(self, rid: int, units: float) -> None:
        remaining = self.occupancy.get(rid, 0.0) - units
        if remaining <= EPS:
            self.occupancy.pop(rid, None)
        else:
            self.occupancy[rid] = remaining

    def enter_road(self, v: Vehicle, road: Road, from_origin: bool) -> None:
        self.add_occupancy(road.id, TYPE_FOOT[v.type])
        v.road_id = road.id
        v.progress = 0.0
        free = road.speed_limit * TYPE_MULT[v.type]
        v.speed = free if from_origin else min(v.speed, free)
        v.state = "moving"
        v.queued_since = None

    def leave_road(self, v: Vehicle) -> None:
        if v.road_id is not None:
            self.remove_occupancy(v.road_id, TYPE_FOOT[v.type])

    def attempt_first_entry(self, v: Vehicle) -> None:
        road = self.roads[v.route[0]]
        if road.closed or not self.has_capacity(road, TYPE_FOOT[v.type]):
            return
        self.enter_road(v, road, from_origin=True)

    def attempt_transfer(self, v: Vehicle) -> None:
        if v.road_id is None or v.route_index + 1 >= len(v.route):
            return
        nxt = self.roads[v.route[v.route_index + 1]]
        if nxt.closed or not self.has_capacity(nxt, TYPE_FOOT[v.type]):
            return
        if not self.control_granted(v.road_id, v.queued_since):
            return
        self.leave_road(v)
        v.route_index += 1
        self.enter_road(v, nxt, from_origin=False)

    def advance(self, v: Vehicle) -> None:
        start = self.roads[v.road_id] if v.road_id is not None else None
        if start is not None:
            traffic_speed = start.speed_limit * TYPE_MULT[v.type] * self.speed_factor(start.id)
            has_next = v.route_index + 1 < len(v.route)
            blocked = False
            if has_next:
                nxt = self.roads[v.route[v.route_index + 1]]
                blocked = (
                    nxt.closed
                    or not self.has_capacity(nxt, TYPE_FOOT[v.type])
                    or not self.control_granted(start.id, v.queued_since)
                )
            target = (
                min(traffic_speed, braking_limit(max(0.0, start.length - v.progress)))
                if blocked
                else traffic_speed
            )
            v.speed = approach_speed(v.speed, target)

        remaining = v.speed * DT_S
        guard = 0
        while remaining > 0 and guard <= len(v.route):
            guard += 1
            if v.road_id is None:
                return
            road = self.roads[v.road_id]
            to_end = road.length - v.progress
            if remaining < to_end:
                v.progress += remaining
                return
            remaining -= to_end
            v.progress = road.length
            if v.route_index + 1 >= len(v.route):
                self.leave_road(v)
                v.state = "arrived"
                v.queued_since = None
                self.events.append((int(self.time_ms), f"v{v.id} arrived"))
                return
            nxt = self.roads[v.route[v.route_index + 1]]
            if (
                nxt.closed
                or not self.has_capacity(nxt, TYPE_FOOT[v.type])
                or not self.control_granted(v.road_id, v.queued_since)
            ):
                v.state = "queued"
                v.queued_since = self.time_ms
                self.events.append((int(self.time_ms), f"v{v.id} queued on road {v.road_id}"))
                return
            self.leave_road(v)
            v.route_index += 1
            self.enter_road(v, nxt, from_origin=False)

    def step(self) -> None:
        self.tick_count += 1
        if callable(self.on_tick):
            self.on_tick(self.tick_count, self)
        self.step_road_traffic()
        self.time_ms += DT_MS
        for sig in self.signals.values():
            sig.step()
        for v in self.vehicles:
            if v.state != "arrived":
                v.trip_ms += DT_MS
        for v in self.vehicles:
            if v.state == "pending":
                self.attempt_first_entry(v)
        self.grants = 0
        queued = sorted(
            (v for v in self.vehicles if v.state == "queued"),
            key=lambda v: (v.queued_since if v.queued_since is not None else 0.0, v.id),
        )
        for v in queued:
            self.attempt_transfer(v)
        for v in self.vehicles:
            if v.state == "moving":
                self.advance(v)
        for v in self.vehicles:
            if v.state in ("pending", "queued"):
                v.wait_ms += DT_MS

    def spawn(self, v: Vehicle) -> Vehicle:
        self.vehicles.append(v)
        if v.state == "pending":
            self.attempt_first_entry(v)
        return v

    def tick_of(self, predicate, limit: int = 5000) -> int | None:
        for _ in range(1, limit + 1):
            self.step()
            if predicate(self):
                return self.tick_count
        return None

    def trace(self, ticks: int) -> None:
        for tick in range(1, ticks + 1):
            self.step()
            cars = " | ".join(
                f"v{v.id} {v.state[:4]} r{v.road_id} p={v.progress:.4f} s={v.speed:.4f} q={v.queued_since}"
                for v in self.vehicles
            )
            factors = {k: round(val, 5) for k, val in sorted(self.factor.items())}
            print(f"tick {tick:4d} t={self.time_ms:7.1f} {cars}  f={factors} occ={dict(sorted(self.occupancy.items()))}")


def street_with_crossing(length: float, capacity: float = 4.0, speed_limit: float = 10.0):
    """Car on road 0 whose route continues onto a CLOSED road 1.

    Capacity defaults to 4: the same default the test helpers
    (makeStreet / makeCrossroads) use.
    The car must cross road 0's end to transfer, so it brakes to the stop line
    and queues there. Returns (world, vehicle).
    """
    roads = [Road(0, length, speed_limit, capacity), Road(1, 10.0, speed_limit, capacity, closed=True)]
    w = World(roads)
    v = Vehicle(0, "car", [0, 1])
    w.spawn(v)
    return w, v


def stop_sign_pair(approach: float, exit_: float, capacity: float = 4.0):
    """Stop-controlled center: car on road 0 (approach) crossing to road 1 (exit)."""
    roads = [Road(0, approach, 10.0, capacity), Road(1, exit_, 10.0, capacity)]
    w = World(roads, controls={0: "stop"}, center_of_road={0: 0})
    return w


def crossroads(control: str, arm_lengths: list[tuple[float, float]], timing=None, capacity: float = 4.0):
    """Crossroads: for each arm (approach_len, exit_len) add approach road 2i and exit 2i+1.

    Capacity defaults to 4 (makeCrossroads default). Returns (world, approach_ids, exit_ids).
    """
    roads: list[Road] = []
    approaches: list[int] = []
    exits: list[int] = []
    for i, (a_len, e_len) in enumerate(arm_lengths):
        approaches.append(len(roads))
        roads.append(Road(len(roads), a_len, capacity=capacity))
        exits.append(len(roads))
        roads.append(Road(len(roads), e_len, capacity=capacity))
    centers = {0: control}
    signals = {}
    if control == "signal":
        # 4-arm: group 0 = east-west (arm 0, 2), group 1 = north-south (arm 1, 3)
        group0 = [approaches[i] for i in (0, 2) if i < len(approaches)]
        group1 = [approaches[i] for i in (1, 3) if i < len(approaches)]
        signals[0] = Signal([group0, group1], timing or (300.0, 1000.0, 200.0, 100.0))
    center_of_road = {a: 0 for a in approaches}
    w = World(roads, controls=centers, signals=signals, center_of_road=center_of_road)
    return w, approaches, exits


def report(label: str, value) -> None:
    print(f"{label}: {value}")


# --------------------------------------------------------------------------
# Scenarios used to derive fixture timings
# --------------------------------------------------------------------------


def sc_crossing(args: list[str]) -> None:
    """Blocked crossing: when does a lone car queue at the stop line?"""
    length = float(args[0]) if args else 30.0
    cap = float(args[1]) if len(args) > 1 else 8.0
    w, v = street_with_crossing(length, cap)
    tick = w.tick_of(lambda _w: v.state == "queued")
    print(f"L={length} cap={cap}: queue tick={tick} speed={v.speed:.6f} waitAtQueue={v.wait_ms}")


def sc_stop(args: list[str]) -> None:
    """Stop-sign pair: queue tick, release tick, wait accounting."""
    approach = float(args[0]) if args else 30.0
    exit_ = float(args[1]) if len(args) > 1 else 30.0
    n = int(args[2]) if len(args) > 2 else 1
    w = stop_sign_pair(approach, exit_)
    for i in range(n):
        w.spawn(Vehicle(i, "car", [0, 1]))
        if i == 0 and n > 1:
            # additional cars in the SAME tick (like a fixture spawning them together)
            pass
    for i in range(1, n):
        w.spawn(Vehicle(i, "car", [0, 1]))
    ticks = []
    for tick in range(1, 400):
        w.step()
        ticks.append(tick)
        if all(x.state == "arrived" for x in w.vehicles):
            break
    for x in w.vehicles:
        print(f"  v{x.id}: state={x.state} queue_since={x.queued_since} wait={x.wait_ms} trip={x.trip_ms} road={x.road_id}")
    print(f"  total ticks={ticks[-1]}")


def sc_signal(args: list[str]) -> None:
    """Signalized crossroads with 4 arms; derive queue/release ticks for arm 1."""
    arm = float(args[0]) if args else 30.0
    exit_ = float(args[1]) if len(args) > 1 else 30.0
    e2 = float(args[2]) if len(args) > 2 else None  # e2 exit road length for arm 1
    arms = [(arm, exit_), (arm, exit_ if e2 is None else e2), (arm, exit_), (arm, exit_)]
    w, approaches, exits = crossroads("signal", arms, timing=(300.0, 1000.0, 200.0, 100.0))
    sig = w.signals[0]
    starts0 = sig.window_start(0)
    starts1 = sig.window_start(1)
    print(f"green0 starts: {starts0[:6]}")
    print(f"green1 starts: {starts1[:6]}")
    v = Vehicle(0, "car", [approaches[1], exits[1]])
    w.spawn(v)
    for tick in range(1, 120):
        w.step()
        if v.state == "queued":
            print(f"queued at tick {tick} (t={w.time_ms:.0f}) speed={v.speed:.4f}")
            break
    while v.state == "queued" and w.time_ms < 6000:
        w.step()
    print(
        f"released at t={w.time_ms:.0f} (tick {int(w.time_ms / 100):d}) wait={v.wait_ms} "
        f"road={v.road_id} routeIndex={v.route_index}"
    )
    while v.state != "arrived" and w.time_ms < 12_000:
        w.step()
    print(f"arrived at t={w.time_ms:.0f} trip={v.trip_ms}")
    print("events:", w.events)


def sc_lead(args: list[str]) -> None:
    """Trace with factor/occupancy columns (debugging aid)."""
    length = float(args[0]) if args else 30.0
    ticks = int(args[1]) if len(args) > 1 else 60
    w, v = street_with_crossing(length)
    w.trace(ticks)


def sc_fixtures(args: list[str]) -> None:
    """Print the derived fixture timings the migrated tests assert.

    Every number below is computed from the documented discrete motion law --
    it is the derivation record for tests/*.test.ts after the physics
    migration. Re-run after any model change and compare with the test files.
    """
    print("-- crossing rule: lone car braking to a blocked road end --")
    for length in (14, 20, 30, 40, 48, 50, 60, 80, 100):
        w, v = street_with_crossing(length)
        tick = w.tick_of(lambda _w: v.state == "queued")
        print(f"   L={length:4d}: queue tick {tick} (L+10 for L>=14), speed at line {v.speed:.4f}")

    print("-- stop sign: approach 30 / exit 30 --")
    w = stop_sign_pair(30, 30)
    v = mt_vehicle(w, 0, [0, 1])
    arrival = w.tick_of(lambda _w: v.state == "queued")
    since = v.queued_since
    release = w.tick_of(lambda _w: v.state == "moving")
    print(f"   queue {arrival} (queuedSince {since:.0f}), release {release} (STOP_TICKS offset), wait {v.wait_ms:.0f}")

    print("-- signal: 4-arm crossroads arms 30, FAST timing (10/2/1) --")
    w, approaches, exits = crossroads("signal", [(30, 30)] * 4, timing=(300.0, 1000.0, 200.0, 100.0))
    print(f"   group-1 green windows: {w.signals[0].window_start(1)[:4]}")
    v = mt_vehicle(w, 0, [approaches[1], exits[1]])
    arrival = w.tick_of(lambda _w: v.state == "queued")
    release = w.tick_of(lambda _w: v.state == "moving")
    arrived = w.tick_of(lambda _w: v.state == "arrived")
    print(f"   arm-1 car: queue {arrival}, release {release}, arrival {arrived}")

    print("-- traffic capacity: waiter approach 30, blocker on 80 m / cap 2 --")
    w = World([Road(0, 30.0, 10.0, 4.0), Road(1, 80.0, 10.0, 2.0)])
    blocker = mt_vehicle(w, 0, [1])
    waiter = mt_vehicle(w, 1, [0, 1])
    queue = w.tick_of(lambda _w: waiter.state == "queued")
    blocker_done = w.tick_of(lambda _w: blocker.state == "arrived")
    release = w.tick_of(lambda _w: waiter.state == "moving")
    arrived = w.tick_of(lambda _w: waiter.state == "arrived")
    print(f"   waiter queue {queue}, blocker arrives {blocker_done}, release {release}, arrival {arrived}")

    print("-- crash: 3 residents on a 50 m road clamped to cap 3 (severe) --")
    w = World([Road(0, 50.0, 10.0, 4.0), Road(1, 50.0, 10.0, 4.0)])
    for i in range(3):
        mt_vehicle(w, i, [0, 1])
    waiter = mt_vehicle(w, 3, [0, 1])

    def crash_hook(tick, world):
        if tick >= 2:  # crash at 100 ms = second tick
            world.roads[0].capacity = max(2.0, world.occupancy.get(0, 0.0))

    w.on_tick = crash_hook
    drain = w.tick_of(lambda _w: _w.occupancy.get(0, 0.0) == 0.0)
    admitted = w.tick_of(lambda _w: waiter.state == "moving")
    print(f"   road 0 drains {drain}; waiter admitted {admitted} at capacity {w.roads[0].capacity:.0f}")

    print("-- spillback drains --")
    w = World([Road(0, 10.0, 10.0, 1.0)])
    c = mt_vehicle(w, 0)
    mt_vehicle(w, 1)
    print(f"   cap-1 / 10 m: car arrives tick {w.tick_of(lambda _w: c.state == 'arrived')}")
    w = World([Road(0, 100.0, 10.0, 20.0)])
    for i in range(9):
        mt_vehicle(w, i, [0], type_="truck")
    mt_vehicle(w, 9, [0], type_="bicycle")
    mt_vehicle(w, 10, [0], type_="bicycle")
    mt_vehicle(w, 11, [0])
    last = w.tick_of(lambda _w: all(v.state == "arrived" for v in w.vehicles), limit=2000)
    print(f"   9 trucks + 2 bikes + car on 100 m / cap 20: all arrived tick {last}")

    print("-- approach stats: 4-arm signal arms 48 cap 8, FAST --")
    w, approaches, exits = crossroads("signal", [(48, 48)] * 4, timing=(300.0, 1000.0, 200.0, 100.0), capacity=8)
    c0 = mt_vehicle(w, 0, [approaches[3], exits[3]])
    c1 = mt_vehicle(w, 1, [approaches[1], exits[1]])
    mt_vehicle(w, 2, [approaches[1], exits[1]])
    queue = w.tick_of(lambda _w: all(v.state == "queued" for v in w.vehicles))
    since = c1.queued_since
    release = w.tick_of(lambda _w: all(v.state != "queued" for v in w.vehicles))
    arrived = w.tick_of(lambda _w: all(v.state == "arrived" for v in w.vehicles))
    print(f"   all queue {queue} (since {since:.0f}), release {release}, arrival {arrived}")

    print("-- K3: S1 default + S2 FAST, roads 30/30/60/30 --")
    roads = [Road(0, 30.0, 10.0, 4.0), Road(1, 30.0, 10.0, 4.0), Road(2, 60.0, 10.0, 4.0),
             Road(3, 30.0, 10.0, 4.0), Road(4, 30.0, 10.0, 4.0), Road(5, 30.0, 10.0, 4.0)]
    w = World(roads, controls={1: "signal", 3: "signal"})
    w.center_of_road = {0: 1, 4: 1, 2: 3, 5: 3}
    w.signals[1] = Signal([[4], [0]], (5000.0, 30000.0, 3000.0, 1000.0))
    w.signals[3] = Signal([[5], [2]], (300.0, 1000.0, 200.0, 100.0))
    v = mt_vehicle(w, 0, [0, 1, 2, 3])
    peak0 = 0.0
    s2_queue = None
    for tick in range(1, 451):
        w.step()
        if v.state == "queued" and v.road_id == 0:
            peak0 = max(peak0, w.time_ms - (v.queued_since or 0))
        if s2_queue is None and v.state == "queued" and v.road_id == 2:
            s2_queue = tick
    print(f"   S1 peak continuous wait {peak0:.0f}; S2 queues {s2_queue}; "
          f"lifetime wait at tick 450 {v.wait_ms:.0f}; S2 continuous wait at 450 {w.time_ms - (v.queued_since or 0):.0f}")


def mt_vehicle(w: World, vid: int, route=None, type_: str = "car") -> Vehicle:
    v = Vehicle(vid, type_, route or [0])
    w.spawn(v)
    return v


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd, args = sys.argv[1], sys.argv[2:]
    scenarios = {
        "crossing": sc_crossing,
        "stop": sc_stop,
        "signal": sc_signal,
        "trace": sc_lead,
        "fixtures": sc_fixtures,
    }
    if cmd in scenarios:
        scenarios[cmd](args)
    else:
        print(f"unknown scenario {cmd!r}; known: {', '.join(scenarios)}")


if __name__ == "__main__":
    main()
