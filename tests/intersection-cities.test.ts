import { describe, expect, it } from "vitest";
import { findRoute } from "@/sim/astar";
import { generateCity } from "@/sim/city-generator";
import {
  approachAxisKey,
  deriveApproachGroups,
  validateSignalPlan,
  validateSignalPlanForCity,
  validateSignalState,
} from "@/sim/signals";
import {
  checkTrafficInvariants,
  createTrafficState,
  spawnVehicle,
  stepTraffic,
} from "@/sim/traffic";
import type { TrafficState } from "@/sim/traffic";
import type { City, CitySize } from "@/sim/types";
import { snapshotTraffic } from "./traffic-support";

const ALL_SIZES: CitySize[] = ["small", "small-medium", "medium", "medium-large", "large"];
const SEEDS = [42, 7, 1234, 99, 2026];

const LEGAL_TRANSITIONS = new Set([
  "green->yellow",
  "yellow->all-red",
  "all-red->green",
]);

describe("intersection controls on generated cities", () => {
  it("keeps every signal plan valid across all sizes and multiple seeds", () => {
    let singleGroup = 0;
    let multiGroup = 0;
    let threePlus = 0;
    let totalSignals = 0;
    for (const size of ALL_SIZES) {
      for (const seed of SEEDS) {
        const city = generateCity(size, seed);
        const state = createTrafficState();
        stepTraffic(city, state); // initialises signal states
        let seen = 0;
        for (const intersection of city.intersections) {
          if (intersection.control !== "signal") {
            continue;
          }
          seen += 1;
          totalSignals += 1;
          const signal = state.signals.get(intersection.id);
          expect(signal).toBeDefined();
          if (!signal) {
            continue;
          }
          // Structural plan: at least one group, no empty groups, unique roads.
          expect(signal.groups.length).toBeGreaterThanOrEqual(1);
          expect(validateSignalPlan(signal.groups)).toEqual([]);
          // City-aware: exact partition of incoming roads + axis compatibility.
          expect(validateSignalPlanForCity(city, intersection.id, signal.groups)).toEqual([]);
          expect(validateSignalState(signal)).toEqual([]);
          expect(deriveApproachGroups(city, intersection.id)).toEqual(signal.groups);
          const grouped = signal.groups.flat().sort((a, b) => a - b);
          expect(grouped).toEqual([...intersection.incoming].sort((a, b) => a - b));
          // Structural families: every road classifies, no phase mixes two
          // distinct families, and no family is split across phases.
          const seenFamilies: string[] = [];
          for (const group of signal.groups) {
            expect(group.length).toBeGreaterThanOrEqual(1);
            const families = new Set(
              group.map((roadId) => {
                const key = approachAxisKey(city, roadId);
                expect(key.kind).toBe("family");
                return key.kind === "family" ? key.family : "geometric";
              }),
            );
            expect(families.size).toBe(1);
            const family = [...families][0];
            expect(seenFamilies.includes(family)).toBe(false);
            seenFamilies.push(family);
          }
          if (signal.groups.length === 1) {
            singleGroup += 1;
          } else {
            multiGroup += 1;
          }
          if (signal.groups.length >= 3) {
            threePlus += 1;
          }
        }
        expect(seen).toBeGreaterThan(0);
      }
    }
    // The sweep must actually exercise the interesting topologies.
    expect(singleGroup).toBeGreaterThanOrEqual(1);
    expect(multiGroup).toBeGreaterThan(singleGroup);
    expect(threePlus).toBeGreaterThanOrEqual(1);
    expect(totalSignals).toBeGreaterThan(500);
  });

  it("holds single-group signals green and cycles multi-group signals legally", () => {
    for (const size of ALL_SIZES) {
      const city = generateCity(size, 42);
      const state = createTrafficState();
      stepTraffic(city, state);
      const previous = new Map<number, string>();
      const changed = new Set<number>();
      const illegal = new Set<string>();
      for (const [id, signal] of state.signals) {
        previous.set(id, `${signal.stage}|${signal.phaseIndex}`);
      }
      for (let tick = 0; tick < 420; tick += 1) {
        stepTraffic(city, state);
        for (const [id, signal] of state.signals) {
          const marker = `${signal.stage}|${signal.phaseIndex}`;
          const before = previous.get(id);
          if (before !== marker && before !== undefined) {
            changed.add(id);
            const [prevStage, prevPhase] = before.split("|");
            const transition = `${prevStage}->${signal.stage}`;
            const samePhase = Number(prevPhase) === signal.phaseIndex;
            if (samePhase && !LEGAL_TRANSITIONS.has(transition)) {
              illegal.add(`${transition} at signal ${id}`);
            }
          }
          previous.set(id, marker);
        }
        if (tick % 60 === 0) {
          expect(checkTrafficInvariants(city, state)).toEqual([]);
        }
      }
      for (const [id, signal] of state.signals) {
        if (signal.groups.length === 1) {
          // One-axis intersections hold green — no artificial clearance cycles.
          expect(signal.stage).toBe("green");
          expect(signal.phaseIndex).toBe(0);
          expect(changed.has(id)).toBe(false);
        } else {
          // Any two-group-or-more signal must legally advance within 420 ticks.
          expect(changed.has(id)).toBe(true);
        }
      }
      expect(illegal).toEqual(new Set());
    }
  });

  it("is deterministic across identical runs including signal state", () => {
    for (const size of ["medium", "medium-large"] as CitySize[]) {
      const run = (): TrafficState => {
        const city = generateCity(size, 42);
        const state = createTrafficState();
        for (let i = 0; i < 3600; i += 1) {
          stepTraffic(city, state);
        }
        return state;
      };
      const first = run();
      const second = run();
      expect(snapshotTraffic(first)).toBe(snapshotTraffic(second));
    }
  });

  it("drives a car through the signalized network to arrival", () => {
    const city: City = generateCity("medium", 42);
    const goal = city.intersections.length - 1;
    const route = findRoute(city, 0, goal);
    expect(route.found).toBe(true);
    if (!route.found) {
      return;
    }
    const state = createTrafficState();
    spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: goal,
      route: route.roadIds,
    });
    let ticks = 0;
    while (state.vehicles[0].state !== "arrived" && ticks < 30000) {
      stepTraffic(city, state);
      ticks += 1;
      if (ticks % 100 === 0) {
        expect(checkTrafficInvariants(city, state)).toEqual([]);
      }
    }
    expect(state.vehicles[0].state).toBe("arrived");
    expect(state.occupancy.size).toBe(0);
    expect(state.signals.size).toBeGreaterThan(0);
    expect(state.vehicles[0].tripTimeMs).toBeGreaterThan(0);
    expect(state.vehicles[0].waitTimeMs).toBeGreaterThanOrEqual(0);
  });
});
