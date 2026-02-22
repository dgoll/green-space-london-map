import maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';
import { computeIsochrones, THRESHOLDS, COLORS } from './isochrones.js';

const GRID_WIDTH = 1000;
const GRID_HEIGHT = 800;

let map;
let greenspaceData = null;
let londonBbox = null;

async function init() {
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [-0.09, 51.505],
    zoom: 11,
  });

  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');

  map.on('load', async () => {
    await loadData();
    setupSlider();
    setupGreenspaceToggle();
    buildLegend();
    updateIsochrones();
  });
}

async function loadData() {
  const res = await fetch('/data/london_greenspaces.geojson');
  greenspaceData = await res.json();
  londonBbox = turf.bbox(greenspaceData);

  // Add greenspace polygon layer
  map.addSource('greenspaces', {
    type: 'geojson',
    data: greenspaceData,
  });

  map.addLayer({
    id: 'greenspaces-fill',
    type: 'fill',
    source: 'greenspaces',
    paint: {
      'fill-color': '#2d8c2d',
      'fill-opacity': 0.4,
    },
  });

  // Add isochrone source (empty initially)
  map.addSource('isochrones', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  // One layer per band — bands are non-overlapping so no stacking
  // Skip band 0 (< 2 min) to leave it transparent
  const numBands = THRESHOLDS.length + 1;
  for (let band = 1; band < numBands; band++) {
    map.addLayer(
      {
        id: `isochrone-band-${band}`,
        type: 'fill',
        source: 'isochrones',
        filter: ['==', ['get', 'band'], band],
        paint: {
          'fill-color': COLORS[band],
          'fill-opacity': 0.55,
        },
      },
      'greenspaces-fill'
    );
  }
}

function updateIsochrones() {
  if (!greenspaceData || !londonBbox) return;

  const loading = document.getElementById('loading');
  loading.style.display = 'block';

  // Use requestAnimationFrame to let the loading indicator render
  requestAnimationFrame(() => {
    const slider = document.getElementById('size-slider');
    const minArea = Number(slider.value);

    const t0 = performance.now();
    const isochroneGeoJSON = computeIsochrones(
      greenspaceData,
      minArea,
      londonBbox,
      GRID_WIDTH,
      GRID_HEIGHT
    );
    const t1 = performance.now();
    console.log(`Isochrone computation: ${(t1 - t0).toFixed(0)}ms`);

    map.getSource('isochrones').setData(isochroneGeoJSON);
    loading.style.display = 'none';
  });
}

function setupSlider() {
  const slider = document.getElementById('size-slider');
  const valueDisplay = document.getElementById('slider-value');

  function formatValue(v) {
    const num = Number(v);
    if (num === 0) return 'All greenspaces';
    if (num < 10000) return `${(num / 10000).toFixed(1)} ha`;
    return `${(num / 10000).toFixed(0)} ha`;
  }

  slider.addEventListener('input', () => {
    valueDisplay.textContent = formatValue(slider.value);
  });

  slider.addEventListener('change', () => {
    updateIsochrones();
  });

  // Clicking on preset labels
  document.querySelectorAll('#slider-labels span').forEach(span => {
    span.addEventListener('click', () => {
      slider.value = span.dataset.value;
      valueDisplay.textContent = formatValue(slider.value);
      updateIsochrones();
    });
  });
}

function setupGreenspaceToggle() {
  const checkbox = document.getElementById('show-greenspaces');
  checkbox.addEventListener('change', () => {
    map.setLayoutProperty(
      'greenspaces-fill',
      'visibility',
      checkbox.checked ? 'visible' : 'none'
    );
  });
}

function buildLegend() {
  const container = document.getElementById('legend-items');
  const labels = ['2-5 min', '5-10 min', '10-15 min', '15-20 min', '20-30 min', '30+ min'];

  labels.forEach((label, i) => {
    const item = document.createElement('div');
    item.className = 'legend-item';

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = COLORS[i + 1];

    const text = document.createElement('span');
    text.textContent = label;

    item.appendChild(swatch);
    item.appendChild(text);
    container.appendChild(item);
  });
}

init();
