/**
 * Canvas 2D renderer (Task 11). Framework-free — React never draws.
 *
 * Ordered passes: background/blocks -> roads -> markings -> intersections and
 * signals -> incident markers -> vehicles -> optional debug overlay.
 *
 * DPR: the backing bitmap is cssSize * devicePixelRatio and the context
 * transform is set to (dpr, 0, 0, dpr, 0, 0) once per frame, so all drawing
 * happens in CSS pixels and DPR is applied exactly once.
 *
 * Visual language: soft off-white ground, grayscale roads (local < arterial /
 * bridge < highway), semantic color ONLY for signal state, wait heat and
 * incidents. No congestion recoloring of roads in V1 — vehicle wait heat
 * carries the congestion signal.
 */
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { RoadKind } from "@/sim/types";
import type { RenderedVehicle } from "./interpolate";
import {
  fitTransform,
  waitHeatBucket,
  WAIT_HEAT_COLORS,
  worldToScreen,
  type StaticRenderModel,
  type ViewTransform,
} from "./model";

export interface RenderFrame {
  readonly model: StaticRenderModel;
  readonly vehicles: readonly RenderedVehicle[];
  readonly snapshot: PresentationSnapshot | null;
  /** Wall-clock milliseconds, used ONLY for visual pulses (never sim state). */
  readonly nowMs: number;
  readonly debug?: boolean;
}

const COLORS = {
  background: "#faf9f7",
  block: "#efede9",
  roadLocal: "#d6d3ce",
  roadArterial: "#c2beb7",
  roadBridge: "#b6b1a9",
  roadHighway: "#a49f97",
  roadClosed: "#c9c4bc",
  roadCasing: "#ffffff",
  marking: "#ffffff",
  intersection: "#b3afa8",
  signalGreen: "#3f9d63",
  signalYellow: "#d9a13c",
  signalRed: "#c4453a",
  signalHalo: "rgba(63, 157, 99, 0.25)",
  incidentCrash: "#c4453a",
  incidentEvent: "#6f66e8",
  closedMark: "#8d8880",
  debug: "#4b5563",
} as const;

const ROAD_WIDTH: Record<RoadKind, number> = {
  local: 2.4,
  arterial: 4.2,
  bridge: 4.6,
  highway: 6.0,
};

const VEHICLE_SIZE: Record<RenderedVehicle["type"], { length: number; width: number }> = {
  car: { length: 6.6, width: 3.4 },
  truck: { length: 9.4, width: 4.0 },
  bicycle: { length: 3.8, width: 2.4 },
};

const CANVAS_PADDING_PX = 20;
const LANE_OFFSET_PX = 1.7;

export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private model: StaticRenderModel | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  setModel(model: StaticRenderModel | null): void {
    this.model = model;
  }

  /**
   * CSS-pixel size + device pixel ratio; backing bitmap follows. Layout size
   * is owned by CSS (the canvas is w-full/h-full) — never pin style.width/
   * height here, or the ResizeObserver would observe the pinned size and
   * resize would stop propagating.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = Math.max(0, Math.floor(cssWidth));
    this.cssHeight = Math.max(0, Math.floor(cssHeight));
    this.dpr = Math.min(3, Math.max(1, Number.isFinite(dpr) ? dpr : 1));
    this.canvas.width = Math.round(this.cssWidth * this.dpr);
    this.canvas.height = Math.round(this.cssHeight * this.dpr);
  }

  draw(frame: RenderFrame): void {
    const model = this.model;
    if (!model || this.cssWidth <= 0 || this.cssHeight <= 0) {
      return; // zero-size initial layout: draw nothing, never throw
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); // DPR exactly once
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    const transform = fitTransform(
      model.bounds,
      this.cssWidth,
      this.cssHeight,
      CANVAS_PADDING_PX,
    );
    this.drawBlocks(ctx, transform, model);
    this.drawRoads(ctx, transform, model, frame.snapshot);
    this.drawMarkings(ctx, transform, model);
    this.drawIntersections(ctx, transform, model, frame.snapshot);
    this.drawIncidents(ctx, transform, model, frame);
    this.drawVehicles(ctx, transform, frame);
    if (frame.debug) {
      this.drawDebug(ctx, frame);
    }
  }

  private drawBlocks(
    ctx: CanvasRenderingContext2D,
    transform: ViewTransform,
    model: StaticRenderModel,
  ): void {
    ctx.fillStyle = COLORS.block;
    for (const block of model.blocks) {
      ctx.beginPath();
      block.points.forEach((point, index) => {
        const screen = worldToScreen(transform, point);
        if (index === 0) {
          ctx.moveTo(screen.x, screen.y);
        } else {
          ctx.lineTo(screen.x, screen.y);
        }
      });
      ctx.closePath();
      ctx.fill();
    }
  }

  private closedRoads(snapshot: PresentationSnapshot | null): Set<number> {
    const closed = new Set<number>();
    if (!snapshot) {
      return closed;
    }
    for (const condition of snapshot.roadConditions) {
      if (condition.closed) {
        closed.add(condition.roadId);
      }
    }
    return closed;
  }

  private drawRoads(
    ctx: CanvasRenderingContext2D,
    transform: ViewTransform,
    model: StaticRenderModel,
    snapshot: PresentationSnapshot | null,
  ): void {
    const closed = this.closedRoads(snapshot);
    ctx.lineCap = "round";
    for (const segment of model.segments) {
      const from = worldToScreen(transform, segment.from);
      const to = worldToScreen(transform, segment.to);
      const isClosed = segment.roadIds.every((roadId) => closed.has(roadId));
      const width = ROAD_WIDTH[segment.kind];
      // Casing keeps roads legible over blocks.
      ctx.strokeStyle = COLORS.roadCasing;
      ctx.lineWidth = width + 1.6;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.strokeStyle = isClosed
        ? COLORS.roadClosed
        : segment.kind === "local"
          ? COLORS.roadLocal
          : segment.kind === "arterial"
            ? COLORS.roadArterial
            : segment.kind === "bridge"
              ? COLORS.roadBridge
              : COLORS.roadHighway;
      ctx.lineWidth = width;
      if (isClosed) {
        ctx.setLineDash([5, 4]);
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (isClosed) {
        // Clear closure mark at the midpoint.
        const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
        const nx = -(to.y - from.y);
        const ny = to.x - from.x;
        const norm = Math.hypot(nx, ny) || 1;
        const arm = width + 3;
        ctx.strokeStyle = COLORS.closedMark;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(mid.x - (nx / norm) * arm, mid.y - (ny / norm) * arm);
        ctx.lineTo(mid.x + (nx / norm) * arm, mid.y + (ny / norm) * arm);
        ctx.stroke();
      }
    }
  }

  private drawMarkings(
    ctx: CanvasRenderingContext2D,
    transform: ViewTransform,
    model: StaticRenderModel,
  ): void {
    ctx.strokeStyle = COLORS.marking;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    for (const segment of model.segments) {
      if (segment.kind === "local") {
        continue; // only larger roads carry a center line
      }
      const from = worldToScreen(transform, segment.from);
      const to = worldToScreen(transform, segment.to);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private drawIntersections(
    ctx: CanvasRenderingContext2D,
    transform: ViewTransform,
    model: StaticRenderModel,
    snapshot: PresentationSnapshot | null,
  ): void {
    const signals = new Map<number, PresentationSnapshot["signals"][number]>();
    for (const signal of snapshot?.signals ?? []) {
      signals.set(signal.intersectionId, signal);
    }
    for (const intersection of model.intersections) {
      const screen = worldToScreen(transform, intersection);
      const signal = signals.get(intersection.id);
      if (signal) {
        const color =
          signal.stage === "green"
            ? COLORS.signalGreen
            : signal.stage === "yellow"
              ? COLORS.signalYellow
              : COLORS.signalRed;
        if (signal.stage === "green") {
          ctx.fillStyle = COLORS.signalHalo;
          ctx.beginPath();
          ctx.arc(screen.x, screen.y, 5.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      } else if (intersection.control === "stop") {
        ctx.fillStyle = COLORS.intersection;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = COLORS.intersection;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawIncidents(
    ctx: CanvasRenderingContext2D,
    transform: ViewTransform,
    model: StaticRenderModel,
    frame: RenderFrame,
  ): void {
    const snapshot = frame.snapshot;
    if (!snapshot) {
      return;
    }
    for (const incident of snapshot.incidents) {
      if (incident.status !== "active") {
        continue; // expired incidents leave the map
      }
      if (incident.kind === "crash") {
        for (const roadId of incident.roadIds) {
          const segmentIndex = model.directedToSegment[roadId];
          const segment = segmentIndex === undefined ? undefined : model.segments[segmentIndex];
          if (!segment) {
            continue;
          }
          const mid = worldToScreen(transform, {
            x: (segment.from.x + segment.to.x) / 2,
            y: (segment.from.y + segment.to.y) / 2,
          });
          ctx.fillStyle = COLORS.incidentCrash;
          ctx.beginPath();
          ctx.arc(mid.x, mid.y, 4.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(mid.x - 1.8, mid.y);
          ctx.lineTo(mid.x + 1.8, mid.y);
          ctx.stroke();
        }
      } else if (incident.kind === "event-release" && incident.eventCenterIntersectionId !== null) {
        const center = model.intersections[incident.eventCenterIntersectionId];
        if (!center) {
          continue;
        }
        const screen = worldToScreen(transform, center);
        const phase = (frame.nowMs % 2500) / 2500; // gentle 2.5 s pulse, visual only
        ctx.strokeStyle = COLORS.incidentEvent;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.85 - phase * 0.45;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 9 + phase * 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawVehicles(
    ctx: CanvasRenderingContext2D,
    transform: ViewTransform,
    frame: RenderFrame,
  ): void {
    const pulse = 0.78 + 0.22 * Math.sin((frame.nowMs % 2500) / 2500 * Math.PI * 2);
    for (const vehicle of frame.vehicles) {
      const screen = worldToScreen(transform, vehicle);
      const bucket = waitHeatBucket(vehicle.blockedWaitMs);
      const size = VEHICLE_SIZE[vehicle.type];
      const scale = Math.max(0.55, Math.min(1.4, transform.scale));
      const length = size.length * scale;
      const width = size.width * scale;
      // Perpendicular lane offset so opposite directions never overlap.
      const perpX = -Math.sin(vehicle.headingRadians) * LANE_OFFSET_PX * vehicle.laneSign;
      const perpY = Math.cos(vehicle.headingRadians) * LANE_OFFSET_PX * vehicle.laneSign;
      ctx.save();
      ctx.translate(screen.x + perpX, screen.y + perpY);
      ctx.rotate(vehicle.headingRadians);
      ctx.fillStyle = WAIT_HEAT_COLORS[bucket];
      ctx.globalAlpha = bucket === 4 ? pulse : 1;
      ctx.beginPath();
      ctx.roundRect(-length / 2, -width / 2, length, width, width / 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  private drawDebug(ctx: CanvasRenderingContext2D, frame: RenderFrame): void {
    ctx.fillStyle = COLORS.debug;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    const lines = [
      `t=${frame.snapshot ? (frame.snapshot.timeMs / 1000).toFixed(1) : "0"}s`,
      `vehicles=${frame.vehicles.length}`,
      `segments=${frame.model.segments.length}`,
    ];
    lines.forEach((line, index) => {
      ctx.fillText(line, 10, 18 + index * 14);
    });
  }
}
