// Fire district lookup. Districts are the City of Denton "2024_Fire_Districts" layer, bundled in
// data/fire-districts.geojson. District number = home station number.

let districts = null;

export async function loadDistricts() {
  if (!districts) {
    const res = await fetch("data/fire-districts.geojson");
    districts = await res.json();
  }
  return districts;
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[j];
    if ((y1 > lat) !== (y2 > lat) && lng < ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function inPolygon(lng, lat, rings) {
  if (!inRing(lng, lat, rings[0])) return false;
  return !rings.slice(1).some(hole => inRing(lng, lat, hole));
}

// Returns the district id as a string ("1".."9"), or null when outside every DFD district.
export function fireDistrictAt(lat, lng) {
  if (!districts || lat == null || lng == null) return null;
  for (const f of districts.features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    if (polys.some(p => inPolygon(lng, lat, p))) return String(f.properties.districtid);
  }
  return null;
}
