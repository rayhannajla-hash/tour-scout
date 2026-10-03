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

// Heatmap cells often sit in suburbs, so snap to the biggest city within metro range
// (Glendale -> Phoenix), falling back to the nearest city further out.
export function nearestCity(point, metroKm = 40, maxKm = 75) {
  let metro = null;
  let nearest = null;
  for (const c of CITIES) {
    const d = distanceKm(point, c);
    if (d > maxKm) continue;
    if (d <= metroKm && (!metro || c.population > metro.population)) metro = { ...c, distance_km: Math.round(d) };
    if (!nearest || d < nearest.distance_km) nearest = { ...c, distance_km: Math.round(d) };
  }
  return metro ?? nearest;
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

// Heatmap points -> one row per city, keeping the strongest affinity seen in that city.
export function citiesFromHeatmap(points) {
  const byCity = new Map();
  for (const p of points) {
    const lat = p?.location?.latitude ?? p?.latitude;
    const lon = p?.location?.longitude ?? p?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    const city = nearestCity({ lat, lon });
    if (!city) continue;
    const key = `${city.name}|${city.region}|${city.country}`;
    const affinity = p?.query?.affinity ?? null;
    const popularity = p?.query?.popularity ?? null;
    const row = byCity.get(key) ?? {
      city: cityLabel(city), country: city.country, lat: city.lat, lon: city.lon,
      population: city.population, affinity: null, popularity: null, points: 0,
    };
    row.points += 1;
    if (affinity !== null && (row.affinity === null || affinity > row.affinity)) row.affinity = affinity;
    if (popularity !== null && (row.popularity === null || popularity > row.popularity)) row.popularity = popularity;
    byCity.set(key, row);
  }
  return [...byCity.values()].sort((a, b) => (b.affinity ?? 0) - (a.affinity ?? 0));
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
