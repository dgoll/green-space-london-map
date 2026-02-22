# London Greenspace Walking Time Map

Interactive map showing how far Londoners are from greenspace, visualised as isochrone bands (areas of equal walking time to the nearest greenspace).

A slider lets you set a minimum greenspace size, so small pocket parks can be excluded to see access to larger green areas.

## How it works

1. **Data prep** — a Python script downloads [OS Open Greenspace](https://www.ordnancesurvey.co.uk/products/os-open-greenspace) (free, no API key) and clips it to the Greater London boundary
2. **Isochrone computation** — a Euclidean Distance Transform on a 1000x800 grid calculates walking distance from every point to the nearest greenspace, then Gaussian-smoothed contours are generated as non-overlapping bands
3. **Rendering** — MapLibre GL JS displays the bands on an OpenFreeMap basemap with a YlGnBu colour ramp

## Setup

### Prerequisites

- Node.js
- [uv](https://docs.astral.sh/uv/) (for the Python data prep script)
- GDAL (`brew install gdal` on macOS)

### Data preparation

```sh
uv run --script scripts/prepare_data.py
```

This downloads ~57 MB of OS Open Greenspace data, clips to London, and outputs `public/data/london_greenspaces.geojson`.

### Run the app

```sh
npm install
npm run dev
```

## Tech stack

- **Vite** — dev server and bundler
- **MapLibre GL JS** — WebGL map rendering
- **Turf.js** — geospatial utilities
- **d3-contour** — contour generation from distance grid
- **OpenFreeMap** — free vector tile basemap

## Data sources

- [OS Open Greenspace](https://www.ordnancesurvey.co.uk/products/os-open-greenspace) — Ordnance Survey (Open Government Licence)
- [ONS Open Geography Portal](https://geoportal.statistics.gov.uk/) — Greater London boundary
