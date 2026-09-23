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
 * The frozen lake extract folds over itself at the river mouth. This local
 * presentation contour follows selected structural vertices of Lake Michigan
 * OSM relation 1205149 (shoreline ways 1443839132, 762092237 and 846602682),
 * including the actual Navy Pier and Jardine waterworks edges. The outer
 * east/south edge extends past the clipped city asset to avoid a visible tile
 * seam at trip-fit zoom. Routing and water-crossing semantics stay unchanged.
 */
export const LAKE_MICHIGAN_WATER = [
  [-87.6157, 41.8400],
  [-87.6157, 41.8610],
  [-87.6158, 41.8660],
  [-87.6162, 41.8689],
  [-87.6160, 41.8760],
  [-87.6164, 41.8821],
  [-87.6099982, 41.8840847],
  [-87.6099751, 41.8851906],
  [-87.6099498, 41.8870392],
  [-87.6096591, 41.8871798],
  [-87.6095114, 41.8880172],
  [-87.6095161, 41.8894608],
  [-87.6095651, 41.8910218],
  [-87.6008988, 41.8911515],
  [-87.6005808, 41.8911195],
  [-87.6005903, 41.8914224],
  [-87.5985431, 41.8914535],
  [-87.5985659, 41.8922780],
  [-87.6006049, 41.8922354],
  [-87.6006109, 41.8924149],
  [-87.6009292, 41.8923665],
  [-87.6048101, 41.8923057],
  [-87.6097504, 41.8922278],
  [-87.6098495, 41.8931498],
  [-87.6023767, 41.8932705],
  [-87.6023286, 41.8939530],
  [-87.6022582, 41.8940282],
  [-87.6023162, 41.8962884],
  [-87.6024479, 41.8964064],
  [-87.6050776, 41.8963647],
  [-87.6079491, 41.8962950],
  [-87.6102161, 41.8962584],
  [-87.6110322, 41.8950372],
  [-87.6117192, 41.8939109],
  [-87.6127248, 41.8936734],
  [-87.6138648, 41.8933344],
  [-87.6147216, 41.8944160],
  [-87.6157422, 41.8958974],
  [-87.6164730, 41.8970037],
  [-87.6172601, 41.8981273],
  [-87.6183097, 41.8997222],
  [-87.6191561, 41.9009910],
  [-87.5500, 41.9010],
  [-87.5500, 41.8400],
  [-87.6157, 41.8400],
] as const;

// North and west edge follow the Chicago Park District's Burnham Park boundary
// (FeatureServer/1, park = BURNHAM (DANIEL)). The southern taper follows the
// same boundary toward the lakeshore; extending below the frozen extract avoids
// a hard green rectangle at its 41.861° cut. The east edge stays on dry land.
export const MUSEUM_CAMPUS_PARK = [
  [-87.61574, 41.85720],
  [-87.61594, 41.85800],
  [-87.61737, 41.86015],
  [-87.61777, 41.86100],
  [-87.61838, 41.86273],
  [-87.61883, 41.86487],
  [-87.61650, 41.86498],
  [-87.61649, 41.86477],
  [-87.61580, 41.86477],
  [-87.61575, 41.86100],
  [-87.61574, 41.85720],
] as const;

// Northerly Island's continuous park silhouette, simplified from the outer
// ring of OSM multipolygon relation 2914325. The frozen clipped extract turns
// this into several triangular park scraps at the south edge of the Metro map.
export const NORTHERLY_ISLAND_PARK = [
  [-87.6087492, 41.8531589],
  [-87.6065266, 41.8533615],
  [-87.6070689, 41.8598648],
  [-87.6059545, 41.8600734],
  [-87.6060093, 41.8620300],
  [-87.6066345, 41.8621563],
  [-87.6069027, 41.8625108],
  [-87.6073045, 41.8642114],
  [-87.6070194, 41.8649936],
  [-87.6067788, 41.8651199],
  [-87.6063363, 41.8649973],
  [-87.6063086, 41.8647952],
  [-87.6060639, 41.8647997],
  [-87.6060722, 41.8656832],
  [-87.6057283, 41.8660141],
  [-87.6056325, 41.8664224],
  [-87.6058180, 41.8668405],
  [-87.6062291, 41.8671256],
  [-87.6070456, 41.8672194],
  [-87.6077631, 41.8668584],
  [-87.6127123, 41.8667513],
  [-87.6127078, 41.8664800],
  [-87.6073661, 41.8665217],
  [-87.6074175, 41.8661548],
  [-87.6127018, 41.8660796],
  [-87.6126991, 41.8658542],
  [-87.6105886, 41.8658767],
  [-87.6104835, 41.8653085],
  [-87.6102360, 41.8650594],
  [-87.6098024, 41.8641821],
  [-87.6097090, 41.8633154],
  [-87.6098862, 41.8623626],
  [-87.6100230, 41.8619334],
  [-87.6104164, 41.8613934],
  [-87.6103662, 41.8608493],
  [-87.6106975, 41.8606506],
  [-87.6106888, 41.8602132],
  [-87.6104762, 41.8601303],
  [-87.6103903, 41.8599144],
  [-87.6104847, 41.8592598],
  [-87.6099194, 41.8587028],
  [-87.6099730, 41.8577231],
  [-87.6093675, 41.8568753],
  [-87.6097200, 41.8551291],
  [-87.6099407, 41.8539711],
  [-87.6098771, 41.8536947],
  [-87.6093804, 41.8532729],
  [-87.6087492, 41.8531589],
] as const;
