import { afterEach, describe, expect, it, vi } from "vitest";
import { loadChicagoBundle } from "@/cities/chicago-assets";

afterEach(() => vi.unstubAllGlobals());

describe("Chicago asset recovery", () => {
  it("evicts a rejected bundle promise so a retry succeeds without reload", async () => {
    let failed = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/metadata.json") && !failed) {
        failed = true;
        return new Response("unavailable", { status: 503 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const scaleIndex = 12345; // isolated cache key; falls back to the documented scale
    await expect(loadChicagoBundle(scaleIndex)).rejects.toThrow(/503/);
    await expect(loadChicagoBundle(scaleIndex)).resolves.toMatchObject({ metadata: {}, asset: {} });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/metadata.json"))).toHaveLength(2);
  });
});
