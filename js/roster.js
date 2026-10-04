// Stations and the units Command can assign. A unit's number is its station, and its station
// is its fire district, so "M5" is home in District 5.
//
// type: "aerial" (Truck / Ladder / Quint), "engine", "medic"
//
// Source: DFD station story map (storymaps.arcgis.com/stories/0f943576b8c1481abe618fd58e3d9b39),
// read 2026-10-04. Only the assignable types are listed; Rescue, Brush, Squad, ARFF, HazMat and
// other special units are left out on purpose.

export const STATIONS = [
  { station: 1, units: [["E1", "engine"], ["T1", "aerial"], ["M1", "medic"]] },
  { station: 2, units: [["E2", "engine"], ["M2", "medic"]] },
  { station: 3, units: [["E3", "engine"], ["L3", "aerial"], ["M3", "medic"]] },
  { station: 4, units: [["E4", "engine"], ["M4", "medic"]] },
  { station: 5, units: [["E5", "engine"], ["M5", "medic"]] },
  { station: 6, units: [["E6", "engine"], ["M6", "medic"]] },
  { station: 7, units: [["E7", "engine"], ["M7", "medic"]] },
  { station: 8, units: [["E8", "engine"], ["M8", "medic"]] },
  { station: 9, units: [["E9", "engine"]] },
];

export const UNITS = new Map(
  STATIONS.flatMap(s => s.units.map(([id, type]) => [id, { id, type, station: s.station }]))
);

export const TYPE_LABEL = { aerial: "Aerial", engine: "Engine", medic: "Medic" };
