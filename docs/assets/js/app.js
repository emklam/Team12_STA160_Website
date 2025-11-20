// ==================== 工具函数 ====================

// 货币格式化：$ + 千分位
function fmtMoney(x) {
  if (!Number.isFinite(x)) return "N/A";
  return "$" + x.toLocaleString();
}

// 模糊找列名
function findCol(cols, candidates) {
  const low = {};
  cols.forEach(c => low[c.toLowerCase()] = c);

  for (const cand of candidates) {
    if (low[cand.toLowerCase()]) return low[cand.toLowerCase()];
  }
  for (const c of cols) {
    const lc = c.toLowerCase();
    if (candidates.some(k => lc.includes(k.toLowerCase()))) return c;
  }
  return null;
}

// 统一县名
function normCounty(s) {
  if (!s) return "";
  return String(s).replace(/county/i, "").trim().toLowerCase();
}

// 中位数
function median(arr) {
  const v = arr.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!v.length) return NaN;
  const i = Math.floor(v.length/2);
  return v.length % 2 ? v[i] : (v[i-1] + v[i]) / 2;
}

// 归一化 0–1
function minmax(series) {
  const vals = series.filter(Number.isFinite);
  if (!vals.length) return series.map(_ => 0);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx === mn) return series.map(_ => 0);
  return series.map(x => (x - mn) / (mx - mn));
}

// PapaParse CSV
async function loadCSV(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      header: true,
      download: true,
      dynamicTyping: true,
      complete: res => resolve(res.data),
      error: reject
    });
  });
}


// ==================== 地图核心逻辑（通用） ====================

let map, countiesGeo, joinedTable;

// 根据 score（0-1）映射颜色
function shadeColor(value, palette) {
  if (!Number.isFinite(value)) return palette.missing;

  const idx = Math.floor(value * (palette.colors.length - 1));
  return palette.colors[idx];
}

// tooltip 构造
function buildTooltip(county, housingMed, airbnbMed) {
  return [
    `County: ${county}`,
    (housingMed != null ? `Median housing price: ${fmtMoney(housingMed)}` : null),
    (airbnbMed != null ? `Median Airbnb price: ${fmtMoney(airbnbMed)}` : null),
  ].filter(Boolean).join("\n");
}


// ==================== Housing Map（蓝色） ====================

async function buildHousingMap() {

  const [housing, counties] = await Promise.all([
    loadCSV("../data/housingvars.csv"),
    fetch("../data/ca_counties.geojson").then(r => r.json())
  ]);
  countiesGeo = counties;

  const hCols = Object.keys(housing[0] || {});
  const county_h = findCol(hCols, ["county"]);
  const price_h  = findCol(hCols, ["price", "median_price"]);

  housing.forEach(r => r.__county = normCounty(r[county_h]));

  const byCounty = new Map();
  housing.forEach(r => {
    const k = r.__county;
    const v = Number(r[price_h]);
    if (!k || !Number.isFinite(v)) return;
    if (!byCounty.has(k)) byCounty.set(k, []);
    byCounty.get(k).push(v);
  });

  const rows = [];
  for (const k of byCounty.keys()) {
    rows.push({ __county: k, housing_med: median(byCounty.get(k)) });
  }

  const h_norm = minmax(rows.map(r => r.housing_med));
  rows.forEach((r,i) => r.h_norm = h_norm[i]);

  joinedTable = new Map(rows.map(r => [r.__county, r]));

  initMap("housing");
  colorizeHousing();
}

function colorizeHousing() {
  const palette = {
    missing: "#d0d0d0",
    colors: [
      "#e8f1ff", "#d0e4ff", "#b2d1ff", "#8bb8ff", "#5c97ff",
      "#3f80ff", "#1e6bff", "#0854e8", "#003cad"
    ]
  };

  for (const f of countiesGeo.features) {
    const p = f.properties || {};
    const countyRaw = p.CountyName || p.NAME || p.name || "";
    const key = normCounty(countyRaw);
    const row = joinedTable.get(key);

    const hmed = row?.housing_med;
    const score = row?.h_norm;

    p.fillColor = shadeColor(score, palette);
    p.__tooltip = buildTooltip(countyRaw, hmed, null);
  }

  if (map?.getSource("counties")) {
    map.getSource("counties").setData(countiesGeo);
  }
}


// ==================== Airbnb Map（橙色） ====================

async function buildAirbnbMap() {

  const [airbnb, counties] = await Promise.all([
    loadCSV("../data/airbnbvars.csv"),
    fetch("../data/ca_counties.geojson").then(r => r.json())
  ]);
  countiesGeo = counties;

  const aCols = Object.keys(airbnb[0] || {});
  const county_a = findCol(aCols, ["county"]);
  const price_a  = findCol(aCols, ["price", "nightly_price", "listing_price"]);

  airbnb.forEach(r => r.__county = normCounty(r[county_a]));

  const byCounty = new Map();
  airbnb.forEach(r => {
    const k = r.__county;
    const v = Number(r[price_a]);
    if (!k || !Number.isFinite(v)) return;
    if (!byCounty.has(k)) byCounty.set(k, []);
    byCounty.get(k).push(v);
  });

  const rows = [];
  for (const k of byCounty.keys()) {
    rows.push({ __county: k, airbnb_med: median(byCounty.get(k)) });
  }

  const a_norm = minmax(rows.map(r => r.airbnb_med));
  rows.forEach((r,i) => r.a_norm = a_norm[i]);

  joinedTable = new Map(rows.map(r => [r.__county, r]));

  initMap("airbnb");
  colorizeAirbnb();
}

function colorizeAirbnb() {
  const palette = {
    missing: "#d9d1c4",
    colors: [
      "#fff5e6", "#ffe8cc", "#ffd8a8", "#ffc078", "#ffa94d",
      "#ff922b", "#fd7e14", "#f76707", "#d9480f"
    ]
  };

  for (const f of countiesGeo.features) {
    const p = f.properties || {};
    const countyRaw = p.CountyName || p.NAME || p.name || "";
    const key = normCounty(countyRaw);
    const row = joinedTable.get(key);

    const amed = row?.airbnb_med;
    const score = row?.a_norm;

    p.fillColor = shadeColor(score, palette);
    p.__tooltip = buildTooltip(countyRaw, null, amed);
  }

  if (map?.getSource("counties")) {
    map.getSource("counties").setData(countiesGeo);
  }
}


// ==================== MapLibre 初始化（通用） ====================

function initMap(mode) {
  if (map) return;

  map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-119.5, 36.5],
    zoom: 5.2
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }));

  map.on("load", () => {
    // source
    map.addSource("counties", {
      type: "geojson",
      data: countiesGeo
    });

    map.addLayer({
      id: "counties-fill",
      type: "fill",
      source: "counties",
      paint: {
        "fill-color": ["get", "fillColor"],
        "fill-opacity": 0.85,
        "fill-outline-color": "#888"
      }
    });

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false
    });

    map.on("mousemove", "counties-fill", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      popup.setLngLat(e.lngLat).setText(f.properties.__tooltip).addTo(map);
    });

    map.on("mouseleave", "counties-fill", () => popup.remove());
  });
}


// ==================== 页面自动识别并加载 ====================

const path = window.location.pathname;

if (path.endsWith("map.html")) {
  buildHousingMap().catch(err => console.error(err));
}

if (path.endsWith("airbnb-map.html")) {
  buildAirbnbMap().catch(err => console.error(err));
}

