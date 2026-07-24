const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const runtimeConfig = window.SECTOR_PULSE_CONFIG || {};
const staticMode = Boolean(runtimeConfig.staticMode && runtimeConfig.apiBase);
const historyEnabled = !staticMode || Boolean(runtimeConfig.historyEnabled);
const apiUrl = path => staticMode ? `${runtimeConfig.apiBase.replace(/\/$/, "")}${path}` : path;
const defaults = { period: 14, oversold: 30, overbought: 70 };
let settings = { ...defaults, ...JSON.parse(localStorage.getItem("sectorPulseSettings") || "{}") };
if (staticMode) settings.period = 14;
let snapshot = null;
let timer = null;
let momentumLoading = false;
const smartRefreshAt = { momentum: 0, contribution: 0, history: 0 };
const SMART_REFRESH_MS = 300000;
const momentumTickersInput = $("#momentumTickersInput");
if (momentumTickersInput) momentumTickersInput.value = localStorage.getItem("sectorPulseMomentumTickers") || "";

function formatNumber(value, digits = 1) { return value == null ? "—" : Number(value).toFixed(digits); }
function formatTime(iso) { return new Intl.DateTimeFormat(undefined, {hour:"numeric",minute:"2-digit",month:"short",day:"numeric"}).format(new Date(iso)); }
function prettyDate(iso) { if (!iso) return "—"; return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}); }

function sparkline(svg, values) {
  if (!values?.length) return;
  const width = 300, height = 54;
  const point = (v, i) => `${(i / Math.max(values.length - 1, 1)) * width},${height - (v / 100) * height}`;
  svg.innerHTML = `<rect class="band" x="0" y="${height*(1-settings.overbought/100)}" width="${width}" height="${height*((settings.overbought-settings.oversold)/100)}"></rect>
    <line class="threshold" x1="0" x2="${width}" y1="${height*(1-settings.oversold/100)}" y2="${height*(1-settings.oversold/100)}"></line>
    <line class="threshold" x1="0" x2="${width}" y1="${height*(1-settings.overbought/100)}" y2="${height*(1-settings.overbought/100)}"></line>
    <polyline class="line" points="${values.map(point).join(" ")}"></polyline>`;
}

function sortedSectors(items) {
  const mode = $("#sort").value;
  return [...items].sort((a,b) => {
    if (a.error) return 1; if (b.error) return -1;
    if (mode === "rsi-desc") return b.rsi-a.rsi;
    if (mode === "change-desc") return b.changePct-a.changePct;
    if (mode === "ticker") return a.ticker.localeCompare(b.ticker);
    return a.rsi-b.rsi;
  });
}

function renderCardGroup(cards, items, draggable = false) {
  cards.innerHTML = "";
  if (!snapshot) return;
  const displayedItems = draggable ? items : sortedSectors(items);
  displayedItems.forEach(item => {
    const node = $("#cardTemplate").content.firstElementChild.cloneNode(true);
    node.dataset.ticker = item.ticker;
    if (draggable) {
      node.draggable = true;
      node.classList.add("custom-momentum-card");
      node.title = "Drag to reorder this custom ticker";
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "⋮⋮";
      handle.setAttribute("aria-label", "Drag to reorder");
      $(".card-head", node).prepend(handle);
    }
    if (item.error) { node.innerHTML = `<strong>${item.ticker}</strong><p>${item.name}</p><p class="error">${item.error}</p>`; cards.append(node); return; }
    node.classList.add(`status-${item.status}`);
    $(".ticker",node).textContent=item.ticker; $(".sector-name",node).textContent=item.name;
    $(".badge",node).textContent=item.status.toUpperCase(); $(".rsi-value",node).textContent=formatNumber(item.rsi);
    $(".rsi-label",node).textContent=`RSI-${settings.period}`;
    const direction=item.rsiChange5d>0?"↑":item.rsiChange5d<0?"↓":"→";
    $(".rsi-trend",node).textContent=`${direction} ${Math.abs(item.rsiChange5d).toFixed(1)} over 5d`;
    $(".gauge-marker",node).style.left=`calc(${Math.max(0,Math.min(100,item.rsi))}% - 1px)`;
    $$('[data-oversold]',node).forEach(x=>x.textContent=settings.oversold); $$('[data-overbought]',node).forEach(x=>x.textContent=settings.overbought);
    sparkline($(".sparkline",node),item.history);
    $(".price",node).textContent=`$${formatNumber(item.price,2)}`;
    const change=$(".daily-change",node); change.textContent=`${item.changePct>=0?"+":""}${formatNumber(item.changePct,2)}% today`; change.classList.add(item.changePct>=0?"positive":"negative");
    cards.append(node);
  });
}

function saveCustomOrderFromCards() {
  const tickers = $$("#customCards .custom-momentum-card").map(card => card.dataset.ticker);
  const value = tickers.join(", ");
  momentumTickersInput.value = value;
  localStorage.setItem("sectorPulseMomentumTickers", value);
  const byTicker = new Map((snapshot.customTickers || []).map(item => [item.ticker, item]));
  snapshot.customTickers = tickers.map(ticker => byTicker.get(ticker)).filter(Boolean);
}

function configureCustomCardDragging() {
  const grid = $("#customCards");
  let dragged = null;
  grid.addEventListener("dragstart", event => {
    dragged = event.target.closest(".custom-momentum-card");
    if (!dragged) return;
    dragged.classList.add("dragging");
    event.dataTransfer.effectAllowed = "move";
  });
  grid.addEventListener("dragover", event => {
    if (!dragged) return;
    event.preventDefault();
    const target = event.target.closest(".custom-momentum-card");
    if (!target || target === dragged) return;
    const box = target.getBoundingClientRect();
    const before = event.clientY < box.top + box.height / 2 ||
      (Math.abs(event.clientY - (box.top + box.height / 2)) < box.height / 3 && event.clientX < box.left + box.width / 2);
    grid.insertBefore(dragged, before ? target : target.nextSibling);
  });
  grid.addEventListener("dragend", () => {
    if (!dragged) return;
    dragged.classList.remove("dragging");
    dragged = null;
    saveCustomOrderFromCards();
  });
}

function renderCards() {
  renderCardGroup($("#cards"), snapshot?.sectors || []);
  const customItems = snapshot?.customTickers || [];
  const customSection = $("#customMomentumSection");
  const customCards = $("#customCards");
  if (customSection && customCards) {
    customSection.classList.toggle("hidden", customItems.length === 0);
    renderCardGroup(customCards, customItems, true);
  }
}

function render(data) {
  if (staticMode) {
    const sectors = (data.sectors || []).map(item => ({
      ...item,
      status: item.rsi <= settings.oversold ? "oversold" : item.rsi >= settings.overbought ? "overbought" : "neutral",
    }));
    data = {
      ...data,
      sectors,
      counts: {
        oversold: sectors.filter(item => item.status === "oversold").length,
        neutral: sectors.filter(item => item.status === "neutral").length,
        overbought: sectors.filter(item => item.status === "overbought").length,
      },
    };
  }
  snapshot=data; const vix=data.vix; const regime=$("#regime");
  regime.className=`regime ${vix.regime}`;
  $(".regime-label").textContent=vix.regime==="elevated"?"VIX is above its 200-day average":"VIX is below its 200-day average";
  $(".regime-copy").textContent=vix.regime==="elevated"?"Elevated-volatility regime — use extra care with momentum extremes":"Lower-volatility regime — momentum extremes still require confirmation";
  $("#vixValue").textContent=formatNumber(vix.value,2); $("#vixMa").textContent=formatNumber(vix.ma200,2);
  $("#vixDistance").textContent=`${vix.distancePct>=0?"+":""}${formatNumber(vix.distancePct)}% vs average`;
  $("#oversoldCount").textContent=data.counts.oversold; $("#neutralCount").textContent=data.counts.neutral; $("#overboughtCount").textContent=data.counts.overbought;
  $("#marketDate").textContent=prettyDate(data.marketDate); $("#updatedAt").textContent=`Checked ${formatTime(data.generatedAt)}${data.cached?" · cached":""}`;
  $("#sourceLine").textContent=`Data source: ${data.source}. Latest bar: ${prettyDate(data.marketDate)}.`;
  if (staticMode && marketIsOpen() && Date.now() - new Date(data.generatedAt).getTime() > 20 * 60 * 1000) {
    $("#errorBox").textContent = "The latest successful snapshot is more than 20 minutes old. Treat the displayed prices as stale.";
    $("#errorBox").classList.remove("hidden");
  }
  $$('[data-oversold]').forEach(x=>x.textContent=settings.oversold); $$('[data-overbought]').forEach(x=>x.textContent=settings.overbought);
  renderCards();
}

async function load(force=false) {
  if (momentumLoading) return;
  momentumLoading = true;
  $("#refreshButton").disabled=true; $("#refreshButton").textContent="Loading…"; $("#errorBox").classList.add("hidden");
  try {
    const q=new URLSearchParams({period:settings.period,oversold:settings.oversold,overbought:settings.overbought,tickers:momentumTickersInput?.value.trim() || "",force:force?1:0});
    const response=await fetch(apiUrl(`/api/market?${q}`)); const data=await response.json(); if(!response.ok) throw new Error(data.error||"Unknown data error"); render(data);smartRefreshAt.momentum=Date.now();
  } catch(error) { $("#errorBox").textContent=`${error.message} Existing cards, if any, have not been replaced.`; $("#errorBox").classList.remove("hidden"); }
  finally { momentumLoading=false; $("#refreshButton").disabled=false; $("#refreshButton").textContent="↻ Refresh Page"; }
}

function marketIsOpen() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone:"America/New_York",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date()).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  if (["Sat","Sun"].includes(parts.weekday)) return false;
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  return minute >= 570 && minute < 960;
}
function smartRefreshActiveTab() {
  if (document.hidden || !marketIsOpen()) return;
  const active = $(".tab.active")?.dataset.tab;
  const now = Date.now();
  if (active === "momentum" && now - smartRefreshAt.momentum >= SMART_REFRESH_MS) load(false);
  if (active === "contribution" && contributionPeriod === "today" && contributionsLoaded && now - smartRefreshAt.contribution >= SMART_REFRESH_MS) loadContributions(false);
  if ($("#sectorHistoryDialog")?.open && now - smartRefreshAt.history >= SMART_REFRESH_MS) loadSectorHistory(false);
}
function configureTimer(){clearInterval(timer);timer=setInterval(smartRefreshActiveTab,60000)}
function openSettings(){ $("#periodInput").value=settings.period; $("#oversoldInput").value=settings.oversold; $("#overboughtInput").value=settings.overbought; $("#settingsDialog").showModal(); }

$("#refreshButton").addEventListener("click",()=>load(true)); $("#sort").addEventListener("change",renderCards); $("#settingsButton").addEventListener("click",openSettings);
const momentumTickersUpdate = $("#momentumTickersUpdate");
if (momentumTickersUpdate && momentumTickersInput) {
  momentumTickersUpdate.addEventListener("click",()=>{localStorage.setItem("sectorPulseMomentumTickers",momentumTickersInput.value.trim());load(true)});
  momentumTickersInput.addEventListener("keydown",event=>{if(event.key==="Enter")momentumTickersUpdate.click()});
  configureCustomCardDragging();
}
$("#saveSettings").addEventListener("click",event=>{event.preventDefault();const next={period:staticMode?14:Number($("#periodInput").value),oversold:Number($("#oversoldInput").value),overbought:Number($("#overboughtInput").value)};if(next.oversold>=next.overbought){alert("Oversold must be below overbought.");return}settings=next;localStorage.setItem("sectorPulseSettings",JSON.stringify(settings));$("#settingsDialog").close();load(false)});

let valuationsLoaded = false;
let contributionsLoaded = false;
let contributionSnapshot = null;
let contributionDisplaySnapshot = null;
let contributionPeriodSnapshot = null;
let contributionChartMode = "performance";
let contributionPeriod = "today";
let contributionLoading = false;

function periodYears(data) {
  if (!data?.startDate || !data?.endDate) return 0;
  return (new Date(`${data.endDate}T12:00:00`) - new Date(`${data.startDate}T12:00:00`)) / 86400000 / 365.2425;
}

function annualizedReturn(value, years) {
  if (value <= -100) return -100;
  return (Math.pow(1 + value / 100, 1 / years) - 1) * 100;
}

function periodDisplayData(data) {
  const years = periodYears(data);
  const annualize = $("#barAnnualize")?.checked && years > 1.002;
  if (!annualize) return {...data, annualized:false};
  const annualSpy = annualizedReturn(Number(data.spyChangePct), years);
  const impactTotal = data.sectors.reduce((sum, item) => sum + Number(item.contributionPct), 0);
  const impactScale = Math.abs(impactTotal) > .000001 ? annualSpy / impactTotal : 1 / years;
  return {
    ...data,
    annualized:true,
    spyChangePct:annualSpy,
    sectors:data.sectors.map(item => ({...item,
      changePct:annualizedReturn(Number(item.changePct), years),
      contributionPct:Number(item.contributionPct) * impactScale})),
    benchmarks:(data.benchmarks || []).map(item => ({...item,
      changePct:annualizedReturn(Number(item.changePct), years)})),
  };
}

function updateAnnualizeControl(data) {
  const checkbox = $("#barAnnualize");
  if (checkbox) checkbox.disabled = !data || periodYears(data) <= 1.002;
}
function valuationValue(value, suffix = "×") { return value == null ? "—" : `${Number(value).toFixed(2)}${suffix}`; }
function ordinal(value) {
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`;
  return `${value}${value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th"}`;
}
function rankLabel(value) {
  if (value <= 20) return `${ordinal(value)} · historically low`;
  if (value >= 80) return `${ordinal(value)} · historically high`;
  return `${ordinal(value)} · middle range`;
}
function recentRangePosition(current, observed) {
  if (current == null || !observed || observed.high <= observed.low) return null;
  const percentage = Math.max(0, Math.min(100, (current - observed.low) / (observed.high - observed.low) * 100));
  let label, tone;
  if (percentage <= 25) { label = "near the low end"; tone = "low"; }
  else if (percentage < 45) { label = "below its typical level"; tone = "low"; }
  else if (percentage <= 55) { label = "near its typical level"; tone = "middle"; }
  else if (percentage < 75) { label = "above its typical level"; tone = "high"; }
  else { label = "near the high end"; tone = "high"; }
  return { percentage, label, tone };
}

function renderValuationCards(container, items) {
  container.innerHTML = "";
  items.forEach(item => {
    const node = $("#valuationTemplate").content.firstElementChild.cloneNode(true);
    $(".val-ticker", node).textContent = item.ticker;
    $(".val-name", node).textContent = item.name;
    const badge = $(".source-badge", node);
    badge.textContent = item.sourceType === "issuer" ? "ISSUER DATA" : "MARKET FEED";
    badge.classList.add(item.sourceType === "issuer" ? "issuer" : "fallback");
    $(".val-forward", node).textContent = valuationValue(item.forwardPE);
    $(".val-trailing", node).textContent = valuationValue(item.trailingPE);
    $(".val-book", node).textContent = valuationValue(item.priceBook);
    $(".val-growth", node).textContent = item.epsGrowth == null ? "—" : `${Number(item.epsGrowth).toFixed(1)}%`;
    $(".val-rank", node).textContent = item.percentile == null ? "Building history" : `${item.percentile.toFixed(0)}th percentile`;
    if (item.estimatedHistory) {
      const estimate = $(".estimated-history", node);
      estimate.classList.remove("hidden");
      const observed = item.estimatedHistory.recentForwardPE;
      $(".normal-range", node).textContent = `${observed.low.toFixed(1)}× – ${observed.high.toFixed(1)}×`;
      const position = recentRangePosition(item.forwardPE, observed);
      const positionText = $(".normal-position", node);
      positionText.textContent = position ? `Today: ${position.label} · Typical midpoint ≈ ${observed.midpoint.toFixed(1)}×` : `Typical midpoint ≈ ${observed.midpoint.toFixed(1)}×`;
      if (position) positionText.classList.add(position.tone);
      const rangeTrack = document.createElement("div");
      rangeTrack.className = "observed-range-track";
      rangeTrack.innerHTML = `<span class="range-low">${observed.low.toFixed(1)}×</span><i></i><span class="range-mid">${observed.midpoint.toFixed(1)}×</span><span class="range-high">${observed.high.toFixed(1)}×</span>`;
      if (position) rangeTrack.querySelector("i").style.left = `${position.percentage}%`;
      $(".normal-band-callout", node).append(rangeTrack);
      const estimateSource = $(".estimate-source", node);
      estimateSource.href = item.estimatedHistory.sourceUrl;
      estimateSource.title = `${item.estimatedHistory.method} As of ${item.estimatedHistory.asOf}. ${item.estimatedHistory.source}.`;
    }
    $(".history-bar", node).style.width = `${Math.min(100, item.snapshotCount / 20 * 100)}%`;
    $(".snapshot-note", node).textContent = `${item.snapshotCount} local daily snapshot${item.snapshotCount === 1 ? "" : "s"} · issuer as of ${item.asOf || "not stated"}`;
    const source = $(".source-link", node); source.href = item.sourceUrl; source.textContent = `${item.source} source ↗`;
    $(".val-note", node).textContent = item.note;
    container.append(node);
  });
}

async function loadValuations(force = false) {
  const button = $("#valuationRefresh");
  button.disabled = true; button.textContent = "Loading…"; $("#valuationError").classList.add("hidden");
  try {
    const tickers = $("#watchlistInput").value.trim();
    localStorage.setItem("sectorPulseWatchlist", tickers);
    const query = new URLSearchParams({tickers, force: force ? 1 : 0});
    const response = await fetch(apiUrl(`/api/valuations?${query}`));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unknown valuation error");
    renderValuationCards($("#sectorValuations"), data.sectors);
    renderValuationCards($("#watchlistValuations"), data.watchlist);
    $("#valuationMethod").textContent = data.methodology;
    $("#valuationUpdated").textContent = `Checked ${formatTime(data.generatedAt)}${data.cached ? " · cached" : ""}`;
    valuationsLoaded = true;
  } catch (error) {
    $("#valuationError").textContent = error.message;
    $("#valuationError").classList.remove("hidden");
  } finally { button.disabled = false; button.textContent = "Update"; }
}

function signed(value, digits = 2) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)}%`;
}

function signedPoints(value, digits = 3) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)} pts`;
}

let historyTicker = null;
let historyRange = "1m";
let historyChartState = null;

function normalizeHistoryTicker(value) {
  const ticker = String(value || "").trim().toUpperCase();
  return ["BRK/B", "BRK.B", "BRK-B"].includes(ticker) ? "BRK/B" : ticker;
}

function savedHistoryStarts() {
  try { return JSON.parse(localStorage.getItem("sectorPulseHistoryStarts") || "{}"); }
  catch (_) { return {}; }
}

function savedHistoryComparisons() {
  try { return JSON.parse(localStorage.getItem("sectorPulseHistoryComparisons") || "{}"); }
  catch (_) { return {}; }
}

function customHistoryComparisons(ticker = historyTicker) {
  const saved = savedHistoryComparisons();
  return [...new Set((saved[ticker] || []).map(normalizeHistoryTicker))].slice(0, 3);
}

function saveHistoryComparisons(items) {
  const saved = savedHistoryComparisons();
  if (items.length) saved[historyTicker] = items;
  else delete saved[historyTicker];
  localStorage.setItem("sectorPulseHistoryComparisons", JSON.stringify(saved));
}

function historyDateLabel(value, includeYear = false) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, includeYear
    ? {month:"short", day:"numeric", year:"numeric"}
    : {month:"short", day:"numeric"});
}

function showHistoryPoint(index, showTooltip = false) {
  if (!historyChartState) return;
  const {points, coordinates, comparisons, svg} = historyChartState;
  const point = points[Math.max(0, Math.min(points.length - 1, index))];
  const coordinate = coordinates[Math.max(0, Math.min(coordinates.length - 1, index))];
  historyChartState.selected = Math.max(0, Math.min(points.length - 1, index));
  const cursor = $(".history-cursor", svg);
  if (cursor) cursor.setAttribute("x1", coordinate.x), cursor.setAttribute("x2", coordinate.x);
  $("#historySelectedPoint").textContent = `${historyDateLabel(point.date, true)} · ${signed(point.cumulativePct, 2)} period return · $${point.close.toFixed(2)} close · ${point.changePct == null ? "—" : signed(point.changePct, 2)} daily move`;
  const tooltip = $("#historyTooltip");
  if (!showTooltip) { tooltip.classList.add("hidden"); return; }
  const comparisonDetails = comparisons.map(item => {
    const comparisonPoint = item.byDate.get(point.date);
    return comparisonPoint ? `<br>${item.name}: ${signed(comparisonPoint.cumulativePct, 2)}` : "";
  }).join("");
  tooltip.innerHTML = `<strong>${historyDateLabel(point.date, true)}</strong>${signed(point.cumulativePct, 2)} period return<br>$${point.close.toFixed(2)} close · ${point.changePct == null ? "—" : signed(point.changePct, 2)} day${comparisonDetails}`;
  tooltip.classList.remove("hidden");
  const wrap = $(".history-chart-wrap");
  const svgBox = svg.getBoundingClientRect();
  const wrapBox = wrap.getBoundingClientRect();
  const scaledX = (coordinate.x / 900) * svgBox.width + svgBox.left - wrapBox.left;
  const scaledY = (coordinate.y / 360) * svgBox.height + svgBox.top - wrapBox.top;
  const tooltipWidth = tooltip.offsetWidth;
  tooltip.style.left = `${Math.max(4, Math.min(wrap.clientWidth - tooltipWidth - 4, scaledX - tooltipWidth / 2))}px`;
  tooltip.style.top = `${Math.max(4, scaledY - tooltip.offsetHeight - 12)}px`;
}

function renderHistoryChart(data) {
  const svg = $("#sectorHistoryChart");
  const points = data.points || [];
  const comparisons = data.comparisons || [];
  if (points.length < 2) throw new Error("Not enough daily observations are available for this range.");
  const width = 900, height = 360, left = 64, right = 18, top = 18, bottom = 42;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const primaryValues = points.map(point => Number(point.cumulativePct));
  const values = [...primaryValues, ...comparisons.flatMap(item => item.points.map(point => Number(point.cumulativePct)))];
  let low = Math.min(0, ...values), high = Math.max(0, ...values);
  const span = Math.max(high - low, 1);
  low -= span * .1; high += span * .1;
  const x = index => left + index / (points.length - 1) * plotWidth;
  const y = value => top + (high - value) / (high - low) * plotHeight;
  const coordinates = primaryValues.map((value, index) => ({x:x(index), y:y(value)}));
  const line = coordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const zeroY = y(0);
  const area = `${line} L${coordinates.at(-1).x.toFixed(2)},${zeroY.toFixed(2)} L${coordinates[0].x.toFixed(2)},${zeroY.toFixed(2)} Z`;
  const yTicks = Array.from({length:5}, (_, index) => low + index / 4 * (high - low));
  const xTickIndexes = [...new Set(Array.from({length:5}, (_, index) => Math.round(index / 4 * (points.length - 1))))];
  const pointIndex = new Map(points.map((point, index) => [point.date, index]));
  const comparisonSeries = comparisons.map((item, seriesIndex) => {
    const seriesPoints = item.points.filter(point => pointIndex.has(point.date));
    const seriesCoordinates = seriesPoints.map(point => ({x:x(pointIndex.get(point.date)), y:y(Number(point.cumulativePct))}));
    return {...item, seriesIndex, byDate:new Map(item.points.map(point => [point.date, point])), path:seriesCoordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ")};
  });
  svg.innerHTML = `<title id="historyChartTitle">${data.name} cumulative performance</title><desc id="historyChartDesc">${points.length} daily observations from ${historyDateLabel(points[0].date, true)} through ${historyDateLabel(points.at(-1).date, true)}.</desc><defs><linearGradient id="historyAreaGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#72b7ff" stop-opacity=".26"/><stop offset="1" stop-color="#72b7ff" stop-opacity=".02"/></linearGradient></defs>${yTicks.map(value => `<line class="history-grid" x1="${left}" y1="${y(value)}" x2="${width-right}" y2="${y(value)}"></line><text x="${left-10}" y="${y(value)+4}" text-anchor="end">${value>=0?"+":""}${value.toFixed(1)}%</text>`).join("")}<line class="history-zero" x1="${left}" y1="${zeroY}" x2="${width-right}" y2="${zeroY}"></line>${xTickIndexes.map(index => `<text x="${x(index)}" y="${height-13}" text-anchor="middle">${historyDateLabel(points[index].date)}</text>`).join("")}<path class="history-area" d="${area}"></path><path class="history-line" d="${line}"></path>${coordinates.map(point => `<circle class="history-point" cx="${point.x}" cy="${point.y}" r="${points.length > 100 ? 1.5 : 2.4}"></circle>`).join("")}<line class="history-cursor" x1="${coordinates.at(-1).x}" y1="${top}" x2="${coordinates.at(-1).x}" y2="${height-bottom}"></line><rect class="history-hit" x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}"></rect>`;
  const mainLine = $(".history-line", svg);
  comparisonSeries.forEach(item => {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", `history-comparison-line comparison-${item.seriesIndex}`);
    path.setAttribute("d", item.path);
    mainLine.before(path);
  });
  historyChartState = {points, coordinates, comparisons:comparisonSeries, svg, left, plotWidth, selected:points.length-1};
  showHistoryPoint(points.length - 1, false);
}

function applyLiveHistoryPoint(series, liveData) {
  const quote = [...(liveData?.sectors || []), ...(liveData?.benchmarks || [])].find(item => item.ticker === series.ticker);
  const liveDate = liveData?.marketDate;
  if (!quote || quote.price == null || quote.changePct == null || !liveDate || !series.points?.length) return;
  const points = series.points;
  const existingIndex = points.findIndex(point => point.date === liveDate);
  const priorIndex = existingIndex > 0 ? existingIndex - 1 : existingIndex < 0 ? points.length - 1 : -1;
  if (priorIndex < 0 || liveDate < points[priorIndex].date) return;
  const prior = points[priorIndex];
  const cumulativePct = ((1 + Number(prior.cumulativePct) / 100) * (1 + Number(quote.changePct) / 100) - 1) * 100;
  const livePoint = {date:liveDate, close:Number(quote.price), changePct:Number(quote.changePct), cumulativePct:Number(cumulativePct.toFixed(2))};
  if (existingIndex >= 0) points[existingIndex] = livePoint;
  else points.push(livePoint);
  series.latestDate = liveDate;
  series.latestClose = livePoint.close;
  series.latestChangePct = livePoint.changePct;
  series.periodReturnPct = livePoint.cumulativePct;
  series.liveAsOf = liveData.asOf;
}

async function loadSectorHistory(force = false) {
  if (!historyTicker) return;
  const error = $("#historyError");
  error.classList.add("hidden");
  $("#sectorHistoryChart").setAttribute("aria-busy", "true");
  try {
    const customStart = historyRange === "custom" ? $("#historyStartDate").value : "";
    const customComparisons = customHistoryComparisons();
    const liveRequest = fetch(apiUrl(`/api/contributions?force=${force ? 1 : 0}&tickers=${encodeURIComponent(customComparisons.join(","))}`)).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Live prices could not be loaded");
      return payload;
    }).catch(() => null);
    const defaults = historyTicker === "SPY" ? ["RSP", "^IXIC"] : ["SPY", "^IXIC"];
    const comparisonTickers = [...defaults, ...customComparisons.filter(ticker => ticker !== historyTicker && !defaults.includes(ticker))];
    const results = await Promise.allSettled([historyTicker, ...comparisonTickers].map(async ticker => {
      const response = await fetch(apiUrl(`/api/sector-history?ticker=${encodeURIComponent(ticker)}&range=${historyRange}&start=${encodeURIComponent(customStart)}&force=${force ? 1 : 0}`));
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `${ticker} history could not be loaded`);
      return payload;
    }));
    if (results[0].status === "rejected") throw results[0].reason;
    const data = results[0].value;
    const comparisonLabels = {"SPY":"S&P 500 / SPY","RSP":"RSP (Equal Weight)","^IXIC":"Nasdaq Composite"};
    data.comparisons = results.slice(1).flatMap((result, index) => result.status === "fulfilled" ? [{...result.value,name:comparisonLabels[result.value.ticker] || result.value.name,custom:customComparisons.includes(comparisonTickers[index])}] : []);
    const failedCustom = results.slice(1).flatMap((result, index) => result.status === "rejected" && customComparisons.includes(comparisonTickers[index]) ? [comparisonTickers[index]] : []);
    if (failedCustom.length) {
      error.textContent = `No history was available for ${failedCustom.join(", ")}.`;
      error.classList.remove("hidden");
    }
    const liveData = await liveRequest;
    if (liveData) {
      applyLiveHistoryPoint(data, liveData);
      data.comparisons.forEach(item => applyLiveHistoryPoint(item, liveData));
    }
    $("#historyTitle").textContent = `${data.name} (${data.ticker})`;
    $("#historySubtitle").textContent = `${data.points.length} daily closes · ${data.liveAsOf ? `live through ${formatTime(data.liveAsOf)}` : `through ${historyDateLabel(data.latestDate, true)}`}`;
    const period = $("#historyPeriodReturn"); period.textContent = signed(data.periodReturnPct, 2); period.className = data.periodReturnPct >= 0 ? "positive" : "negative";
    $("#historyLatestClose").textContent = `$${Number(data.latestClose).toFixed(2)}`;
    const move = $("#historyLatestMove"); move.textContent = signed(data.latestChangePct, 2); move.className = data.latestChangePct >= 0 ? "positive" : "negative";
    $("#historyComparisons").innerHTML = data.comparisons.map((item, index) => `<span class="comparison-${index}"><i aria-hidden="true"></i>${item.ticker === "^IXIC" ? "Nasdaq Comp." : item.ticker} <b>${signed(item.periodReturnPct, 2)}</b>${item.custom ? `<button type="button" class="history-comparison-remove" data-remove-comparison="${item.ticker}" aria-label="Remove ${item.ticker} comparison">&times;</button>` : ""}</span>`).join("");
    $$('[data-history-range]').forEach(button => button.classList.toggle("active", button.dataset.historyRange === historyRange));
    renderHistoryChart(data);
    smartRefreshAt.history = Date.now();
  } catch (failure) {
    error.textContent = failure.message;
    error.classList.remove("hidden");
  } finally { $("#sectorHistoryChart").removeAttribute("aria-busy"); }
}

function openSectorHistory(ticker) {
  historyTicker = normalizeHistoryTicker(ticker);
  const customStart = savedHistoryStarts()[ticker] || "";
  historyRange = customStart ? "custom" : "1m";
  $("#historyStartDate").value = customStart;
  $("#historyStartDate").max = new Date().toISOString().slice(0, 10);
  $("#historyTitle").textContent = `${ticker} history`;
  $("#historyComparisons").innerHTML = "";
  $("#historyComparisonInput").value = "";
  $("#historySubtitle").textContent = "Loading daily closes…";
  const dialog = $("#sectorHistoryDialog");
  if (!dialog.open) dialog.showModal();
  loadSectorHistory(false);
}

function polarPoint(cx, cy, radius, angle) {
  const radians = (angle - 90) * Math.PI / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
}

function donutPath(startAngle, endAngle, outerRadius = 190, innerRadius = 112) {
  const startOuter = polarPoint(210, 210, outerRadius, endAngle);
  const endOuter = polarPoint(210, 210, outerRadius, startAngle);
  const startInner = polarPoint(210, 210, innerRadius, startAngle);
  const endInner = polarPoint(210, 210, innerRadius, endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${startOuter.x} ${startOuter.y} A ${outerRadius} ${outerRadius} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y} L ${startInner.x} ${startInner.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 1 ${endInner.x} ${endInner.y} Z`;
}

function performanceColor(value, max) {
  const linearStrength = Math.min(1, Math.abs(value) / Math.max(max, 0.001));
  const strength = Math.sqrt(linearStrength);
  const hue = value >= 0 ? 145 : 25;
  const lightness = value >= 0
    ? 42 + (1 - strength) * 40
    : 42 + (1 - strength) * 44;
  const chroma = value >= 0 ? 0.17 : 0.10 + strength * 0.10;
  return `oklch(${lightness}% ${chroma} ${hue})`;
}

const sectorWheelOrder = ["XLC", "XLY", "XLP", "XLE", "XLF", "XLV", "XLI", "XLB", "XLRE", "XLK", "XLU"];

function savedSectorWheelOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem("sectorPulseDonutOrder") || "[]");
    const valid = saved.filter(ticker => sectorWheelOrder.includes(ticker));
    return [...new Set([...valid, ...sectorWheelOrder])];
  } catch (_) {
    return [...sectorWheelOrder];
  }
}

function renderContributionDonut(data) {
  const svg = $("#contributionDonut");
  const legend = $("#donutLegend");
  const center = $("#donutCenter");
  const sortButtons = $$('[data-wheel-sort]');
  svg.innerHTML = ""; legend.innerHTML = "";
  const wheelOrder = savedSectorWheelOrder();
  const wheelItems = [...data.sectors].sort((a, b) => wheelOrder.indexOf(a.ticker) - wheelOrder.indexOf(b.ticker));
  const savedMode = localStorage.getItem("sectorPulseDonutOrderMode") || "custom";
  sortButtons.forEach(button => {
    button.classList.toggle("active", button.dataset.wheelSort === savedMode);
    button.onclick = () => {
      const field = button.dataset.wheelSort === "market" ? "weightPct" : "equalWeightPct";
      const order = [...data.sectors].sort((a, b) => b[field] - a[field]).map(item => item.ticker);
      localStorage.setItem("sectorPulseDonutOrder", JSON.stringify(order));
      localStorage.setItem("sectorPulseDonutOrderMode", button.dataset.wheelSort);
      renderContributionDonut(data);
    };
  });
  const totalWeight = wheelItems.reduce((sum, item) => sum + item.weightPct, 0);
  const maxMove = Math.max(...wheelItems.map(item => Math.abs(item.changePct)), 0.001);
  const centerStrength = Math.min(0.58, 0.14 + Math.abs(data.spyChangePct) / 2 * 0.44);
  const centerRgb = data.spyChangePct >= 0 ? "53,198,107" : "255,88,100";
  center.style.background = `radial-gradient(circle, rgba(${centerRgb},${centerStrength}) 0%, rgba(${centerRgb},${centerStrength * 0.55}) 45%, #0d151f 78%)`;
  center.style.boxShadow = `inset 0 0 0 1px rgba(${centerRgb},.55), 0 0 28px rgba(${centerRgb},${centerStrength * 0.35})`;
  let angle = 0;
  const resetCenter = () => {
    center.innerHTML = `<span>S&amp;P / SPY TODAY</span><strong>${signed(data.spyChangePct, 2)}</strong><small>Hover or focus a sector</small>`;
  };
  const showSector = item => {
    center.innerHTML = `<span>${item.ticker} · ${item.name}</span><strong>${signed(item.changePct, 2)}</strong><small>${signedPoints(item.contributionPct, 3)} Index Impact · ${item.weightPct.toFixed(1)}% weight</small>`;
  };
  resetCenter();
  let draggedLegendItem = null;
  wheelItems.forEach(item => {
    const sweep = item.weightPct / totalWeight * 360;
    const gap = Math.min(0.7, sweep / 4);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const color = performanceColor(item.changePct, maxMove);
    path.setAttribute("d", donutPath(angle + gap, angle + sweep - gap));
    path.setAttribute("fill", color);
    path.setAttribute("tabindex", "0");
    path.setAttribute("role", "button");
    path.setAttribute("aria-label", `${item.name}: ${signedPoints(item.contributionPct, 3)} Index Impact, ${item.weightPct.toFixed(1)} percent weight`);
    path.addEventListener("mouseenter", () => showSector(item));
    path.addEventListener("mouseleave", resetCenter);
    path.addEventListener("focus", () => showSector(item));
    path.addEventListener("blur", resetCenter);
    if (historyEnabled) path.addEventListener("click", () => openSectorHistory(item.ticker));
    svg.append(path);
    const legendItem = document.createElement("button");
    legendItem.className = "donut-legend-item";
    legendItem.draggable = true;
    legendItem.dataset.ticker = item.ticker;
    legendItem.title = `Drag ${item.name} to change its position in the wheel`;
    legendItem.innerHTML = `<em aria-hidden="true">⋮⋮</em><i style="background:${color}"></i><span><strong>${item.ticker}</strong>${item.name}</span><div class="donut-legend-values"><b>${signed(item.changePct, 2)}</b><small>${signedPoints(item.contributionPct, 3)}</small></div>`;
    legendItem.addEventListener("mouseenter", () => { showSector(item); path.classList.add("active"); });
    legendItem.addEventListener("mouseleave", () => { resetCenter(); path.classList.remove("active"); });
    legendItem.addEventListener("focus", () => { showSector(item); path.classList.add("active"); });
    legendItem.addEventListener("blur", () => { resetCenter(); path.classList.remove("active"); });
    if (historyEnabled) legendItem.addEventListener("click", () => openSectorHistory(item.ticker));
    legendItem.addEventListener("dragstart", event => {
      draggedLegendItem = legendItem;
      legendItem.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    legendItem.addEventListener("dragover", event => {
      if (!draggedLegendItem || draggedLegendItem === legendItem) return;
      event.preventDefault();
      const box = legendItem.getBoundingClientRect();
      const before = event.clientY < box.top + box.height / 2 ||
        (Math.abs(event.clientY - (box.top + box.height / 2)) < box.height / 3 && event.clientX < box.left + box.width / 2);
      legend.insertBefore(draggedLegendItem, before ? legendItem : legendItem.nextSibling);
    });
    legendItem.addEventListener("dragend", () => {
      if (!draggedLegendItem) return;
      draggedLegendItem.classList.remove("dragging");
      draggedLegendItem = null;
      const order = [...legend.querySelectorAll(".donut-legend-item")].map(node => node.dataset.ticker);
      localStorage.setItem("sectorPulseDonutOrder", JSON.stringify(order));
      localStorage.setItem("sectorPulseDonutOrderMode", "custom");
      renderContributionDonut(data);
    });
    legend.append(legendItem);
    angle += sweep;
  });
}

function renderContributionBars(data) {
  contributionDisplaySnapshot = data;
  $$('[data-bar-period]').forEach(button => button.classList.toggle("active", button.dataset.barPeriod === contributionPeriod));
  const isPerformance = contributionChartMode === "performance";
  const impactLabel = data.annualized ? "Est. Ann. S&P Index Impact" : data.estimated ? "Est. S&P Index Impact" : "S&P Index Impact";
  const metric = isPerformance ? "changePct" : "contributionPct";
  const items = [...data.sectors].sort((a, b) => b.changePct - a.changePct);
  const max = Math.max(...items.map(item => Math.abs(item[metric])), isPerformance ? 0.01 : 0.001);
  const minItem = items.reduce((lowest, item) => item[metric] < lowest[metric] ? item : lowest, items[0]);
  const maxItem = items.reduce((highest, item) => item[metric] > highest[metric] ? item : highest, items[0]);
  const displayValue = value => isPerformance ? signed(value, 2) : signedPoints(value, 3);
  $("#barAxisLeft").textContent = `${isPerformance ? "Largest decline" : "Largest drag"} ${displayValue(minItem[metric])}`;
  $("#barAxisCenter").textContent = isPerformance ? (data.annualized ? "Annualized sector total return (%)" : data.estimated ? "Sector total return (%)" : "Sector daily change (%)") : `${impactLabel} (percentage points)`;
  $("#barAxisNote").textContent = isPerformance && data.estimated ? `Includes distributions${data.annualized ? " · CAGR" : ""}` : "";
  $("#barAxisRight").textContent = `${isPerformance ? "Largest gain" : "Largest lift"} ${displayValue(maxItem[metric])}`;
  $$('[data-bar-mode]').forEach(button => button.classList.toggle("active", button.dataset.barMode === contributionChartMode));
  $("#barImpactMode").textContent = impactLabel;
  const chart = $("#contributionChart");
  const existingRows = new Map([...chart.children].map(row => [row.dataset.ticker, row]));
  const oldPositions = new Map([...chart.children].map(row => [row.dataset.ticker, row.getBoundingClientRect().top]));
  items.forEach(item => {
    let row = existingRows.get(item.ticker);
    if (!row) {
      const row = document.createElement("div");
      row.dataset.ticker = item.ticker;
      row.className = `contribution-row ${item.changePct >= 0 ? "positive" : "negative"}`;
      row.innerHTML = `<div class="contribution-track"><button type="button" class="bar-sector-label" aria-label="Open ${item.name} history"><strong>${item.name}</strong><small>${item.ticker}</small></button><i style="width:0;left:50%"></i><span class="bar-number-group" style="left:calc(50% + 8px)"><strong class="bar-daily-change"></strong><small class="bar-context"><b></b><span></span></small></span></div>`;
      if (historyEnabled) $(".bar-sector-label", row).addEventListener("click", () => openSectorHistory(item.ticker));
      existingRows.set(item.ticker, row);
    }
    chart.append(existingRows.get(item.ticker));
  });
  const movedRows = items.map(item => {
    const row = existingRows.get(item.ticker);
    const oldTop = oldPositions.get(item.ticker);
    const delta = oldTop == null ? 0 : oldTop - row.getBoundingClientRect().top;
    if (delta) { row.style.transition = "none"; row.style.transform = `translateY(${delta}px)`; }
    return {row, delta};
  });
  if (movedRows.some(item => item.delta)) void chart.offsetHeight;
  const updateBars = () => items.forEach((item, index) => {
    const value = item[metric];
    const positive = value >= 0;
    const width = Math.abs(value) / max * 30;
    const row = chart.children[index];
    const bar = $(".contribution-track i", row);
    const numberGroup = $(".bar-number-group", row);
    row.className = `contribution-row ${positive ? "positive" : "negative"}`;
    bar.style.width = `${width}%`;
    bar.style.left = positive ? "50%" : "auto";
    bar.style.right = positive ? "auto" : "50%";
    numberGroup.style.left = positive ? `calc(50% + ${width}% + 8px)` : "auto";
    numberGroup.style.right = positive ? "auto" : `calc(50% + ${width}% + 8px)`;
    numberGroup.style.maxWidth = `calc(${50 - width}% - 16px)`;
    $(".bar-daily-change", row).textContent = displayValue(value);
    const supportingValue = isPerformance ? signedPoints(item.contributionPct, 3) : signed(item.changePct, 2);
    const supportingLabel = isPerformance ? impactLabel : (data.estimated ? "sector period change" : "sector change");
    $(".bar-context b", row).textContent = `${supportingValue} ${supportingLabel}`;
    $(".bar-context span", row).textContent = `${item.weightPct.toFixed(1)}% market weight`;
  });
  updateBars();
  requestAnimationFrame(() => movedRows.forEach(({row, delta}) => {
    if (!delta) return;
    row.style.transition = "transform .58s cubic-bezier(.2,.8,.2,1)";
    row.style.transform = "translateY(0)";
  }));
}

function renderBenchmarkReturns(items, periodLabel) {
  const benchmarkIds = {SPY:"spy", RSP:"rsp", COWZ:"cowz", QQQ:"qqq"};
  const benchmarkNames = {SPY:"S&P / SPY", RSP:"RSP", COWZ:"COWZ", QQQ:"QQQ"};
  (items || []).forEach(item => {
    const prefix = benchmarkIds[item.ticker];
    if (!prefix) return;
    $(`#${prefix}BenchmarkLabel`).textContent = `${benchmarkNames[item.ticker]} ${periodLabel}`;
    const change = $(`#${prefix}ContributionChange`);
    change.textContent = signed(item.changePct, 2);
    change.className = item.changePct >= 0 ? "positive" : "negative";
    if (item.price != null) $(`#${prefix}BenchmarkPrice`).textContent = `$${Number(item.price).toFixed(2)}`;
  });
}

function renderContributions(data) {
  contributionSnapshot = data;
  if (contributionPeriod === "today") { renderBenchmarkReturns(data.benchmarks, "today"); updateAnnualizeControl(null); }
  $("#contributionAsOf").textContent = formatTime(data.asOf);
  if (contributionPeriod === "today") $("#contributionMethod").textContent = data.methodology;
  $("#contributionSource").textContent = `Data source: ${data.source}${data.cached ? " · cached" : ""}`;
  if (contributionPeriod === "today") renderContributionBars(data);
  renderContributionDonut(data);
  contributionsLoaded = true;
}

function applyPeriodPerformance(data) {
  contributionPeriodSnapshot = data;
  updateAnnualizeControl(data);
  const displayData = periodDisplayData(data);
  $("#barPeriodStatus").textContent = `${historyDateLabel(data.startDate)} – ${historyDateLabel(data.endDate, true)}`;
  $("#contributionMethod").textContent = `${data.methodology}${displayData.annualized ? " Returns use CAGR; impact components are proportionally scaled to the annualized S&P / SPY return." : ""}`;
  const baseLabel = contributionPeriod === "custom" ? `since ${historyDateLabel(data.startDate)}` : contributionPeriod.toUpperCase();
  renderBenchmarkReturns(displayData.benchmarks, `${baseLabel}${displayData.annualized ? " ann." : ""}`);
  renderContributionBars(displayData);
}

async function loadPeriodPerformance(force = false) {
  $$('[data-bar-period]').forEach(button => button.classList.toggle("active", button.dataset.barPeriod === contributionPeriod));
  if (contributionPeriod === "today") {
    contributionPeriodSnapshot = null;
    updateAnnualizeControl(null);
    $("#barPeriodStatus").textContent = "Today";
    if (contributionSnapshot) {
      $("#contributionMethod").textContent = contributionSnapshot.methodology;
      renderBenchmarkReturns(contributionSnapshot.benchmarks, "today");
      renderContributionBars(contributionSnapshot);
    }
    return;
  }
  const customStart = contributionPeriod === "custom" ? $("#barCustomStart").value : "";
  $$('[data-bar-period]').forEach(button => button.disabled = true);
  $("#barPeriodStatus").textContent = "Loading…";
  try {
    const response = await fetch(apiUrl(`/api/period-impact?range=${contributionPeriod}&start=${encodeURIComponent(customStart)}&force=${force ? 1 : 0}`));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Period performance could not be loaded");
    applyPeriodPerformance(data);
  } catch (error) {
    $("#contributionError").textContent = error.message;
    $("#contributionError").classList.remove("hidden");
    $("#barPeriodStatus").textContent = "Unavailable";
  } finally { $$('[data-bar-period]').forEach(button => button.disabled = false); }
}

async function loadContributions(force = false) {
  if (contributionLoading) return;
  contributionLoading = true;
  const button = $("#contributionRefresh");
  button.disabled = true; button.textContent = "Loading…"; $("#contributionError").classList.add("hidden");
  try {
    const response = await fetch(apiUrl(`/api/contributions?force=${force ? 1 : 0}`));
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unknown contribution error");
    renderContributions(data);
    smartRefreshAt.contribution = Date.now();
    if (contributionPeriod !== "today") await loadPeriodPerformance(force);
  } catch (error) {
    $("#contributionError").textContent = error.message;
    $("#contributionError").classList.remove("hidden");
  } finally { contributionLoading = false; button.disabled = false; button.textContent = "↻ Refresh"; }
}

function activateTab(button, persist = true) {
  $$('.tab').forEach(tab => tab.classList.toggle("active", tab === button));
  $("#momentumView").classList.toggle("active", button.dataset.tab === "momentum");
  $("#valuationView").classList.toggle("active", button.dataset.tab === "valuation");
  $("#contributionView").classList.toggle("active", button.dataset.tab === "contribution");
  if (persist) localStorage.setItem("sectorPulseActiveTab", button.dataset.tab);
  if (button.dataset.tab === "valuation" && !valuationsLoaded) loadValuations(false);
  if (button.dataset.tab === "contribution" && !contributionsLoaded) loadContributions(false);
  setTimeout(smartRefreshActiveTab, 0);
}

const defaultTabOrder = staticMode
  ? ["contribution", "momentum", "valuation"]
  : ["momentum", "valuation", "contribution"];
let suppressTabClick = false;

function restoreTabOrder() {
  const tabs = $(".tabs");
  let saved = [];
  try { saved = staticMode ? [] : JSON.parse(localStorage.getItem("sectorPulseTabOrder") || "[]"); } catch (_) { saved = []; }
  const order = [...new Set([...saved.filter(name => defaultTabOrder.includes(name)), ...defaultTabOrder])];
  const byName = new Map($$(".tab", tabs).map(tab => [tab.dataset.tab, tab]));
  order.forEach(name => tabs.append(byName.get(name)));
}

function configureTabDragging() {
  const tabs = $(".tabs");
  let draggedTab = null;
  $$(".tab", tabs).forEach(tab => {
    tab.draggable = true;
    tab.title = "Drag to change this tab's position";
    tab.addEventListener("dragstart", event => {
      draggedTab = tab;
      suppressTabClick = true;
      tab.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
    });
    tab.addEventListener("dragend", () => {
      if (!draggedTab) return;
      draggedTab.classList.remove("dragging");
      draggedTab = null;
      const order = $$(".tab", tabs).map(item => item.dataset.tab);
      localStorage.setItem("sectorPulseTabOrder", JSON.stringify(order));
      setTimeout(() => { suppressTabClick = false; }, 0);
    });
  });
  tabs.addEventListener("dragover", event => {
    if (!draggedTab) return;
    event.preventDefault();
    const target = event.target.closest(".tab");
    if (!target || target === draggedTab) return;
    const box = target.getBoundingClientRect();
    tabs.insertBefore(draggedTab, event.clientX < box.left + box.width / 2 ? target : target.nextSibling);
  });
}

restoreTabOrder();
configureTabDragging();
$$('.tab').forEach(button => button.addEventListener("click", () => {
  if (!suppressTabClick) activateTab(button);
}));
$("#contributionRefresh").addEventListener("click", () => loadContributions(true));
const savedBarCustomStart = localStorage.getItem("sectorPulseBarCustomStart") || "";
$("#barCustomStart").value = savedBarCustomStart;
$("#barCustomStart").max = new Date().toISOString().slice(0, 10);
$("#barAnnualize").checked = localStorage.getItem("sectorPulseAnnualizeLong") === "1";
$("#barAnnualize").disabled = true;
$("#barAnnualize").addEventListener("change", event => {
  localStorage.setItem("sectorPulseAnnualizeLong", event.target.checked ? "1" : "0");
  if (contributionPeriodSnapshot) applyPeriodPerformance(contributionPeriodSnapshot);
});
$$('[data-bar-period]').forEach(button => button.addEventListener("click", () => {
  const period = button.dataset.barPeriod;
  if (period === "custom" && !$("#barCustomStart").value) { $("#barCustomStart").focus(); return; }
  contributionPeriod = period;
  $("#contributionError").classList.add("hidden");
  loadPeriodPerformance(false);
  setTimeout(smartRefreshActiveTab, 0);
}));
$("#barCustomStart").addEventListener("change", event => {
  if (event.target.value) {
    localStorage.setItem("sectorPulseBarCustomStart", event.target.value);
    contributionPeriod = "custom";
  } else {
    localStorage.removeItem("sectorPulseBarCustomStart");
    contributionPeriod = "today";
  }
  loadPeriodPerformance(false);
});
if (historyEnabled) $$('[data-history-ticker]').forEach(button => button.addEventListener("click", () => openSectorHistory(button.dataset.historyTicker)));
$$('[data-history-range]').forEach(button => button.addEventListener("click", () => {
  const range = button.dataset.historyRange;
  if (range === "custom" && !$("#historyStartDate").value) { $("#historyStartDate").focus(); return; }
  historyRange = range;
  loadSectorHistory(false);
}));
$("#historyStartDate").addEventListener("change", event => {
  if (!historyTicker) return;
  const starts = savedHistoryStarts();
  if (event.target.value) {
    starts[historyTicker] = event.target.value;
    historyRange = "custom";
  } else {
    delete starts[historyTicker];
    historyRange = "1m";
  }
  localStorage.setItem("sectorPulseHistoryStarts", JSON.stringify(starts));
  loadSectorHistory(false);
});
function addHistoryComparison() {
  const input = $("#historyComparisonInput");
  const ticker = normalizeHistoryTicker(input.value);
  const compact = ticker.replaceAll("-", "").replaceAll(".", "").replaceAll("^", "").replaceAll("=", "").replaceAll("/", "");
  const defaults = historyTicker === "SPY" ? ["RSP", "^IXIC"] : ["SPY", "^IXIC"];
  const current = customHistoryComparisons();
  let message = "";
  if (!ticker || ticker.length > 20 || !/^[A-Z0-9]+$/.test(compact)) message = "Enter a valid ticker symbol.";
  else if (ticker === historyTicker || defaults.includes(ticker) || current.includes(ticker)) message = `${ticker} is already shown.`;
  else if (current.length >= 3) message = "Remove a custom comparison before adding another.";
  input.setCustomValidity(message);
  if (message) { input.reportValidity(); return; }
  saveHistoryComparisons([...current, ticker]);
  input.value = "";
  loadSectorHistory(false);
}
$("#historyComparisonAdd").addEventListener("click", addHistoryComparison);
$("#historyComparisonInput").addEventListener("input", event => event.target.setCustomValidity(""));
$("#historyComparisonInput").addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addHistoryComparison(); } });
$("#historyComparisons").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-comparison]");
  if (!button) return;
  saveHistoryComparisons(customHistoryComparisons().filter(ticker => ticker !== button.dataset.removeComparison));
  loadSectorHistory(false);
});
const historyTickerLookup = $("#historyTickerLookup");
const historyTickerOpen = $("#historyTickerOpen");
if (historyEnabled && historyTickerLookup && historyTickerOpen) {
  const allowed = new Set((runtimeConfig.historyTickers || []).map(normalizeHistoryTicker));
  const openLookup = () => {
    const ticker = normalizeHistoryTicker(historyTickerLookup.value);
    const message = !ticker ? "Enter a ticker symbol." : allowed.size && !allowed.has(ticker) ? "That ticker is not in the daily history list." : "";
    historyTickerLookup.setCustomValidity(message);
    if (message) { historyTickerLookup.reportValidity(); return; }
    historyTickerLookup.value = ticker;
    openSectorHistory(ticker);
  };
  historyTickerOpen.addEventListener("click", openLookup);
  historyTickerLookup.addEventListener("input", event => event.target.setCustomValidity(""));
  historyTickerLookup.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); openLookup(); }
  });
}
const sectorHistoryChart = $("#sectorHistoryChart");
sectorHistoryChart.addEventListener("mousemove", event => {
  if (!historyChartState) return;
  const box = sectorHistoryChart.getBoundingClientRect();
  const viewX = (event.clientX - box.left) / box.width * 900;
  const index = Math.round((viewX - historyChartState.left) / historyChartState.plotWidth * (historyChartState.points.length - 1));
  showHistoryPoint(index, true);
});
sectorHistoryChart.addEventListener("mouseleave", () => $("#historyTooltip").classList.add("hidden"));
sectorHistoryChart.addEventListener("keydown", event => {
  if (!historyChartState || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? historyChartState.points.length - 1 : historyChartState.selected + (event.key === "ArrowLeft" ? -1 : 1);
  showHistoryPoint(next, false);
});
$("#sectorHistoryDialog").addEventListener("close", () => $("#historyTooltip").classList.add("hidden"));
$$('[data-bar-mode]').forEach(button => button.addEventListener("click", () => {
  contributionChartMode = button.dataset.barMode;
  if (contributionDisplaySnapshot) renderContributionBars(contributionDisplaySnapshot);
}));
const contributionChartShell = $(".contribution-chart-shell");
const chartFitButton = $("#chartFitButton");
if (!document.fullscreenEnabled) {
  chartFitButton.hidden = true;
} else {
  chartFitButton.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement === contributionChartShell) await document.exitFullscreen();
      else await contributionChartShell.requestFullscreen();
    } catch (error) {
      $("#contributionError").textContent = `Could not open the fitted chart: ${error.message}`;
      $("#contributionError").classList.remove("hidden");
    }
  });
  document.addEventListener("fullscreenchange", () => {
    const active = document.fullscreenElement === contributionChartShell;
    chartFitButton.textContent = active ? "⛶ Exit fit" : "⛶ Fit screen";
    chartFitButton.setAttribute("aria-pressed", String(active));
  });
}
const valuationRefreshButton = $("#valuationRefresh");
const watchlistInput = $("#watchlistInput");
if (valuationRefreshButton && watchlistInput) {
  valuationRefreshButton.addEventListener("click", () => loadValuations(true));
  watchlistInput.value = localStorage.getItem("sectorPulseWatchlist") || "RSPH, KIE, KCE, IGF";
}

const savedTabName = staticMode ? "contribution" : localStorage.getItem("sectorPulseActiveTab");
const savedTab = $$('.tab').find(button => button.dataset.tab === savedTabName);
if (savedTab) activateTab(savedTab, false);
document.addEventListener("visibilitychange", () => { if (!document.hidden) smartRefreshActiveTab(); });
window.addEventListener("focus", smartRefreshActiveTab);
configureTimer();
if (staticMode) loadContributions(false);
else load(false);
