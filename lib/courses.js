// lib/courses.js — course coordinates for weather. A hardcoded table covers the regular PGA
// Tour rotation (matched by a keyword in ESPN's course name); anything else falls back to
// Open-Meteo's free geocoder on the course's city/state, flagged `approx: true` so the Weather
// tab can say the point is the town, not the property. Coordinates are clubhouse-level.

const { fetchJson, TTL } = require('./http');

// [keyword in normalized course name, lat, lon, label]
const COURSES = [
  ['waialae', 21.271, -157.776, 'Waialae CC'],
  ['kapalua', 21.006, -156.648, 'Kapalua Plantation'],
  ['pga west', 33.663, -116.270, 'PGA West'],
  ['la quinta', 33.672, -116.297, 'La Quinta CC'],
  ['torrey pines', 32.900, -117.252, 'Torrey Pines'],
  ['pebble beach', 36.568, -121.950, 'Pebble Beach Golf Links'],
  ['spyglass', 36.585, -121.952, 'Spyglass Hill'],
  ['tpc scottsdale', 33.640, -111.910, 'TPC Scottsdale'],
  ['riviera', 34.049, -118.501, 'Riviera CC'],
  ['vidanta', 20.703, -105.290, 'Vidanta Vallarta'],
  ['pga national', 26.837, -80.137, 'PGA National'],
  ['bay hill', 28.461, -81.509, 'Bay Hill'],
  ['tpc sawgrass', 30.198, -81.394, 'TPC Sawgrass'],
  ['innisbrook', 28.111, -82.751, 'Innisbrook (Copperhead)'],
  ['memorial park', 29.765, -95.440, 'Memorial Park'],
  ['tpc san antonio', 29.676, -98.611, 'TPC San Antonio'],
  ['augusta national', 33.503, -82.022, 'Augusta National'],
  ['harbour town', 32.135, -80.811, 'Harbour Town'],
  ['tpc louisiana', 29.890, -90.181, 'TPC Louisiana'],
  ['tpc craig ranch', 33.137, -96.733, 'TPC Craig Ranch'],
  ['quail hollow', 35.103, -80.849, 'Quail Hollow'],
  ['philadelphia cricket', 40.076, -75.224, 'Philadelphia Cricket Club'],
  ['valhalla', 38.244, -85.464, 'Valhalla'],
  ['aronimink', 39.988, -75.400, 'Aronimink'],
  ['colonial', 32.718, -97.378, 'Colonial CC'],
  ['muirfield village', 40.122, -83.137, 'Muirfield Village'],
  ['oakmont', 40.526, -79.827, 'Oakmont CC'],
  ['shinnecock', 40.892, -72.441, 'Shinnecock Hills'],
  ['pinehurst', 35.191, -79.468, 'Pinehurst No. 2'],
  ['oak hill', 43.120, -77.540, 'Oak Hill'],
  ['tpc river highlands', 41.627, -72.648, 'TPC River Highlands'],
  ['detroit golf', 42.438, -83.150, 'Detroit GC'],
  ['tpc twin cities', 45.185, -93.230, 'TPC Twin Cities'],
  ['tpc deere run', 41.468, -90.410, 'TPC Deere Run'],
  ['renaissance club', 56.042, -2.758, 'The Renaissance Club'],
  ['royal portrush', 55.199, -6.636, 'Royal Portrush'],
  ['royal birkdale', 53.620, -3.032, 'Royal Birkdale'],
  ['st andrews', 56.343, -2.803, 'St Andrews Old Course'],
  ['royal troon', 55.531, -4.636, 'Royal Troon'],
  ['keene trace', 38.100, -84.540, 'Keene Trace'],
  ['tahoe mountain', 39.302, -120.181, 'Tahoe Mountain Club'],
  ['sedgefield', 36.039, -79.843, 'Sedgefield CC'],
  ['tpc southwind', 35.069, -89.789, 'TPC Southwind'],
  ['caves valley', 39.441, -76.775, 'Caves Valley'],
  ['castle pines', 39.437, -104.893, 'Castle Pines'],
  ['east lake', 33.743, -84.304, 'East Lake'],
  ['olympia fields', 41.513, -87.695, 'Olympia Fields'],
  ['bellerive', 38.606, -90.442, 'Bellerive'],
  ['silverado', 38.350, -122.268, 'Silverado'],
  ['country club of jackson', 32.430, -90.121, 'CC of Jackson'],
  ['black desert', 37.130, -113.615, 'Black Desert Resort'],
  ['tpc summerlin', 36.188, -115.297, 'TPC Summerlin'],
  ['narashino', 35.766, 140.078, 'Narashino CC'],
  ['el cardonal', 23.088, -109.703, 'El Cardonal at Diamante'],
  ['port royal', 32.255, -64.857, 'Port Royal (Bermuda)'],
  ['sea island', 31.146, -81.389, 'Sea Island'],
  ['albany', 25.006, -77.500, 'Albany (Bahamas)'],
  ['corales', 18.548, -68.367, 'Corales (Punta Cana)'],
  ['coco beach', 18.388, -65.785, 'Grand Reserve (Puerto Rico)'],
  ['grand reserve', 18.388, -65.785, 'Grand Reserve (Puerto Rico)'],
  ['hamilton golf', 43.244, -79.950, 'Hamilton G&CC'],
  ['tpc toronto', 43.962, -79.770, 'TPC Toronto'],
  ['bethpage', 40.745, -73.455, 'Bethpage Black'],
  ['congressional', 39.008, -77.170, 'Congressional'],
  ['tpc boston', 42.040, -71.260, 'TPC Boston'],
  ['liberty national', 40.698, -74.064, 'Liberty National'],
  ['glen abbey', 43.440, -79.718, 'Glen Abbey'],
  ['oakdale', 43.731, -79.522, 'Oakdale G&CC'],
];

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function lookupCourse(courseName) {
  const n = norm(courseName);
  for (const [kw, lat, lon, label] of COURSES) {
    if (n.includes(kw)) return { lat, lon, label, approx: false, source: 'table' };
  }
  return null;
}

async function geocode(city, state, country) {
  if (!city) return null;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&language=en&format=json`;
  const data = await fetchJson(url, { ttlMs: TTL.long });
  const results = data?.results || [];
  if (!results.length) return null;
  const st = norm(state), co = norm(country);
  const best = results.find(r => st && (norm(r.admin1) === st || norm(r.admin1).startsWith(st)))
    || results.find(r => co && (norm(r.country) === co || norm(r.country_code) === co))
    || results[0];
  return { lat: best.latitude, lon: best.longitude, label: `${best.name}, ${best.admin1 || best.country}`, approx: true, source: 'geocoder' };
}

// course = { name, city, state, country } from the ESPN event.
async function resolveCourseLocation(course = {}) {
  return lookupCourse(course.name) || await geocode(course.city, course.state, course.country).catch(() => null);
}

module.exports = { resolveCourseLocation, lookupCourse };
