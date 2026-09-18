/**
 * Deterministic procedural city generation (PRD §7.2).
 *
 * Pipeline (each phase uses its own named RNG fork off `fork("city")`, so a
 * change in one phase can never shift another phase's draws):
 *
 *   1. coarse lattice           — grid dimensions chosen inside the size range
 *   2. jittered positions       — uneven block spacing + per-node jitter
 *   3. river + bridges          — Medium-Large and above (PRD §7.2 step 7);
 *                                 bridges are the only crossings, >= 2 so a
 *                                 single closure can never strand a half
 *   4. selective local pruning  — T-junctions and irregular blocks with a
 *                                 per-bank connectivity guard on every removal
 *                                 (removals can never isolate either river bank)
 *   5. highway line             — Medium and above (PRD §7.2 step 6)
 *   6. arterial lines           — continuous N-S columns and E-W rows
 *   7. diagonal corridors       — cross-city shortcuts, Medium and above
 *   8. controls + regions       — signal/stop/uncontrolled + region ids
 *   9. materialization          — directed Road pairs, corridors, validation
 *
 * Determinism: same citySize + seed => byte-identical topology. There are no
 * ambient/unseeded random sources — all randomness flows through the seeded
 * RNG forks.
 */
import {
  CITY_SIZE_SPECS,
  ROAD_KIND_DEFAULTS,
  type CitySizeSpec,
} from "./config";
import { validateCity } from "./graph";
import { createRng, type Rng } from "./rng";
import type {
  City,
  CitySize,
  Corridor,
  CorridorKind,
  Intersection,
  Road,
  RoadId,
  RoadKind,
} from "./types";

/** Lattice spacing in world units before jitter. */
const BASE_CELL = 100;

type SegmentKind = RoadKind | "diagonal";

interface Segment {
  a: number; // lower intersection id
  b: number; // higher intersection id
  kind: SegmentKind;
}

/** Kind priority when phases overlap: never downgrade a stronger segment. */
const SEGMENT_STRENGTH: Record<SegmentKind, number> = {
  local: 0,
  diagonal: 1,
  arterial: 2,
  bridge: 3,
  highway: 4,
};

function nodeId(row: number, col: number, width: number): number {
  return row * width + col;
}

function segmentKey(nodeCount: number, a: number, b: number): number {
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return low * nodeCount + high;
}

/** Adds a segment, or upgrades an existing one to the stronger kind. */
function setSegment(
  segments: Map<number, Segment>,
  nodeCount: number,
  a: number,
  b: number,
  kind: SegmentKind,
): void {
  const key = segmentKey(nodeCount, a, b);
  const existing = segments.get(key);
  if (!existing) {
    segments.set(key, { a: Math.min(a, b), b: Math.max(a, b), kind });
  } else if (SEGMENT_STRENGTH[kind] > SEGMENT_STRENGTH[existing.kind]) {
    existing.kind = kind;
  }
}

/**
 * Picks lattice dimensions whose intersection count lands in the size range,
 * preferring near-target counts and near-square (slightly landscape) shapes.
 */
function chooseDimensions(
  spec: CitySizeSpec,
  rng: Rng,
): { width: number; height: number } {
  const target = rng.nextInt(spec.minIntersections, spec.maxIntersections);
  let best: { width: number; height: number } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let width = 2; width <= 48; width += 1) {
    for (let height = 2; height <= 48; height += 1) {
      const count = width * height;
      if (count < spec.minIntersections || count > spec.maxIntersections) {
        continue;
      }
      const ratio = Math.max(width, height) / Math.min(width, height);
      if (ratio > 2) {
        continue; // no degenerate strips
      }
      const score =
        Math.abs(count - target) * 2 +
        Math.abs(width - height) +
        (height > width ? 0.5 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { width, height };
      }
    }
  }
  if (!best) {
    throw new Error(
      `no lattice dimensions fit ${spec.minIntersections}-${spec.maxIntersections} intersections`,
    );
  }
  return best;
}

/** Uneven block spacing plus bounded per-node jitter (never zero-length). */
function buildNodePositions(
  width: number,
  height: number,
  rng: Rng,
): Array<{ x: number; y: number }> {
  const xs: number[] = [0];
  for (let col = 1; col < width; col += 1) {
    xs.push(xs[col - 1] + BASE_CELL * (0.85 + rng.nextFloat() * 0.3));
  }
  const ys: number[] = [0];
  for (let row = 1; row < height; row += 1) {
    ys.push(ys[row - 1] + BASE_CELL * (0.85 + rng.nextFloat() * 0.3));
  }
  const positions: Array<{ x: number; y: number }> = [];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      positions.push({
        x: xs[col] + (rng.nextFloat() * 2 - 1) * BASE_CELL * 0.32,
        y: ys[row] + (rng.nextFloat() * 2 - 1) * BASE_CELL * 0.32,
      });
    }
  }
  return positions;
}

function addLattice(
  segments: Map<number, Segment>,
  nodeCount: number,
  width: number,
  height: number,
): void {
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const here = nodeId(row, col, width);
      if (col + 1 < width) {
        setSegment(segments, nodeCount, here, nodeId(row, col + 1, width), "local");
      }
      if (row + 1 < height) {
        setSegment(segments, nodeCount, here, nodeId(row + 1, col, width), "local");
      }
    }
  }
}

/** The four sides of cell (row, col); side 0=top, 1=left, 2=right, 3=bottom. */
function cellSide(row: number, col: number, side: number, width: number): [number, number] {
  const topLeft = nodeId(row, col, width);
  const topRight = nodeId(row, col + 1, width);
  const bottomLeft = nodeId(row + 1, col, width);
  const bottomRight = nodeId(row + 1, col + 1, width);
  switch (side) {
    case 0:
      return [topLeft, topRight];
    case 1:
      return [topLeft, bottomLeft];
    case 2:
      return [topRight, bottomRight];
    default:
      return [bottomLeft, bottomRight];
  }
}

/**
 * Removes a deterministic subset of local segments to create T-junctions and
 * irregular blocks. Every removal is BFS-guarded: an edge is kept removed
 * only while both endpoints stay mutually reachable, so the city can never
 * silently disconnect.
 */
function pruneLocalEdges(
  segments: Map<number, Segment>,
  nodeCount: number,
  width: number,
  height: number,
  rng: Rng,
  cutCol: number | null,
): void {
  const adjacency: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  for (const segment of segments.values()) {
    adjacency[segment.a].add(segment.b);
    adjacency[segment.b].add(segment.a);
  }
  // 0 = west bank (or all of a riverless city), 1 = east bank. A removal is
  // accepted only while both endpoints stay mutually reachable WITHIN their
  // own bank, so no bank can ever end up depending on a bridge crossing.
  const sideOf = (id: number): number =>
    cutCol === null ? 0 : id % width <= cutCol ? 0 : 1;
  const budget = Math.round((width - 1) * (height - 1) * 0.3);
  let removed = 0;
  for (let row = 0; row < height - 1 && removed < budget; row += 1) {
    for (let col = 0; col < width - 1 && removed < budget; col += 1) {
      const [a, b] = cellSide(row, col, rng.nextInt(0, 3), width);
      const key = segmentKey(nodeCount, a, b);
      const segment = segments.get(key);
      if (!segment || segment.kind !== "local") {
        continue;
      }
      segments.delete(key);
      adjacency[a].delete(b);
      adjacency[b].delete(a);
      if (reachesWithinBank(adjacency, a, b, sideOf)) {
        removed += 1;
      } else {
        setSegment(segments, nodeCount, a, b, "local"); // keep that bank connected
        adjacency[a].add(b);
        adjacency[b].add(a);
      }
    }
  }
}

function reachesWithinBank(
  adjacency: Set<number>[],
  start: number,
  goal: number,
  sideOf: (id: number) => number,
): boolean {
  const side = sideOf(start);
  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === goal) {
      return true;
    }
    for (const next of adjacency[current]) {
      if (!seen.has(next) && sideOf(next) === side) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Picks `count` line indices spread across `dimension`, avoiding `avoid`. */
function pickLineIndices(
  count: number,
  dimension: number,
  avoid: number,
  rng: Rng,
): number[] {
  const picked: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let index =
      Math.round(((i + 1) * dimension) / (count + 1)) + rng.nextInt(-1, 1);
    index = Math.max(0, Math.min(dimension - 1, index));
    if (index === avoid) {
      index = index + 1 < dimension ? index + 1 : index - 1;
    }
    let guard = 0;
    while (picked.includes(index) && guard < dimension) {
      index = index + 1 < dimension ? index + 1 : index - 1;
      guard += 1;
    }
    if (index >= 0 && index < dimension && !picked.includes(index)) {
      picked.push(index);
    }
  }
  return picked;
}

/** Promotes a full north-south line to `kind`, restoring pruned segments. */
function promoteColumn(
  segments: Map<number, Segment>,
  nodeCount: number,
  width: number,
  height: number,
  col: number,
  kind: SegmentKind,
): number[] {
  const keys: number[] = [];
  for (let row = 0; row < height - 1; row += 1) {
    const a = nodeId(row, col, width);
    const b = nodeId(row + 1, col, width);
    setSegment(segments, nodeCount, a, b, kind);
    keys.push(segmentKey(nodeCount, a, b));
  }
  return keys;
}

/** Promotes a full east-west line to `kind`, restoring pruned segments. */
function promoteRow(
  segments: Map<number, Segment>,
  nodeCount: number,
  width: number,
  row: number,
  kind: SegmentKind,
): number[] {
  const keys: number[] = [];
  for (let col = 0; col < width - 1; col += 1) {
    const a = nodeId(row, col, width);
    const b = nodeId(row, col + 1, width);
    setSegment(segments, nodeCount, a, b, kind);
    keys.push(segmentKey(nodeCount, a, b));
  }
  return keys;
}

/** Rows for bridge crossings, spread out and deduplicated deterministically. */
function spreadRows(height: number, count: number, rng: Rng): number[] {
  const rows: number[] = [];
  for (let i = 0; i < count; i += 1) {
    let row = Math.round(((i + 1) * height) / (count + 1)) + rng.nextInt(-1, 1);
    row = Math.max(0, Math.min(height - 1, row));
    let guard = 0;
    while (rows.includes(row) && guard < height) {
      row = row + 1 < height ? row + 1 : row - 1;
      guard += 1;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Cuts a river between two columns: every crossing segment is severed except
 * at the bridge rows, where the crossing becomes a bridge (restored if the
 * pruning phase had removed it — bridges are structural).
 */
function applyRiver(
  segments: Map<number, Segment>,
  nodeCount: number,
  width: number,
  height: number,
  spec: CitySizeSpec,
  rng: Rng,
): { cutCol: number; bridgeRows: number[] } {
  const low = Math.max(1, Math.floor(width * 0.4));
  const high = Math.min(width - 2, Math.max(low, Math.floor(width * 0.6)));
  const cutCol = rng.nextInt(low, high);
  const bridgeRows = spreadRows(height, spec.bridgeCount, rng);
  for (let row = 0; row < height; row += 1) {
    const a = nodeId(row, cutCol, width);
    const b = nodeId(row, cutCol + 1, width);
    if (bridgeRows.includes(row)) {
      setSegment(segments, nodeCount, a, b, "bridge");
    } else {
      segments.delete(segmentKey(nodeCount, a, b));
    }
  }
  return { cutCol, bridgeRows };
}

/**
 * Diagonal cross-city corridors: chains of new segments stepping one column
 * per row. Diagonals that would cross the river cut are skipped (they are
 * never bridges — the river's crossings stay a countable bottleneck set).
 */
function addDiagonalCorridors(
  segments: Map<number, Segment>,
  nodeCount: number,
  width: number,
  height: number,
  count: number,
  cutCol: number | null,
  rng: Rng,
): number[][] {
  const corridorKeys: number[][] = [];
  const usedPerDirection = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const direction = i % 2 === 0 ? 1 : -1;
    const repeat = usedPerDirection.get(direction) ?? 0;
    usedPerDirection.set(direction, repeat + 1);
    const offset = Math.floor((i + 1) / 2);
    const jitter = rng.nextInt(0, Math.max(0, Math.floor(width / 6)));
    let col =
      direction === 1
        ? Math.min(width - 1, jitter + repeat + offset)
        : Math.max(0, width - 1 - jitter - repeat - offset);
    const keys: number[] = [];
    let row = 0;
    while (row + 1 < height && col + direction >= 0 && col + direction < width) {
      const crosses =
        cutCol !== null && Math.min(col, col + direction) === cutCol;
      if (!crosses) {
        const a = nodeId(row, col, width);
        const b = nodeId(row + 1, col + direction, width);
        setSegment(segments, nodeCount, a, b, "diagonal");
        const key = segmentKey(nodeCount, a, b);
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
      col += direction;
      row += 1;
    }
    corridorKeys.push(keys);
  }
  return corridorKeys;
}

function regionIdFor(
  id: number,
  width: number,
  height: number,
  spec: CitySizeSpec,
): number {
  const col = id % width;
  const row = Math.floor(id / width);
  const regionCol = Math.floor((col * spec.regionCols) / width);
  const regionRow = Math.floor((row * spec.regionRows) / height);
  return regionRow * spec.regionCols + regionCol;
}

export function generateCity(size: CitySize, seed: number): City {
  const spec = CITY_SIZE_SPECS[size];
  const root = createRng(seed).fork("city");
  const dimRng = root.fork("dims");
  const jitterRng = root.fork("jitter");
  const removalRng = root.fork("removal");
  const structureRng = root.fork("structure");

  // 1-2. lattice + jittered positions
  const { width, height } = chooseDimensions(spec, dimRng);
  const nodeCount = width * height;
  const positions = buildNodePositions(width, height, jitterRng);

  // 3. base lattice
  const segments = new Map<number, Segment>();
  addLattice(segments, nodeCount, width, height);

  // 4. river + bridges first — the pruning guard below must account for the
  //    barrier so it cannot strand a node that relies on one bank's edges.
  let cutCol: number | null = null;
  let bridgeRows: number[] = [];
  if (spec.hasRiver) {
    const river = applyRiver(segments, nodeCount, width, height, spec, structureRng);
    cutCol = river.cutCol;
    bridgeRows = river.bridgeRows;
  }

  // 5. connectivity-guarded pruning (never isolates a node within its bank)
  pruneLocalEdges(segments, nodeCount, width, height, removalRng, cutCol);

  const corridorParts: Array<{ kind: CorridorKind; keys: number[] }> = [];

  // 6. highway line (Medium and above)
  const hwCol = spec.hasHighway ? width - 2 : -1;
  if (spec.hasHighway) {
    corridorParts.push({
      kind: "highway",
      keys: promoteColumn(segments, nodeCount, width, height, hwCol, "highway"),
    });
  }

  // 6. arterial lines: N-S columns avoid the highway; E-W rows are the
  //    bridge rows in river cities, picked spread-out lines otherwise.
  for (const col of pickLineIndices(spec.arterialCols, width, hwCol, structureRng)) {
    corridorParts.push({
      kind: "arterial",
      keys: promoteColumn(segments, nodeCount, width, height, col, "arterial"),
    });
  }
  const arterialRowIndices = spec.hasRiver
    ? bridgeRows
    : pickLineIndices(spec.arterialRows, height, -1, structureRng);
  for (const row of arterialRowIndices) {
    corridorParts.push({
      kind: "arterial",
      keys: promoteRow(segments, nodeCount, width, row, "arterial"),
    });
  }

  // 7. diagonal corridors (Medium and above)
  for (const keys of addDiagonalCorridors(
    segments,
    nodeCount,
    width,
    height,
    spec.diagonalCount,
    cutCol,
    structureRng,
  )) {
    corridorParts.push({ kind: "diagonal", keys });
  }

  // 8. controls derive from final structure: anything touching an arterial,
  //    highway, or bridge is signalized; ordinary junctions with 3+ arms get
  //    stop control; the rest are uncontrolled through nodes.
  const neighborSets: Array<Set<number>> = Array.from(
    { length: nodeCount },
    () => new Set<number>(),
  );
  const highOrderNodes = new Set<number>();
  for (const segment of segments.values()) {
    neighborSets[segment.a].add(segment.b);
    neighborSets[segment.b].add(segment.a);
    if (
      segment.kind === "arterial" ||
      segment.kind === "highway" ||
      segment.kind === "bridge" ||
      segment.kind === "diagonal"
    ) {
      highOrderNodes.add(segment.a);
      highOrderNodes.add(segment.b);
    }
  }

  // 9. materialize: directed Road pair per segment, dense ids.
  const sortedKeys = [...segments.keys()].sort((x, y) => x - y);
  const segmentRoadIds = new Map<number, [number, number]>();
  const intersections: Intersection[] = positions.map((position, id) => ({
    id,
    x: position.x,
    y: position.y,
    incoming: [],
    outgoing: [],
    control: highOrderNodes.has(id)
      ? "signal"
      : neighborSets[id].size >= 3
        ? "stop"
        : "uncontrolled",
    regionId: regionIdFor(id, width, height, spec),
  }));
  const roads: Road[] = [];
  for (const key of sortedKeys) {
    const segment = segments.get(key);
    if (!segment) {
      continue;
    }
    const roadKind: RoadKind = segment.kind === "diagonal" ? "arterial" : segment.kind;
    const defaults = ROAD_KIND_DEFAULTS[roadKind];
    const length = Math.hypot(
      positions[segment.a].x - positions[segment.b].x,
      positions[segment.a].y - positions[segment.b].y,
    );
    const forward: Road = {
      id: roads.length,
      from: segment.a,
      to: segment.b,
      length,
      lanes: defaults.lanes,
      speedLimit: defaults.speedLimit,
      capacity: defaults.capacity,
      kind: roadKind,
      closed: false,
    };
    roads.push(forward);
    const backward: Road = { ...forward, id: roads.length, from: segment.b, to: segment.a };
    roads.push(backward);
    intersections[segment.a].outgoing.push(forward.id);
    intersections[segment.b].incoming.push(forward.id);
    intersections[segment.b].outgoing.push(backward.id);
    intersections[segment.a].incoming.push(backward.id);
    segmentRoadIds.set(key, [forward.id, backward.id]);
  }

  const corridors: Corridor[] = corridorParts.map((part, index) => ({
    id: index,
    kind: part.kind,
    roadIds: part.keys.flatMap(
      (key): RoadId[] => segmentRoadIds.get(key) ?? [],
    ),
  }));

  const city: City = {
    size,
    seed,
    gridWidth: width,
    gridHeight: height,
    intersections,
    roads,
    corridors,
  };
  const problems = validateCity(city);
  if (problems.length > 0) {
    throw new Error(`city generation produced an invalid city: ${problems[0]}`);
  }
  return city;
}

/** Compact structural signature for determinism checks and debugging. */
export function citySignature(city: City): string {
  const parts: string[] = [
    `${city.size}|${city.gridWidth}x${city.gridHeight}|seed=${city.seed}`,
  ];
  for (const node of city.intersections) {
    parts.push(`n${node.id}:${node.x},${node.y}:${node.control}:${node.regionId}`);
  }
  for (const road of city.roads) {
    parts.push(`r${road.id}:${road.from}>${road.to}:${road.kind}:${road.length}`);
  }
  for (const corridor of city.corridors) {
    parts.push(`c${corridor.id}:${corridor.kind}:${corridor.roadIds.join(".")}`);
  }
  return parts.join("|");
}
