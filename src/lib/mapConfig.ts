/**
 * mapConfig.ts
 *
 * Shared MapLibre constants. Moved out of MapView.tsx (2026-08-08, plan-map
 * work) so PlanMap.tsx doesn't have to duplicate them: before this, the
 * OpenFreeMap style URL and the Akron center point existed only inside
 * MapView.tsx, and a second inline copy in PlanMap.tsx would have meant two
 * places to update -- and one of them getting missed -- the next time
 * OpenFreeMap changes a style path. One import each in MapView.tsx and
 * PlanMap.tsx now.
 *
 * Tiles: OpenFreeMap public instance (free, unlimited, no API key —
 * https://openfreemap.org). Attribution is added automatically by MapLibre.
 */

export const AKRON_CENTER = { longitude: -81.519, latitude: 41.081 }
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark'
export const DEFAULT_ZOOM = 13
