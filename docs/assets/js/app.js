
// ============ 工具函数 ============
// 模糊找列名（不区分大小写，包含匹配）
function findCol(cols, candidates) {
  const low = {};
  cols.forEach(c => low[c.toLowerCase()] = c);
  for (const cand of candidates) {
    if (low[cand.toLowerCase()]) return low[cand.toLowerCase()];
  }
  // 包含匹配
  for (const c of cols) {
    const lc = c.toLowerCase();
    if (candidates.some(k => lc.includes(k.toLowerCase()))) return c;
  }
  return null;
}
function normCounty(s) {
  if (s === undefined || s === null) return "";
  return String(s).replace(/county/i, "").trim().toLowerCase();
}
function median(arr) {
  const v = arr.filter(x => Number.isFinite(x)).sort((a,b)=>a-b);
  if (!v.length) return NaN;
  const i = Math.floor(v.length/2);
  return v.length%2 ? v[i] : (v[i-1]+v[i])/2;
}
function minmax(series) {
  const vals = series.filter(Number.isFinite);
  if (!vals.length) return series.map(_ => 0);
  const mn = Math.min(...vals), mx = Math.max(...vals);
  if (mx === mn) return series.map(_ => 0);
  return series.map(x => Number.isFinite(x) ? (x - mn)/(mx - mn) : 0);
}

// ============ CSV 加载 ============
// PapaParse 读取 CSV（header: true）
async function loadCSV(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      header: true, download: true, dynamicTyping: true,
      complete: (res) => resolve(res.data),
      error: reject
    });
  });
}

// Quick data check（原来的按钮）
async function loadCSVSample(path, n = 5) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/).slice(0, n);
  return lines.join('\n');
}
const btn = document.getElementById('load-sample');
const out = document.getElementById('sample-output');
btn?.addEventListener('click', async () => {
  out.textContent = 'Loading...';
  try {
    const h = await loadCSVSample('data/housingvars.csv', 8);
    const a = await loadCSVSample('data/airbnbvars.csv', 8);
    out.textContent = `housingvars.csv (first lines):\n${h}\n\nairbnbvars.csv (first lines):\n${a}`;
  } catch (err) {
    out.textContent = String(err);
  }
});

// ============ 核心：加载数据 -> 聚合到县 -> 计算 mock_pred -> 上色 ============

let map, countiesGeo, joinedTable = null;

async function buildChoropleth() {
  // 1) 读取数据
  const [housing, airbnb, counties] = await Promise.all([
    loadCSV('data/housingvars.csv'),
    loadCSV('data/airbnbvars.csv'),
    fetch('data/ca_counties.geojson').then(r=>r.json())
  ]);
  countiesGeo = counties; // 保留一份原始 GeoJSON

  // 2) 自动找列
  const hCols = Object.keys(housing[0] || {});
  const aCols = Object.keys(airbnb[0] || {});
  const county_h = findCol(hCols, ['county']);
  const county_a = findCol(aCols, ['county']);
  const price_h  = findCol(hCols, ['price','median_price']);
  const price_a  = findCol(aCols, ['price','nightly_price','listing_price']);

  if (!county_h || !county_a || !price_h || !price_a) {
    console.warn('Column detection failed:', { county_h, county_a, price_h, price_a });
    document.getElementById('legend').textContent =
      'Column detection failed. Please ensure both CSVs have County & Price columns.';
    return;
  }

  // 3) 规范化 county 名
  housing.forEach(r => r.__county = normCounty(r[county_h]));
  airbnb.forEach(r => r.__county = normCounty(r[county_a]));

  // 4) 聚合成 “每县中位数”
  const hBy = new Map();  // county -> array of housing prices
  housing.forEach(r => {
    const k = r.__county; const v = Number(r[price_h]);
    if (!k || !Number.isFinite(v)) return;
    if (!hBy.has(k)) hBy.set(k, []);
    hBy.get(k).push(v);
  });
  const aBy = new Map();  // county -> array of airbnb prices
  airbnb.forEach(r => {
    const k = r.__county; const v = Number(r[price_a]);
    if (!k || !Number.isFinite(v)) return;
    if (!aBy.has(k)) aBy.set(k, []);
    aBy.get(k).push(v);
  });

  const countiesSet = new Set([...hBy.keys(), ...aBy.keys()]);
  const rows = [];
  countiesSet.forEach(k => {
    const hmed = median(hBy.get(k)||[]);
    const amed = median(aBy.get(k)||[]);
    rows.push({ __county: k, housing_med: hmed, airbnb_med: amed });
  });

  // 5) 归一化 + 初次 mock_pred
  const h_norm = minmax(rows.map(r => r.housing_med));
  const a_norm = minmax(rows.map(r => r.airbnb_med));
  rows.forEach((r, i) => { r.h_norm = h_norm[i]; r.a_norm = a_norm[i]; });

  joinedTable = new Map(rows.map(r => [r.__county, r])); // 便于查找

  // 6) 初始化地图并渲染
  initMap();
  applyWeight(parseFloat(document.getElementById('w_h')?.value || '0.7'));
}

// 现在只用 housing_med（房价中位数）来上色
function applyWeight(_w_h_unused) {

  // v 在 [0,1] 内，映射到 [230(浅) -> 40(深)]
  function toShade(v) {
    if (!Number.isFinite(v)) return 200; // 缺失：浅灰
    const shade = Math.round(230 - 190 * Math.max(0, Math.min(1, v)));
    return Math.max(40, Math.min(230, shade));
  }

  const feat = countiesGeo.features;
  for (const f of feat) {
    const p = f.properties || {};
    const nameRaw = p.CountyName || p.NAME || p.name || '';
    const key = normCounty(nameRaw);
    const row = joinedTable?.get(key);

    const hmed = row?.housing_med;
    const amed = row?.airbnb_med;
    // 用归一化后的 housing_med 作为 score（0–1）
    const score = row ? row.h_norm : NaN;

    p.housing_med = Number.isFinite(hmed) ? hmed : null;
    p.airbnb_med  = Number.isFinite(amed) ? amed : null;
    p.mock_pred   = null;        // 不再使用 mock_pred
    p.shade       = toShade(score);

    // tooltip：展示县名 + 两个中位数
    p.__tooltip   = [
      `County: ${nameRaw || 'Unknown'}`,
      (Number.isFinite(hmed) ? `Median housing price: ${hmed}` : null),
      (Number.isFinite(amed) ? `Median Airbnb price: ${amed}` : null),
    ].filter(Boolean).join('\n');
  }

  // represh map
  if (map?.getSource('counties')) {
    map.getSource('counties').setData(countiesGeo);
  }

  //  legend text
  const legendEl = document.getElementById('legend');
  if (legendEl) {
    legendEl.textContent =
      'Legend: lighter \u2192 lower median housing price, darker \u2192 higher median housing price.';
  }
}

// 初始化 MapLibre
function initMap() {
  if (map) return; // 只初始化一次
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: [-119.5, 36.5],
    zoom: 5.2
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }));

  map.on('load', () => {
    map.addSource('counties', { type: 'geojson', data: countiesGeo });

    map.addLayer({
      id: 'counties-fill',
      type: 'fill',
      source: 'counties',
      paint: {
        // 使用属性 shade 三通道灰度；opacity 0.78
        'fill-color': [
          'rgba',
          ['get', 'shade'], ['get', 'shade'], ['get', 'shade'], 0.78
        ],
        'fill-outline-color': '#B5B5B5'
      }
    });

    // 简单的 hover tooltip
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    map.on('mousemove', 'counties-fill', (e) => {
      const f = e.features && e.features[0];
      if (!f) return;
      const tip = f.properties?.__tooltip || '';
      popup.setLngLat(e.lngLat).setText(tip).addTo(map);
    });
    map.on('mouseleave', 'counties-fill', () => popup.remove());
  });
}

// 监听权重滑条
document.getElementById('w_h')?.addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  applyWeight(v);
});

// 启动：构建县级底图
buildChoropleth().catch(err => {
  console.error(err);
  document.getElementById('legend').textContent = String(err);
});
