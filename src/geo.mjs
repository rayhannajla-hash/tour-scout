// Turns Qloo heatmap points into named cities and orders cities into a drivable route.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(path.join(here, "..", "data", "cities.json"), "utf8"));
export const CITY_SOURCE = raw.source;
const CITIES = raw.rows.map(([name, region, country, lat, lon, population]) => ({
  name, region, country, lat, lon, population,
}));

const EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

// Cities within `km` of a point, with their distance. The latitude check skips most of
// the list cheaply.
function citiesWithin(point, km) {
  const out = [];
  const dLat = km / 111;
  for (const c of CITIES) {
    if (Math.abs(c.lat - point.lat) > dLat) continue;
    const d = distanceKm(point, c);
    if (d <= km) out.push({ c, d });
  }
  return out;
}

export function findCity(name) {
  const q = name.trim().toLowerCase();
  const [cityPart, ...rest] = q.split(",").map((s) => s.trim());
  const hint = rest.join(" ");
  const matches = CITIES.filter((c) => c.name.toLowerCase() === cityPart);
  if (matches.length === 0) return null;
  const hinted = hint
    ? matches.find((c) => c.region.toLowerCase().includes(hint) || c.country.toLowerCase() === hint)
    : null;
  return hinted ?? matches[0]; // CITIES is sorted by population, so [0] is the biggest namesake
}

export const cityLabel = (c) => [c.name, c.region || c.country].filter(Boolean).join(", ");

// Heatmap cells -> one row per city with the mean affinity of the cells around it.
// A full heatmap has thousands of cells and single-cell maxima saturate near 1.0, so
// the mean over the metro is what separates cities; cells far from any city and metros
// with too few cells to average are dropped. Cells sit in suburbs, so each one goes to
// the biggest city within 40 km (Glendale -> Phoenix); a sparse heatmap falls back to
// the nearest city within 75 km.
export function citiesFromHeatmap(points) {
  const dense = points.length > 200;
  const minCells = dense ? 3 : 1;
  const cells = [];
  for (const p of points) {
    const lat = p?.location?.latitude ?? p?.latitude;
    const lon = p?.location?.longitude ?? p?.longitude;
    const affinity = p?.query?.affinity;
    if (typeof lat !== "number" || typeof lon !== "number" || typeof affinity !== "number") continue;
    cells.push({ affinity, near: citiesWithin({ lat, lon }, dense ? 40 : 75) });
  }

  // A region's heatmap almost always lies in one country. Keep every cell on that
  // country's side, or a San Diego cell is filed under Tijuana, which is bigger.
  const closest = (near) => near.reduce((a, b) => (!a || b.d < a.d ? b : a), null);
  const tally = new Map();
  for (const cell of cells) {
    const c = closest(cell.near)?.c;
    if (c) tally.set(c.country, (tally.get(c.country) ?? 0) + 1);
  }
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  const [lead, leadCount] = [...tally].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const country = total && leadCount / total >= 0.9 ? lead : null;

  const byCity = new Map();
  for (const cell of cells) {
    const near = country ? cell.near.filter((x) => x.c.country === country) : cell.near;
    const metro = near.filter((x) => x.d <= 40);
    const pick = metro.length ? metro.reduce((a, b) => (b.c.population > a.c.population ? b : a)) : closest(near);
    if (!pick) continue;
    const city = pick.c;
    const key = `${city.name}|${city.region}|${city.country}`;
    const row = byCity.get(key) ?? {
      city: cityLabel(city), country: city.country, lat: city.lat, lon: city.lon,
      population: city.population, sum: 0, points: 0,
    };
    row.points += 1;
    row.sum += cell.affinity;
    byCity.set(key, row);
  }
  return [...byCity.values()]
    .filter((r) => r.points >= minCells)
    .map(({ sum, ...r }) => ({ ...r, affinity: sum / r.points }))
    .sort((a, b) => b.affinity - a.affinity);
}

const legKm = (route) => route.slice(1).reduce((sum, c, i) => sum + distanceKm(route[i], c), 0);

// Nearest-neighbour seed, then 2-opt. Without a pinned start every city is tried as the
// start and the shortest path wins. Small n (<= 12 stops), so brute force is fine.
export function orderRoute(stops, { start = null, end = null } = {}) {
  if (stops.length <= 2) return stops.slice();
  if (!start) {
    const tries = stops.filter((c) => c !== end).map((c) => orderRoute(stops, { start: c, end }));
    return tries.reduce((best, r) => (legKm(r) < legKm(best) ? r : best));
  }
  const pool = stops.filter((c) => c !== start && c !== end);
  const route = [start];
  let current = start;
  while (pool.length) {
    let bestIdx = 0;
    for (let i = 1; i < pool.length; i++) {
      if (distanceKm(current, pool[i]) < distanceKm(current, pool[bestIdx])) bestIdx = i;
    }
    current = pool.splice(bestIdx, 1)[0];
    route.push(current);
  }
  if (end) route.push(end);

  const lo = 1;
  const hi = end ? route.length - 2 : route.length - 1;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = lo; i < hi; i++) {
      for (let k = i + 1; k <= hi; k++) {
        const candidate = [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
        if (legKm(candidate) + 1e-6 < legKm(route)) {
          route.splice(0, route.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return route;
}

export function routeLegs(route) {
  return route.slice(1).map((c, i) => {
    const km = Math.round(distanceKm(route[i], c));
    return { from: route[i].city, to: c.city, km, drive_hours: Math.round((km / 80) * 10) / 10 };
  });
}
