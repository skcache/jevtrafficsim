import { beforeEach, describe, expect, it } from "vitest";

import { useUiStore } from "@/store/ui-store";

/**
 * The camera is framed once per run, not once per READY.
 *
 * The regression these pin down: a prewarm READY (the metro-scale world built
 * while the setup screen is still open) can arrive after the press. It moved the
 * phase to "city" as well, so the READY for the run the user actually asked for
 * saw `entering === false` and no flight was issued — measured, the whole trip
 * then played at the landing zoom (14.1) instead of the street preset (15.4) any
 * time a setup control had been touched.
 */
describe("camera framing per run", () => {
  beforeEach(() => {
    useUiStore.getState().setPhase("landing");
  });

  it("starts unframed", () => {
    expect(useUiStore.getState().cameraFramedFor).toBeNull();
  });

  it("frames the first live world of a run", () => {
    const store = useUiStore.getState();
    store.setPhase("entering");
    expect(store.cameraFramedFor).not.toBe("fingerprint-a");
    store.markCameraFramed("fingerprint-a");
    expect(useUiStore.getState().cameraFramedFor).toBe("fingerprint-a");
  });

  it("does not re-frame a run in flight when another READY arrives for the same world", () => {
    const store = useUiStore.getState();
    store.setPhase("entering");
    store.markCameraFramed("fingerprint-a");
    // A later READY for the same world must leave the camera alone: the payoff
    // would otherwise be yanked back to the street preset mid-result.
    expect(useUiStore.getState().cameraFramedFor).toBe("fingerprint-a");
  });

  it("frames again for a different world", () => {
    const store = useUiStore.getState();
    store.setPhase("entering");
    store.markCameraFramed("fingerprint-a");
    expect(useUiStore.getState().cameraFramedFor).not.toBe("fingerprint-b");
  });

  it("puts the camera back in play when the run ends and the user returns to setup", () => {
    const store = useUiStore.getState();
    store.setPhase("entering");
    store.markCameraFramed("fingerprint-a");
    store.setPhase("config");
    expect(useUiStore.getState().cameraFramedFor).toBeNull();
  });

  it("puts the camera back in play when a run completes into the city view", () => {
    const store = useUiStore.getState();
    store.setPhase("entering");
    store.markCameraFramed("fingerprint-a");
    store.setPhase("city");
    expect(useUiStore.getState().cameraFramedFor).toBe("fingerprint-a");
    store.setPhase("landing");
    expect(useUiStore.getState().cameraFramedFor).toBeNull();
  });
});
