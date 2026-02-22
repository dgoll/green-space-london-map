#!/usr/bin/env -S uv run --script
#
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "fiona>=1.10.1",
#     "geopandas>=1.1.2",
#     "pyproj>=3.7.2",
#     "requests>=2.32.5",
# ]
# ///

"""
Download and process OS Open Greenspace data for London.

Outputs: public/data/london_greenspaces.geojson

Dependencies: geopandas, fiona, pyproj, requests
"""

import os
import sys
import zipfile
import tempfile
import requests
import geopandas as gpd

# URLs
GREENSPACE_URL = (
    "https://api.os.uk/downloads/v1/products/OpenGreenspace/downloads"
    "?area=GB&format=GeoPackage&redirect"
)
LONDON_BOUNDARY_URL = (
    "https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/"
    "Regions_December_2024_Boundaries_EN_BGC/FeatureServer/0/query"
    "?where=RGN24CD%3D%27E12000007%27&outFields=*&outSR=4326&f=geojson"
)

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')
OUTPUT_FILE = os.path.join(OUTPUT_DIR, 'london_greenspaces.geojson')


def download_file(url, dest, description="file"):
    """Download a file with progress indication."""
    print(f"Downloading {description}...")
    resp = requests.get(url, stream=True, timeout=300)
    resp.raise_for_status()
    total = int(resp.headers.get('content-length', 0))
    downloaded = 0
    with open(dest, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)
            downloaded += len(chunk)
            if total:
                pct = downloaded / total * 100
                print(f"\r  {downloaded / 1e6:.1f} / {total / 1e6:.1f} MB ({pct:.0f}%)", end='', flush=True)
            else:
                print(f"\r  {downloaded / 1e6:.1f} MB", end='', flush=True)
    print()
    return dest


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        # 1. Download London boundary
        london_file = os.path.join(tmpdir, 'london.geojson')
        download_file(LONDON_BOUNDARY_URL, london_file, "London boundary")
        london = gpd.read_file(london_file)
        # Reproject to BNG for clipping
        london_bng = london.to_crs(epsg=27700)
        london_geom = london_bng.union_all()
        print(f"  London boundary loaded")

        # 2. Download OS Open Greenspace
        gs_zip = os.path.join(tmpdir, 'greenspace.zip')
        download_file(GREENSPACE_URL, gs_zip, "OS Open Greenspace")

        # Extract zip
        print("Extracting archive...")
        with zipfile.ZipFile(gs_zip, 'r') as z:
            z.extractall(tmpdir)

        # Find the GeoPackage file
        gpkg_files = []
        for root, dirs, files in os.walk(tmpdir):
            for f in files:
                if f.endswith('.gpkg'):
                    gpkg_files.append(os.path.join(root, f))
        if not gpkg_files:
            print("ERROR: No .gpkg file found in download")
            sys.exit(1)

        gpkg_path = gpkg_files[0]
        print(f"  Found GeoPackage: {os.path.basename(gpkg_path)}")

        # List layers to find the sites layer (not access points)
        import fiona
        layers = fiona.listlayers(gpkg_path)
        print(f"  Layers: {layers}")
        sites_layer = None
        for layer in layers:
            if 'site' in layer.lower():
                sites_layer = layer
                break
        if sites_layer is None:
            # Fallback: use first layer
            sites_layer = layers[0]
        print(f"  Using layer: {sites_layer}")

        # 3. Load greenspace sites
        print("Loading greenspace sites...")
        gs = gpd.read_file(gpkg_path, layer=sites_layer)
        print(f"  Loaded {len(gs)} features")

        # Ensure CRS is BNG
        if gs.crs is None or gs.crs.to_epsg() != 27700:
            print(f"  Reprojecting from {gs.crs} to EPSG:27700")
            gs = gs.to_crs(epsg=27700)

        # 4. Clip to Greater London
        print("Clipping to London...")
        gs = gs[gs.geometry.intersects(london_geom)].copy()
        gs['geometry'] = gs.geometry.intersection(london_geom)
        print(f"  {len(gs)} features within London")

        # 5. Compute area in m² and filter out greenspaces below 1 ha
        gs['area_sqm'] = gs.geometry.area
        before = len(gs)
        gs = gs[gs['area_sqm'] >= 10000].copy()
        print(f"  Filtered to {len(gs)} features >= 1 ha (removed {before - len(gs)})")

        # 6. Reproject to WGS84
        print("Reprojecting to WGS84...")
        gs = gs.to_crs(epsg=4326)

        # 7. Keep only needed attributes
        # Find column names (they vary between versions)
        cols = gs.columns.tolist()
        keep = {}
        for col in cols:
            col_lower = col.lower()
            if col_lower == 'id' or col_lower == 'fid':
                keep['id'] = col
            elif 'function' in col_lower:
                keep['function'] = col
            elif 'distinctive' in col_lower or 'name' in col_lower:
                keep['distinctiveName1'] = col

        rename_map = {v: k for k, v in keep.items()}
        keep_cols = list(keep.values()) + ['area_sqm', 'geometry']
        # Only keep columns that exist
        keep_cols = [c for c in keep_cols if c in gs.columns]
        gs = gs[keep_cols].rename(columns=rename_map)

        print(f"  Columns: {gs.columns.tolist()}")
        print(f"  Area range: {gs['area_sqm'].min():.0f} - {gs['area_sqm'].max():.0f} m²")

        # 8. Export as GeoJSON
        print(f"Writing {OUTPUT_FILE}...")
        gs.to_file(OUTPUT_FILE, driver='GeoJSON')
        size_mb = os.path.getsize(OUTPUT_FILE) / 1e6
        print(f"  Done! {len(gs)} features, {size_mb:.1f} MB")


if __name__ == '__main__':
    main()
