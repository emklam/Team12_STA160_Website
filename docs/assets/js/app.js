// ================= 工具函数 =================

// 千分位 + $ 格式化
function fmtMoney(x) {
  if (!Number.isFinite(x)) return 'N/A';
  return '$' + x.toLocaleString();
}

// 不区分大小写：模糊匹配列名
function findCol(cols, candidates) {
  const lower = {};
  cols.forEach(c => lower[c.toLowerCase()] = c);

  for (const c of candidates) {
    if (lower[c.toLowerCase()]) return lower[c.toLowerCase()];
  }
  for (const c of cols) {
    if (candidates.some(k => c.toLowerCase().includes(k.toLowerCase()))) return c;
  }
  return null;
}

function normCounty(s) {
  if (!s) return '';
  return String(s).replace(/county/i, '').trim().toLowerCase();
}

function median(arr) {
  const v = arr.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!v.length) return NaN;
  const i = Math.floor(v.length/2);
  return v.length % 2 ? v[i] : (v[i-1]+v[i]) / 2;
}

function minmax(arr) {
  const v = arr.filter(Number.isFinite);
  if (!v.length) return arr.map(_=>0);
  const mn = Math.min(...v), mx = Math.max(...v);
  return arr.map(x => Number.isFinite(x) ? (x - mn)/(mx - mn) : 0);
}

// ================= CSV 读取 =================
async function loadCSV(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      header: true, download: true, dynamicTyping: true,
      complete: r => resolve(r.data),
      error: reject
    });
  });
}

// ================= 全局变量 =================
let map, countiesGeo, joinedTable;

// ================= 主逻辑：构建地图 =================
async function buildChoropleth() {

  // 判断是 housing-map.html 还是 airbnb-map.html
  const isHousing = location.pathname.includes("map.html");
  const isAirbnb  = location.pathname.includes("airbnb-map.html");

  if (!isHousing && !isAirbnb) return;  // 不是地图页面就退出

  // 加载数据
  const [housing, airbnb, counties] = await Promise.all([
    loadCSV("data/housingvars.csv"),
    loadCSV("data/airbnbvars.csv"),
    fetch("data/ca_counties.geojson").then(r=>r.json())
  ]);

  countiesGeo = counties;

  // 自动找列
  const hCols = Object.keys(housing[0] || {});
  const aCols = Object.keys(airbnb[0] || {});

  const county_h = findCol(hCols, ["county"]);
  const county_a = findCol(aCols, ["county"]);
  const price_h  = findCol(hCols, ["price", "median_price"]);
  const price_a  = findCol(aCols, ["price", "nightly", "airbnb"]);

  // 预处理 county
  housing.forEach(r => r.__county = normCounty(r[county_h]));
  airbnb.forEach(r => r.__county = normCounty(r[county_a]));

  // 聚合
  const hBy = new Map();
  housing.forEach(r=>{
    const k=r.__county,v=r[price_h];
    if(!k||!Number.isFinite(v))return;
    if(!hBy.has(k))hBy.set(k,[]);
    hBy.get(k).push(v);
  });

  const aBy = new Map();
  airbnb.forEach(r=>{
    const k=r.__county,v=r[price_a];
    if(!k||!Number.isFinite(v))return;
    if(!aBy.has(k))aBy.set(k,[]);
    aBy.get(k).push(v);
  });

  const countiesSet = new Set([...hBy.keys(), ...aBy.keys()]);
  const rows = [];

  countiesSet.forEach(k=>{
    rows.push({
      __county: k,
      housing_med: median(hBy.get(k)||[]),
      airbnb_med:  median(aBy.get(k)||[])
    });
  });

  // 归一化
  const hn = minmax(rows.map(r=>r.housing_med));
  const an = minmax(rows.map(r=>r.airbnb_med));

  rows.forEach((r,i)=>{
    r.h_norm = hn[i];
    r.a_norm = an[i];
  });

  joinedTable = new Map(rows.map(r=>[r.__county,r]));

  initMap();

  // Housing 显示 housing 数据，Airbnb 显示 airbnb 数据
  applyColor(isHousing ? "housing" : "airbnb");
}

// ================= 上色：蓝色 / 橙色 =================
function applyColor(mode) {

  function blueScale(v) {   // Housing
    const t = Math.max(0, Math.min(1, v));
    const light = [198,220,255];
    const dark  = [ 15, 60,150];
    return [
      Math.round(light[0] + (dark[0]-light[0])*t),
      Math.round(light[1] + (dark[1]-light[1])*t),
      Math.round(light[2] + (dark[2]-light[2])*t)
    ];
  }

  function orangeScale(v) { // Airbnb
    const t = Math.max(0, Math.min(1, v));
    const light = [255,225,180];
    const dark  = [200,120,  0];
    return [
      Math.round(light[0] + (dark[0]-light[0])*t),
      Math.round(light[1] + (dark[1]-light[1])*t),
      Math.round(light[2] + (dark[2]-light[2])*t)
    ];
  }

  countiesGeo.features.forEach(f=>{
    const p = f.properties || {};
    const name = p.CountyName || p.NAME || p.name || "";
    const key = normCounty(name);
    const row = joinedTable.get(key);

    const h = row?.housing_med;
    const a = row?.airbnb_med;

    let valueNorm, rgb;

    if (mode === "housing") {
      valueNorm = row?.h_norm ?? 0;
      rgb = blueScale(valueNorm);
    } else {
      valueNorm = row?.a_norm ?? 0;
      rgb = orangeScale(valueNorm);
    }

    p.shade_r = rgb[0];
    p.shade_g = rgb[1];
    p.shade_b = rgb[2];

    // Tooltip 美化
    p.__tooltip =
      `County: ${name}\n` +
      `Median housing: ${fmtMoney(h)}\n` +
      `Median Airbnb: ${fmtMoney(a)}`;
  });

  if (map?.getSource("counties")) {
    map.getSource("counties").setData(countiesGeo);
  }
}

// ================= 初始化地图 =================
function initMap() {
  if (map) return;

  map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-119.5, 36.5],
    zoom: 5.1
  });

  map.addControl(new maplibregl.NavigationControl());

  map.on("load", ()=>{
    map.addSource("counties", { type:"geojson", data: countiesGeo });

    map.addLayer({
      id: "counties-fill",
      type: "fill",
      source: "counties",
      paint: {
        "fill-color": [
          "rgba",
          ["get","shade_r"],
          ["get","shade_g"],
          ["get","shade_b"],
          0.78
        ],
        "fill-outline-color": "#888"
      }
    });

    // Tooltip
    const popup = new maplibregl.Popup({ closeButton:false, closeOnClick:false });

    map.on("mousemove", "counties-fill", e=>{
      const f = e.features?.[0];
      if (!f) return;
      popup.setLngLat(e.lngLat).setText(f.properties.__tooltip).addTo(map);
    });

    map.on("mouseleave", "counties-fill", ()=>popup.remove());
  });
}

// ================= 启动 =================
buildChoropleth().catch(err=>{
  console.error(err);
  const legend = document.getElementById("legend");
  if (legend) legend.textContent = String(err);
});


