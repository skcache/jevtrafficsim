/**
 * Small presentation repairs for the clipped OSM shoreline extract.
 *
 * The metro extract triangulates the lake across Navy Pier and drops most of
 * Museum Campus's continuous greenspace. These rings only affect the basemap:
 * routing, water-crossing detection and simulation continue using the compiled
 * model. Coordinates are local WGS84 positions, not screen-space decoration.
 */
// The east end and deck follow the Navy Pier footprint (OSM way 24800238,
// simplified to its structural corners). The short west connector joins the
// footprint to the clipped Streeterville shore in this presentation extract.
export const NAVY_PIER_LAND = [
  [-87.6130, 41.89145],
  [-87.60975, 41.89145],
  [-87.6097114, 41.8910177],
  [-87.6068946, 41.8910640],
  [-87.6044081, 41.8911035],
  [-87.6024238, 41.8911351],
  [-87.6008988, 41.8911515],
  [-87.6005808, 41.8911195],
  [-87.6005903, 41.8914224],
  [-87.5985431, 41.8914535],
  [-87.5985659, 41.8922780],
  [-87.6004561, 41.8922378],
  [-87.6006109, 41.8924149],
  [-87.6009292, 41.8923665],
  [-87.6048101, 41.8923057],
  [-87.6072839, 41.8922668],
  [-87.6097504, 41.8922278],
  [-87.6130, 41.89234],
  [-87.6130, 41.89145],
] as const;

/**
 * The downloaded lake polygon folds over itself at the river mouth and Navy
 * Pier. Its fill produces vast triangular holes at neighborhood zoom. Use a
 * single coastline ring for presentation; the original model still owns
 * routing and water-crossing semantics.
 */
export const LAKE_MICHIGAN_WATER = [
  // Carry the lake beyond the clipped asset so a fitted trip never reveals a
  // straight east/south edge of the source extract. No sim geometry uses this.
  [-87.6157, 41.8400],
  [-87.6157, 41.8610],
  [-87.6158, 41.8660],
  [-87.6162, 41.8689],
  [-87.6160, 41.8760],
  [-87.6164, 41.8821],
  [-87.6103, 41.8872],
  [-87.6102, 41.8894],
  [-87.6129, 41.8908],
  [-87.6129, 41.8924],
  [-87.6110, 41.8935],
  [-87.6102, 41.8962],
  [-87.6120, 41.9010],
  [-87.5500, 41.9010],
  [-87.5500, 41.8400],
  [-87.6157, 41.8400],
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
