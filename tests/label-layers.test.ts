/**
 * Label layers: zoom ranges, collision settings and priority. These are the
 * rules that keep labels from turning into overlapping text soup, so they are
 * asserted rather than eyeballed.
 */
import { describe, expect, it } from "vitest";
import { buildLabelLayers } from "@/render/label-layers";

const layers = buildLabelLayers();
const byId = new Map(layers.map((layer) => [layer.id, layer as Record<string, unknown>]));

describe("label layers", () => {
  it("ships the three label layers", () => {
    expect([...byId.keys()]).toEqual(["labels", "street-refs", "street-names"]);
    for (const layer of layers) {
      expect(layer.type).toBe("symbol");
      const source = (layer as unknown as { source?: string }).source;
      expect(source).toBeTruthy();
    }
  });

  it("uses collision instead of stacking text", () => {
    for (const layer of layers) {
      const layout = byId.get(layer.id)!.layout as Record<string, unknown>;
      expect(layout["text-allow-overlap"]).toBe(false);
      expect(layout["symbol-sort-key"]).toBeTruthy();
      expect(layout["text-padding"]).toBeGreaterThan(0);
    }
  });

  it("declares sane zoom ranges, in priority order", () => {
    const geographic = byId.get("labels")!;
    const refs = byId.get("street-refs")!;
    const names = byId.get("street-names")!;
    const min = (layer: Record<string, unknown>) => layer.minzoom as number;
    // Geographic labels come first, then highway refs, then street names.
    expect(min(geographic)).toBeLessThan(min(refs));
    expect(min(refs)).toBeLessThan(min(names));
    for (const layer of layers) {
      const value = min(byId.get(layer.id)!);
      expect(value).toBeGreaterThanOrEqual(9);
      expect(value).toBeLessThanOrEqual(18);
    }
  });

  it("places street names along the road and refs on the highway", () => {
    const refs = byId.get("street-refs")!;
    const names = byId.get("street-names")!;
    expect((refs.layout as Record<string, unknown>)["symbol-placement"]).toBe("line");
    expect((names.layout as Record<string, unknown>)["symbol-placement"]).toBe("line");
    // Highway refs are filtered to motorway/trunk only.
    expect(JSON.stringify(refs.filter)).toContain("motorway");
  });

  it("uses a halo so text survives over roads and traffic", () => {
    for (const layer of layers) {
      const paint = byId.get(layer.id)!.paint as Record<string, unknown>;
      expect(paint["text-halo-color"]).toBeTruthy();
      expect(paint["text-halo-width"]).toBeGreaterThan(0.5);
    }
  });
});
