/**
 * Small presentation repairs for the clipped OSM shoreline extract.
 *
 * The metro extract triangulates the lake across Navy Pier and drops most of
 * Museum Campus's continuous greenspace. These rings only affect the basemap:
 * routing, water-crossing detection and simulation continue using the compiled
 * model. Coordinates are local WGS84 positions, not screen-space decoration.
 */
export const NAVY_PIER_LAND = [
  [-87.6130, 41.89145],
  [-87.5987, 41.89145],
  [-87.5984, 41.89114],
  [-87.5984, 41.89214],
  [-87.5987, 41.89234],
  [-87.6130, 41.89234],
  [-87.6130, 41.89145],
] as const;

/** Lake water immediately south of the built pier, missing from the extract. */
export const NAVY_PIER_SOUTH_WATER = [
  [-87.6112, 41.88855],
  [-87.5960, 41.88855],
  [-87.5960, 41.89145],
  [-87.6130, 41.89145],
  [-87.6121, 41.88985],
  [-87.6112, 41.88855],
] as const;

// North and west edge follow the Chicago Park District's Burnham Park boundary
// (FeatureServer/1, park = BURNHAM (DANIEL)); the south edge is clipped to the
// metro extract's 41.861° extent.
export const MUSEUM_CAMPUS_PARK = [
  [-87.61777, 41.86100],
  [-87.61838, 41.86273],
  [-87.61883, 41.86487],
  [-87.61650, 41.86498],
  [-87.61649, 41.86477],
  [-87.61543, 41.86478],
  [-87.61542, 41.86493],
  [-87.61405, 41.86499],
  [-87.61400, 41.86100],
  [-87.61777, 41.86100],
] as const;
