# Jev Traffic Sim

An interactive Chicago traffic simulator that runs **one experiment**:

> Same scenario. Same trip. Same driver. **Different city intelligence.**

You watch a single car cross real Chicago geography while the whole city simulates around
it, and the same scenario is also played out by two deterministic baselines. The payoff is
the comparison, not a scoreboard.

**Live:** deploy URL is published with the release notes.

## The experiment

| Column | What it is |
| --- | --- |
| **Fixed** | Signals on a fixed rotation. No sensing, no adaptation. The do-nothing baseline. |
| **Adaptive** | Signals that react to local queue pressure and waits, with the same min/max green, yellow, all-red and starvation protection as everything else. |
| **Jev** | A citywide policy from an external evaluation model (TypeSafe AI's `jev` through the Vercel AI Gateway). It sees ONLY citywide traffic state and answers bounded, typed questions; its answer becomes corridor/region weights and a small pressure modifier. |

The visible run is **Jev**. Fixed and Adaptive play the *same* scenario headlessly, in a
worker of their own, so the trip you are watching never stalls.

**Nothing about the driver changes the scenario.** Tourist and Local are two ways of driving
the same trip in the same city: the tourist follows the shortest route and sits through
queues; the local knows the network and reroutes around trouble. Pick a driver, then compare
controllers under that driver.

## Same-scenario fairness

A comparison is only shown when it is honest:

- all three runs share one **scenario fingerprint** — the scenario (trip, traffic level,
  driver, seed, horizon) is hashed into a short id, and results with different ids are never
  put side by side;
- all three runs are built from one **demand spawn list** and one **incident script**, so the
  weather in the city is byte-identical and only the signals differ;
- a run a human touched — a manual incident, a mid-run traffic change, a mid-run controller
  switch — is marked non-comparable and shown as such instead of being silently compared.

No winner score is computed. Every number in the panel is a field of a real run.

## What Jev may and may not do

- **No ego privilege.** The request never contains the ego vehicle id, its route, its
  destination, or anything else that could make one car special. Three independent tests
  prove that (schema scan, observation-frame scan, source scan).
- **No lamps.** Jev never sets a signal state. It answers with a small bounded policy —
  corridor/region weights (0.5–2), a pressure scale (0.5–1.5), a coarse hint — and the
  existing controller layer translates that into legal local decisions. Phase order, min/max
  green, yellow, all-red and starvation protection stay in `sim/signals.ts` and are enforced
  whatever the model says.
- **Bound and validated.** The policy is parsed against hard limits; anything malformed or
  out of range is rejected (or clamped and reported) and the previous policy stays.
- **No fabricated answers.** If Jev is unconfigured, slow, unavailable, malformed or expired,
  the run continues on the Adaptive fallback and says so. A run that spent real time on the
  fallback is labelled `Jev · fallback used`; a run that never had a live answer is labelled
  `Adaptive fallback`.

## Deterministic replay

Every accepted policy is recorded with the simulated time it was accepted at. A trace can be
replayed offline — **zero network calls** — and reproduces the same policy sequence and the
same result for the same scenario:

```bash
pnpm benchmark --controllers jev --jev replay --trace path/to/trace.json
```

A trace whose scenario fingerprint does not match is refused before anything runs. A trace
carrying a policy that live code could not have accepted is refused too: replay may reproduce
an accepted policy, never invent one.

## Architecture

```
browser
 ├─ components/…            React shell: map, chrome, trip HUD, comparison panel
 ├─ worker/simulation.worker.ts   ALL simulation state: city, demand, engine, frames
 ├─ worker/baselines.worker.ts    Fixed + Adaptive for the same scenario (off-thread)
 └─ POST /api/jev/policy          the ONLY place the service credential exists
        └─ jev/gateway.ts → Vercel AI Gateway (typesafe-ai/jev)
```

- Simulation: framework-independent TypeScript in `sim/` (engine, traffic physics, signals,
  demand, incidents, metrics) and `controllers/` (Fixed, Adaptive, Jev).
- Rendering: MapLibre + deck.gl over frozen Chicago geography; the simulation never touches
  the DOM.
- The worker owns every piece of simulation state. The main thread sends commands and draws
  frames; the UI store holds UI state only.
- The credential is server-side only and travels in an `Authorization` header. It never
  appears in the client bundle, the worker payload, browser state or logs — the browser only
  ever talks to its own origin's relay.

## Running it locally

```bash
pnpm install
cp .env.example .env.local      # then fill in JEV_TOKEN (see below)
pnpm dev                        # http://localhost:3000
```

With no Jev configuration the app runs entirely on the Adaptive fallback and labels it that
way — a complete demo with no credentials at all.

To point it at live Jev, set in `.env.local` (never committed):

```
JEV_MODEL=typesafe-ai/jev
JEV_TOKEN=<your Vercel AI Gateway key>
# optional
JEV_MIN_CONFIDENCE=0.25
JEV_TIMEOUT_MS=12000   # the free evaluation tier is variable; a tight
                       # timeout turns slow answers into fallback time
```

`JEV_ENDPOINT` is the alternative backend: a service that speaks the Jev policy schema
directly. The two are never mixed — `JEV_MODEL` selects the gateway.

## Developer flags

`?debug` (or `?debug=1`) reveals the controls the public flow deliberately hides: the
controller picker, the raw seed, and the city scale. Previews on the landing and setup
screens always run the Adaptive controller, so an idle visit never spends live model calls.

## Benchmarks

The same engine, controllers and scenario builders run headlessly, without a browser:

```bash
pnpm benchmark                                     # the default matrix
pnpm benchmark --trip soldier-field-to-navy-pier   # one trip
pnpm benchmark --traffic rush-hour --seed 42       # narrower slices
pnpm benchmark --out results.json                  # write the run document
```

The default matrix is 6 curated trips × 2 traffic levels × 2 seeds × 2 drivers × 2 controllers
(96 runs at a 600 s horizon), aggregated only across compatible groups. JSON output stays
local and gitignored. Fixed and Adaptive are deterministic; Jev needs an adapter, which the
CLI supplies (`--jev mock` for a deterministic stand-in, `--jev gateway` or `--jev replay`
for real and recorded policies).

## Commands

```bash
pnpm dev          # dev server
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm build        # production build
pnpm benchmark    # headless benchmark harness
```

The detailed product requirements live in `docs/` and are intentionally local-only.
