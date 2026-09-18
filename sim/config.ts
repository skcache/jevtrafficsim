/**
 * Global simulation constants.
 *
 * Only values already fixed by the PRD and required by the current core
 * (world-update timing contract) live here. Tunable generation and
 * behaviour constants arrive with the tasks that use them — no speculative
 * configuration surface.
 */

/** Fixed world-update timestep in milliseconds (PRD §10: 10 Hz). */
export const SIMULATION_TIMESTEP_MS = 100;

/** Logical update rate derived from the timestep (PRD §10: 10 Hz). */
export const SIMULATION_TICKS_PER_SECOND = 1000 / SIMULATION_TIMESTEP_MS;
