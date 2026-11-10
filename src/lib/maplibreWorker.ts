/**
 * maplibreWorker.ts
 *
 * Tells MapLibre where its tile worker lives. Import this module for its side
 * effect from every component that mounts a map.
 *
 * MapLibre 6 ships as ES modules with the worker in its own file
 * (dist/maplibre-gl-worker.mjs) and no longer inlines it as a blob the way 5.x
 * did. Without an explicit URL the map constructs, the canvas, markers and
 * controls all appear, and then every tile and GeoJSON layer silently fails
 * with "Worker failed to load" - a basemap-less map that still looks alive.
 * Vite's `?url` import emits the worker as a hashed same-origin asset and
 * hands back its final path, so this keeps working across builds.
 *
 * Upgraded 5.24 -> 6.x on 2026-11-10 for GHSA-jrc7-96c5-q579 (attribution
 * sanitizer bypass, fixed in 6.4.1; no 5.x backport exists).
 */
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'

setWorkerUrl(workerUrl)
