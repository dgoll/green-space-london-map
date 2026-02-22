import * as turf from '@turf/turf';
import { contours } from 'd3-contour';

const WALKING_SPEED_M_PER_MIN = 83.3; // ~5 km/h
const THRESHOLDS = [2, 5, 10, 15, 20, 30];
const COLORS = [
  '#ffffcc',  // 0-2 min  (not rendered, but kept for indexing)
  '#c7e9b4',  // 2-5 min
  '#7fcdbb',  // 5-10 min
  '#41b6c4',  // 10-15 min
  '#1d91c0',  // 15-20 min
  '#225ea8',  // 20-30 min
  '#0c2c84',  // 30+ min
];

export { THRESHOLDS, COLORS };

/**
 * Compute isochrone GeoJSON from greenspace features.
 * @param {Object} geojson — full greenspace FeatureCollection
 * @param {number} minArea — minimum area_sqm to include
 * @param {number[]} bbox — [west, south, east, north]
 * @param {number} gridWidth — number of columns
 * @param {number} gridHeight — number of rows
 * @returns {Object} GeoJSON FeatureCollection of contour polygons
 */
export function computeIsochrones(geojson, minArea, bbox, gridWidth, gridHeight) {
  const [west, south, east, north] = bbox;
  const cellW = (east - west) / gridWidth;
  const cellH = (north - south) / gridHeight;

  // Approximate cell size in metres at London's latitude
  const midLat = (south + north) / 2;
  const cellSizeM_x = cellW * 111320 * Math.cos(midLat * Math.PI / 180);
  const cellSizeM_y = cellH * 111320;
  const cellSizeM = (cellSizeM_x + cellSizeM_y) / 2;

  // Filter features by min area
  const filtered = geojson.features.filter(f => (f.properties.area_sqm || 0) >= minArea);

  // Build a flat index of polygon bboxes for fast rejection
  const polys = filtered.map(f => ({
    feature: f,
    bbox: turf.bbox(f),
  }));

  // Rasterize: mark grid cells inside greenspaces as 0, others as Infinity
  const size = gridWidth * gridHeight;
  const grid = new Float32Array(size);
  grid.fill(Infinity);

  for (let row = 0; row < gridHeight; row++) {
    const lat = north - (row + 0.5) * cellH; // top to bottom
    for (let col = 0; col < gridWidth; col++) {
      const lng = west + (col + 0.5) * cellW;
      const pt = turf.point([lng, lat]);

      for (const p of polys) {
        // Quick bbox check
        if (lng < p.bbox[0] || lng > p.bbox[2] || lat < p.bbox[1] || lat > p.bbox[3]) continue;
        if (turf.booleanPointInPolygon(pt, p.feature)) {
          grid[row * gridWidth + col] = 0;
          break;
        }
      }
    }
  }

  // Euclidean Distance Transform (Meijster's algorithm)
  edt2d(grid, gridWidth, gridHeight);

  // Convert distances to walking time in minutes
  const walkingGrid = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    walkingGrid[i] = grid[i] * cellSizeM / WALKING_SPEED_M_PER_MIN;
  }

  // Smooth the walking time grid with a Gaussian blur for smoother contours
  gaussianBlur(walkingGrid, gridWidth, gridHeight, 3);

  // Generate cumulative contours on the smooth continuous field
  const contourGenerator = contours()
    .size([gridWidth, gridHeight])
    .thresholds(THRESHOLDS);

  const cumulativeContours = contourGenerator(walkingGrid);

  // Convert cumulative contours to non-overlapping bands using difference
  // cumulativeContours[i] = area where walkingTime >= THRESHOLDS[i]
  // band i+1 = cumulativeContours[i] minus cumulativeContours[i+1]
  // last band = cumulativeContours[last] (nothing to subtract)
  const features = [];

  for (let i = 0; i < cumulativeContours.length; i++) {
    const outer = cumulativeContours[i];
    const inner = cumulativeContours[i + 1]; // undefined for last

    // Transform grid coords to lng/lat
    const outerCoords = outer.coordinates.map(ring =>
      ring.map(subring =>
        subring.map(([gx, gy]) => [west + gx * cellW, north - gy * cellH])
      )
    );

    let bandGeom;
    if (!inner || inner.coordinates.length === 0) {
      // Last band — no inner to subtract
      bandGeom = { type: outer.type, coordinates: outerCoords };
    } else {
      const innerCoords = inner.coordinates.map(ring =>
        ring.map(subring =>
          subring.map(([gx, gy]) => [west + gx * cellW, north - gy * cellH])
        )
      );
      const outerFeature = turf.feature({ type: outer.type, coordinates: outerCoords });
      const innerFeature = turf.feature({ type: inner.type, coordinates: innerCoords });
      const diff = turf.difference(turf.featureCollection([outerFeature, innerFeature]));
      if (!diff) continue;
      bandGeom = diff.geometry;
    }

    features.push({
      type: 'Feature',
      properties: { band: i + 1 }, // band 1..n (band 0 is < first threshold, skipped)
      geometry: bandGeom,
    });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * 2D Euclidean Distance Transform (Meijster et al. 2000).
 * Mutates `grid` in place: cells start as 0 (inside) or Infinity (outside),
 * end as Euclidean distance in grid cells.
 */
function edt2d(grid, width, height) {
  // Phase 1: column-wise 1D EDT
  const colBuf = new Float32Array(height);
  for (let col = 0; col < width; col++) {
    // Forward pass
    for (let row = 0; row < height; row++) {
      colBuf[row] = grid[row * width + col];
    }
    // 1D squared distance
    edt1d(colBuf, height);
    for (let row = 0; row < height; row++) {
      grid[row * width + col] = colBuf[row];
    }
  }

  // Phase 2: row-wise 1D EDT on squared distances
  const rowBuf = new Float32Array(width);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      rowBuf[col] = grid[row * width + col];
    }
    edt1d(rowBuf, width);
    for (let col = 0; col < width; col++) {
      grid[row * width + col] = Math.sqrt(rowBuf[col]);
    }
  }
}

/**
 * 1D squared Euclidean Distance Transform.
 * Input: f[i] = 0 for feature cells, Infinity for background.
 * Output: f[i] = squared distance to nearest feature cell.
 */
function edt1d(f, n) {
  // Convert input: 0 stays 0, Infinity stays large
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);

  // Parabola lower envelope
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q++) {
    const fq = f[q] === Infinity ? 1e20 : f[q];
    let s;
    while (true) {
      const fv = f[v[k]] === Infinity ? 1e20 : f[v[k]];
      s = ((fq + q * q) - (fv + v[k] * v[k])) / (2 * q - 2 * v[k]);
      if (s > z[k]) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const fv = f[v[k]] === Infinity ? 1e20 : f[v[k]];
    d[q] = (q - v[k]) * (q - v[k]) + fv;
  }

  for (let i = 0; i < n; i++) f[i] = d[i];
}

/**
 * Separable Gaussian blur (two-pass: horizontal then vertical).
 * Mutates `grid` in place. `radius` is the kernel half-size.
 */
function gaussianBlur(grid, width, height, radius) {
  // Build 1D Gaussian kernel
  const sigma = radius / 2;
  const kSize = radius * 2 + 1;
  const kernel = new Float32Array(kSize);
  let sum = 0;
  for (let i = 0; i < kSize; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= sum;

  const tmp = new Float32Array(width * height);

  // Horizontal pass
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let val = 0;
      for (let k = -radius; k <= radius; k++) {
        const c = Math.min(Math.max(col + k, 0), width - 1);
        val += grid[row * width + c] * kernel[k + radius];
      }
      tmp[row * width + col] = val;
    }
  }

  // Vertical pass
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let val = 0;
      for (let k = -radius; k <= radius; k++) {
        const r = Math.min(Math.max(row + k, 0), height - 1);
        val += tmp[r * width + col] * kernel[k + radius];
      }
      grid[row * width + col] = val;
    }
  }
}
