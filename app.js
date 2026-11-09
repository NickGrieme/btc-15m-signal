/*
 * BTC 15-Minute Signal Desk
 * Complete app.js replacement.
 *
 * Data sources:
 * - Coinbase / Binance.US: 1-minute technical candles only
 * - Polymarket Gamma: active event and outcome token IDs
 * - Polymarket CLOB: UP and DOWN best asks
 * - Polymarket RTDS: Chainlink BTC/USD and Chainlink 60-second TWAP
 * - Cloudflare Worker: paper-signal accuracy logging only
 *
 * This application is paper-only. It never submits real orders.
 */

"use strict";

const $ = id => document.getElementById(id);

const STORE_KEY = "btc15m_paper_trades_v1";
const OPENING_REFERENCE_KEY = "btc15m_opening_refs_v2";
const LEGACY_OPENING_REFERENCE_KEY = "btc15m_opening_refs_v1";
const ROUND_SECONDS = 900;
const TWAP_WINDOW_SECONDS = 60;
const MAX_REFERENCE_ROUNDS = 96;
const DATA_FRESH_MS = 30000;
const RTDS_URL = "wss://ws-live-data.polymarket.com";
const WORKER_URL = "https://btc-15m-accuracy.nicholasgrieme.workers.dev";

let latest = null;
let latestCandles = null;
let currentMarket = null;
let manualReference = null;

let officialReference = null;
let officialReferenceRound = null;
let officialReferenceStatus = "Waiting for Polymarket's official opening reference.";

let chainlinkPrice = null;
let chainlinkAt = 0;
let chainlinkSourceAt = 0;

let twapPrice = null;
let twapAt = 0;
let twapSourceAt = 0;
let twapHistory = [];

let openingReferences = loadOpeningReferences();

let lastRecordedKey = null;
let lastSignalAttempt = {};
let refreshBusy = false;
let rtdsSocket = null;
let rtdsReconnectTimer = null;
let rtdsConnected = false;

function safeGet(id) {
  const element = $(id);
  if (!element) console.warn(`Dashboard element not found: #${id}`);
  return element;
}

function setText(id, value) {
  const element = $(id);
  if (element) element.textContent = value;
}

function num(id, fallback = 0) {
  const element = $(id);
  if (!element) return fallback;
  const value = Number(element.value);
  return Number.isFinite(value) ? value : fallback;
}

function loadOpeningReferences() {
  try {
    const currentRaw = localStorage.getItem(OPENING_REFERENCE_KEY);
    if (currentRaw !== null) {
      const current = JSON.parse(currentRaw);
      if (current && typeof current === "object" && !Array.isArray(current)) return current;
    }

    // Migrate values previously saved by the first version of the capture code.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_OPENING_REFERENCE_KEY) || "{}");
    return legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy : {};
  } catch (error) {
    console.warn("Could not load saved opening references:", error);
    return {};
  }
}

function saveOpeningReferences() {
  const keys = Object.keys(openingReferences)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => b - a);

  for (const key of keys.slice(MAX_REFERENCE_ROUNDS)) {
    delete openingReferences[String(key)];
  }

  try {
    localStorage.setItem(OPENING_REFERENCE_KEY, JSON.stringify(openingReferences));
  } catch (error) {
    console.warn("Could not save opening references:", error);
  }
}

function getExpectedRound() {
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % ROUND_SECONDS);
  return {
    start,
    end: start + ROUND_SECONDS,
    slug: `btc-updown-15m-${start}`
  };
}

function getReference() {
  if (!currentMarket) return null;

  if (
    officialReferenceRound === currentMarket.start &&
    Number.isFinite(officialReference) &&
    officialReference > 0
  ) {
    return officialReference;
  }

  return manualReference;
}
async function fetchOfficialReference(roundStart) {
  if (
    officialReferenceRound === roundStart &&
    Number.isFinite(officialReference) &&
    officialReference > 0
  ) {
    return officialReference;
  }

  officialReferenceStatus = "Checking Polymarket for official opening reference...";

  try {
    const response = await fetch(
      `${WORKER_URL}/reference?start=${roundStart}`,
      { cache: "no-store" }
    );

    const data = await response.json();

    if (!response.ok || data.ok !== true) {
      officialReferenceStatus = data.error || "Official reference not published yet.";
      console.log("Official reference pending:", officialReferenceStatus);
      return null;
    }

    const price = Number(data.openPrice);

    if (!Number.isFinite(price) || price <= 0) {
      officialReferenceStatus = "Invalid official reference received.";
      return null;
    }

    officialReference = price;
    officialReferenceRound = roundStart;
    officialReferenceStatus = `Official Polymarket reference: $${price.toFixed(2)}`;

    console.log("OFFICIAL POLYMARKET OPENING REFERENCE:", {
      roundStart,
      price,
      source: data.source
    });

    const referenceInput = $("reference");

    if (referenceInput && document.activeElement !== referenceInput) {
      referenceInput.value = price.toFixed(2);
    }

    if (latestCandles) {
      latest = analyze(latestCandles);
      render();
    }

    return price;

  } catch (error) {
    officialReferenceStatus = `Reference lookup failed: ${error.message}`;
    console.warn(officialReferenceStatus);
    return null;
  }
}
function fmtMoney(value) {
  return "$" + Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function getTrades() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function saveTrades(trades) {
  localStorage.setItem(STORE_KEY, JSON.stringify(trades));
}

function iso(timestampSeconds) {
  return new Date(timestampSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function getJSON(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCandles() {
  const sources = [
    {
      url: "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60",
      parse: raw => raw
        .map(row => ({
          time: Number(row[0]) * 1000,
          low: Number(row[1]),
          high: Number(row[2]),
          open: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5])
        }))
        .reverse()
    },
    {
      url: "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100",
      parse: raw => raw.map(row => ({
        time: Number(row[0]),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5])
      }))
    }
  ];

  let lastError = null;

  for (const source of sources) {
    try {
      const raw = await getJSON(source.url);
      const candles = source.parse(raw).filter(candle =>
        Number.isFinite(candle.close) &&
        candle.close > 0 &&
        Number.isFinite(candle.volume) &&
        Number.isFinite(candle.time)
      );

      if (candles.length >= 30) return candles.slice(-100);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Public BTC candle feeds unavailable");
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function bestAsk(book) {
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const prices = asks
    .map(level => Number(level.price))
    .filter(price => Number.isFinite(price) && price > 0 && price < 1);

  return prices.length ? Math.min(...prices) : null;
}

async function fetchPolymarket() {
  const round = getExpectedRound();

  const events = await getJSON(
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(round.slug)}`
  );

  if (!Array.isArray(events) || !events.length) {
    throw new Error(`Polymarket has not returned ${round.slug} yet`);
  }

  const event = events[0];
  const markets = Array.isArray(event.markets) ? event.markets : [];

  if (!markets.length) throw new Error("Active event has no market data yet");

  const market = markets[0];
  const outcomes = parseArray(market.outcomes);
  const tokens = parseArray(market.clobTokenIds);
  const tokenBySide = {};

  outcomes.forEach((outcome, index) => {
    if (tokens[index]) tokenBySide[String(outcome).trim().toLowerCase()] = tokens[index];
  });

  if (!tokenBySide.up || !tokenBySide.down) {
    throw new Error("Could not identify both UP and DOWN Polymarket tokens");
  }

  const [upBookResult, downBookResult] = await Promise.allSettled([
    getJSON(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenBySide.up)}`),
    getJSON(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenBySide.down)}`)
  ]);

  const upBook = upBookResult.status === "fulfilled" ? upBookResult.value : null;
  const downBook = downBookResult.status === "fulfilled" ? downBookResult.value : null;
  const upPrice = bestAsk(upBook);
  const downPrice = bestAsk(downBook);
  const savedReference = Number(openingReferences[String(round.start)]);
  const hasReference = Number.isFinite(savedReference) && savedReference > 0;

  return {
    slug: round.slug,
    title: event.title || market.question || "BTC Up or Down 15m",
    start: round.start,
    end: round.end,
    upToken: tokenBySide.up,
    downToken: tokenBySide.down,
    upAsk: upPrice,
    downAsk: downPrice,
    fetchedAt: Date.now(),
    referenceStatus: hasReference
      ? `Opening Chainlink 60-second TWAP captured: ${fmtMoney(savedReference)}`
      : "Waiting for the opening Chainlink 60-second TWAP report",
    quoteStatus: upPrice !== null && downPrice !== null
      ? "Live Polymarket UP/DOWN best asks received"
      : "Waiting for both Polymarket order books"
  };
}

/* -------------------------------------------------------------------------- */
/* Technical indicators                                                       */
/* -------------------------------------------------------------------------- */

function ema(values, period) {
  if (!values.length) return 0;
  const multiplier = 2 / (period + 1);
  let output = values[0];

  for (let index = 1; index < values.length; index++) {
    output = values[index] * multiplier + output * (1 - multiplier);
  }

  return output;
}

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let index = closes.length - period; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }

  if (losses === 0) return 100;

  const relativeStrength = (gains / period) / (losses / period);
  return 100 - 100 / (1 + relativeStrength);
}

function isFreshPrice(price, receivedAt, sourceAt) {
  return Number.isFinite(price) &&
    price > 0 &&
    receivedAt > 0 &&
    Date.now() - receivedAt < DATA_FRESH_MS &&
    Number.isFinite(sourceAt) &&
    Date.now() - sourceAt < DATA_FRESH_MS;
}

function analyze(candles) {
  const closes = candles.map(candle => candle.close);
  const volumes = candles.map(candle => candle.volume);
  const spot = closes[closes.length - 1];

  const ema9 = ema(closes.slice(-40), 9);
  const ema21 = ema(closes.slice(-60), 21);
  const rsi = calculateRSI(closes);
  const momentum3 = (spot / closes[closes.length - 4] - 1) * 100;
  const averageVolume = volumes.slice(-21, -1).reduce((sum, value) => sum + value, 0) / 20;
  const volumeRatio = averageVolume > 0 ? volumes[volumes.length - 1] / averageVolume : 1;

  // Use the same Chainlink 60-second TWAP reference family for comparison.
  // Raw Chainlink spot is displayed only when the TWAP is not fresh.
  const twapFresh = isFreshPrice(twapPrice, twapAt, twapSourceAt);
  const comparePrice = twapFresh ? twapPrice : null;

  let score = 0;
  const reasons = [];

  if (ema9 > ema21) {
    score += 1.4;
    reasons.push("1-minute EMA trend bullish");
  } else {
    score -= 1.4;
    reasons.push("1-minute EMA trend bearish");
  }

  if (momentum3 > 0.025) {
    score += 1;
    reasons.push("3-minute momentum positive");
  } else if (momentum3 < -0.025) {
    score -= 1;
    reasons.push("3-minute momentum negative");
  }

  const reference = getReference();

  if (comparePrice !== null && reference !== null) {
    if (comparePrice > reference) {
      score += 0.9;
      reasons.push("Live Chainlink 60-second TWAP above opening reference");
    } else if (comparePrice < reference) {
      score -= 0.9;
      reasons.push("Live Chainlink 60-second TWAP below opening reference");
    } else {
      reasons.push("Live Chainlink TWAP equal to opening reference");
    }
  } else {
    reasons.push("Waiting for fresh Chainlink TWAP and verified opening reference");
  }

  if (volumeRatio > 1.25 && momentum3 > 0) {
    score += 0.6;
    reasons.push("Volume expansion supports upside");
  } else if (volumeRatio > 1.25 && momentum3 < 0) {
    score -= 0.6;
    reasons.push("Volume expansion supports downside");
  }

  if (rsi >= 72 && momentum3 < 0) {
    score -= 1;
    reasons.push("Potential bearish reversal: elevated RSI, momentum rolling over");
  } else if (rsi <= 28 && momentum3 > 0) {
    score += 1;
    reasons.push("Potential bullish reversal: low RSI, momentum turning up");
  }

  const probabilityUp = 1 / (1 + Math.exp(-0.42 * score));
  const chainlinkFresh = isFreshPrice(chainlinkPrice, chainlinkAt, chainlinkSourceAt);
  const displayedPrice = comparePrice ?? (chainlinkFresh ? chainlinkPrice : spot);
  const displayedSource = comparePrice !== null
    ? "Polymarket Chainlink BTC/USD 60-second TWAP"
    : chainlinkFresh
      ? "Polymarket Chainlink BTC/USD spot"
      : "Coinbase/Binance BTC/USD technical proxy";

  return {
    price: displayedPrice,
    spot,
    priceSource: displayedSource,
    rsi,
    mom3: momentum3,
    volRatio: volumeRatio,
    score,
    pUp: probabilityUp,
    time: candles[candles.length - 1].time,
    reasons,
    oracleFresh: twapFresh
  };
}

/* -------------------------------------------------------------------------- */
/* Round clock and opening TWAP capture                                       */
/* -------------------------------------------------------------------------- */

function roundClock() {
  const round = currentMarket || getExpectedRound();
  const now = Math.floor(Date.now() / 1000);
  const remaining = Math.max(0, round.end - now);
  const elapsed = ROUND_SECONDS - remaining;

  let phase;
  if (remaining > 600) phase = "WAIT · Opens at 10 minutes remaining";
  else if (remaining > 420) phase = "INITIAL SCAN";
  else if (remaining > 300) phase = "CONFIRMATION WINDOW";
  else if (remaining > 120) phase = "FINAL EVALUATION";
  else phase = "NO NEW ENTRIES";

  return { remaining, elapsed, phase };
}

function normalizeTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return timestamp < 1e12 ? timestamp * 1000 : timestamp;
}

function getTwapValue(payload) {
  const fullAccuracy = payload?.full_accuracy_value;

  if (typeof fullAccuracy === "string" && /^\d+$/.test(fullAccuracy)) {
    const exactValue = Number(fullAccuracy) / 1e18;
    if (Number.isFinite(exactValue) && exactValue > 0) return exactValue;
  }

  const value = Number(payload?.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function saveOpeningReference(roundStart, price, sourceAt) {
  const key = String(roundStart);

  // Never overwrite the first qualifying TWAP report for a round.
  if (Number.isFinite(Number(openingReferences[key])) && Number(openingReferences[key]) > 0) {
    return false;
  }

  openingReferences[key] = price;
  saveOpeningReferences();

  console.info(
    "ROUND OPENING TWAP CAPTURED",
    {
      roundStart,
      roundStartISO: iso(roundStart),
      price,
      sourceTimestamp: sourceAt,
      sourceTimestampISO: new Date(sourceAt).toISOString(),
      secondsAfterBoundary: (sourceAt - roundStart * 1000) / 1000
    }
  );

  if (currentMarket && currentMarket.start === roundStart) {
    currentMarket.referenceStatus = `Opening Chainlink 60-second TWAP captured: ${fmtMoney(price)}`;
    if (latestCandles) {
      latest = analyze(latestCandles);
      render();
    }
  }

  return true;
}

function ingestTwapRecord(record) {
  const payload = record?.payload || record || {};
  const symbol = String(payload.symbol || "btc/usd").toLowerCase();
  const windowSeconds = Number(payload.window_s ?? TWAP_WINDOW_SECONDS);

  if (symbol !== "btc/usd" || windowSeconds !== TWAP_WINDOW_SECONDS) return;

  const price = getTwapValue(payload);
  const sourceAt = normalizeTimestamp(
    payload.timestamp ?? payload.observed_at ?? payload.observedAt
  );

  if (price === null || sourceAt === null) return;

  twapPrice = price;
  twapAt = Date.now();
  twapSourceAt = sourceAt;

  twapHistory.push({ sourceAt, price });
  twapHistory = twapHistory
    .filter(item => item.sourceAt >= Date.now() - 30 * 60 * 1000)
    .sort((a, b) => a.sourceAt - b.sourceAt);

  /*
   * A 60-second TWAP is a rolling window ending at its source timestamp.
   * The first report at or after a round boundary, within 60 seconds, is
   * the first report whose rolling window covers that boundary.
   * Do not substitute a later report or interpolate a missing price.
   */
  const roundStart = Math.floor(sourceAt / (ROUND_SECONDS * 1000)) * ROUND_SECONDS;
  const millisecondsAfterStart = sourceAt - roundStart * 1000;

  if (
    millisecondsAfterStart >= 0 &&
    millisecondsAfterStart <= TWAP_WINDOW_SECONDS * 1000
  ) {
    saveOpeningReference(roundStart, price, sourceAt);
  }

  console.log(
    "BTC TWAP 60s received:",
    price,
    "Source timestamp:",
    sourceAt,
    "Delay ms:",
    Date.now() - sourceAt
  );
}

function handleTwapMessage(message) {
  if (!message || message.topic !== "crypto_prices_twap_sixty") return;

  const payload = message.payload || {};

  // RTDS can send a subscribe snapshot containing recent observations.
  // Process the snapshot oldest-first so the first report after the
  // boundary is retained as the opening reference.
  if (Array.isArray(payload.data)) {
    const snapshot = payload.data.slice().sort((a, b) => {
      const aTime = normalizeTimestamp(a?.timestamp ?? a?.observed_at) || 0;
      const bTime = normalizeTimestamp(b?.timestamp ?? b?.observed_at) || 0;
      return aTime - bTime;
    });

    for (const record of snapshot) ingestTwapRecord(record);
  }

  // Normal live update.
  if (payload.timestamp || payload.observed_at) {
    ingestTwapRecord(payload);
  }
}

/* -------------------------------------------------------------------------- */
/* Cloudflare paper accuracy logging                                          */
/* -------------------------------------------------------------------------- */

async function sendSignalToCloudflare(side, upAsk, downAsk, upEdge, downEdge, reference) {
  if (side === "PASS" || !currentMarket || !latest) return;

  const roundId = currentMarket.slug;
  const now = Date.now();

  if (lastRecordedKey === roundId) return;
  if (lastSignalAttempt[roundId] && now - lastSignalAttempt[roundId] < 60000) return;

  lastSignalAttempt[roundId] = now;
  lastRecordedKey = roundId;

  try {
    const response = await fetch(`${WORKER_URL}/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        round_id: roundId,
        signal: side,
        model_up_probability: latest.pUp,
        up_ask: upAsk,
        down_ask: downAsk,
        up_edge: upEdge,
        down_edge: downEdge,
        btc_reference: reference,
        btc_entry: latest.price,
        notes: {
          score: latest.score,
          rsi: latest.rsi,
          momentum: latest.mom3,
          volume_ratio: latest.volRatio,
          price_source: latest.priceSource,
          opening_reference_source: "Polymarket RTDS Chainlink 60-second TWAP"
        }
      })
    });

    let result = {};
    try {
      result = await response.json();
    } catch {
      result = {};
    }

    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }

    setText("paperStatus", "Paper signal sent to Cloudflare for accuracy tracking.");
  } catch (error) {
    lastRecordedKey = null;
    setText("paperStatus", `Cloudflare recording error: ${error.message}`);
    console.error("Cloudflare paper-signal recording failed:", error);
  }
}

/* -------------------------------------------------------------------------- */
/* Dashboard rendering                                                        */
/* -------------------------------------------------------------------------- */

function render() {
  if (!latest) return;

  const clock = roundClock();
  const reference = getReference();
  const marketFresh = Boolean(
    currentMarket &&
    Date.now() - currentMarket.fetchedAt < DATA_FRESH_MS &&
    currentMarket.end > Math.floor(Date.now() / 1000)
  );

  const upAsk = currentMarket?.upAsk ?? null;
  const downAsk = currentMarket?.downAsk ?? null;

  const marketReady = Boolean(
    marketFresh &&
    Number.isFinite(reference) &&
    reference > 0 &&
    upAsk !== null &&
    downAsk !== null
  );

  const edgeFloor = num("minEdge", 5) / 100;
  const upEdge = upAsk === null ? null : latest.pUp - upAsk;
  const downEdge = downAsk === null ? null : (1 - latest.pUp) - downAsk;

  let side = "PASS";
  let detail = "";

  if (!marketReady) {
    detail = "Waiting for a verified opening TWAP reference and both live Polymarket asks.";
  } else if (!latest.oracleFresh) {
    detail = "Waiting for fresh Chainlink 60-second TWAP data.";
  } else if (clock.remaining > 600) {
    detail = "Wait until 10 minutes remain before evaluating an entry.";
  } else if (clock.remaining <= 120) {
    detail = "Entry window closed. No new paper entries in the final 2 minutes.";
  } else if (latest.score >= 2 && upEdge >= edgeFloor) {
    side = "UP";
  } else if (latest.score <= -2 && downEdge >= edgeFloor) {
    side = "DOWN";
  } else {
    detail = "Conditions do not meet both the score and edge thresholds.";
  }

  if (side !== "PASS") {
    detail = `Experimental ${side} candidate · ${clock.phase}. Paper testing only.`;
  }

  sendSignalToCloudflare(side, upAsk, downAsk, upEdge, downEdge, reference);

  setText("btcPrice", fmtMoney(latest.price));
  setText("updated", `${latest.priceSource} · ${new Date().toLocaleTimeString()}`);
  setText("pUp", `${(latest.pUp * 100).toFixed(1)}%`);

  setText(
    "upEdge",
    upEdge === null ? "—" : `${upEdge >= 0 ? "+" : ""}${(upEdge * 100).toFixed(1)} pp`
  );

  setText(
    "downEdge",
    downEdge === null ? "—" : `${downEdge >= 0 ? "+" : ""}${(downEdge * 100).toFixed(1)} pp`
  );

  setText("score", latest.score.toFixed(2));
  setText("rsi", latest.rsi.toFixed(1));
  setText("mom", `${latest.mom3 >= 0 ? "+" : ""}${latest.mom3.toFixed(3)}%`);
  setText("vol", `${latest.volRatio.toFixed(2)}x`);
  setText("signalText", side);
  setText("signalDetail", detail);

  const signalBox = $("signalBox");
  if (signalBox) signalBox.className = `signal ${side.toLowerCase()}`;

  const reasons = $("reasons");
  if (reasons) {
    reasons.innerHTML = latest.reasons
      .map(reason => `<div class="reason">• ${reason}</div>`)
      .join("");
  }

  const expected = getExpectedRound();
  const marketName = $("marketName");
  if (marketName) marketName.value = currentMarket?.slug || expected.slug;

  const referenceInput = $("reference");
  if (referenceInput && document.activeElement !== referenceInput) {
    referenceInput.value = reference !== null ? Number(reference).toFixed(2) : "";
  }

  const upAskInput = $("upAsk");
  if (upAskInput) upAskInput.value = upAsk === null ? "" : upAsk.toFixed(3);

  const downAskInput = $("downAsk");
  if (downAskInput) downAskInput.value = downAsk === null ? "" : downAsk.toFixed(3);

  setText("marketTitle", currentMarket?.title || "Locating current BTC 15-minute market…");
  setText(
    "countdown",
    `${String(Math.floor(clock.remaining / 60)).padStart(2, "0")}:${String(clock.remaining % 60).padStart(2, "0")}`
  );
  setText("phase", clock.phase);

  const openingWindowExpired = Boolean(
    currentMarket && Date.now() > currentMarket.start * 1000 + TWAP_WINDOW_SECONDS * 1000
  );
  const referenceStatus = reference !== null
    ? `Opening Chainlink 60-second TWAP: ${fmtMoney(reference)}`
    : openingWindowExpired
      ? "Opening TWAP report was not received during the opening window. PASS remains active."
      : "Waiting for the first Chainlink 60-second TWAP report covering the round start.";

  const quoteStatus = currentMarket?.quoteStatus || "Waiting for Polymarket order books";
  setText(
    "marketStatus",
    `${marketFresh ? "Polymarket market data fresh" : "Polymarket market data missing or stale"} · ${referenceStatus} · ${quoteStatus}`
  );

  const paperButton = $("paperBtn");
  if (paperButton) {
    paperButton.disabled = side === "PASS";
    paperButton.style.opacity = side === "PASS" ? 0.45 : 1;
    paperButton.dataset.side = side;
    paperButton.dataset.price = side === "UP" ? upAsk : downAsk;
  }
}

/* -------------------------------------------------------------------------- */
/* Local paper-trade ledger                                                   */
/* -------------------------------------------------------------------------- */

function renderLedger() {
  const trades = getTrades();
  const settled = trades.filter(trade => trade.status === "SETTLED");
  const open = trades.filter(trade => trade.status === "OPEN");
  const pnl = settled.reduce((sum, trade) => sum + (trade.pnl || 0), 0);
  const wins = settled.filter(trade => trade.pnl > 0).length;

  setText("pnl", `${pnl >= 0 ? "+" : ""}${fmtMoney(pnl)}`);

  const pnlElement = $("pnl");
  if (pnlElement) pnlElement.className = `value ${pnl >= 0 ? "good" : "bad"}`;

  setText("winRate", settled.length ? `${(wins / settled.length * 100).toFixed(1)}%` : "—");
  setText("openCount", String(open.length));
  setText("settledCount", String(settled.length));

  const ledger = $("ledger");
  if (!ledger) return;

  if (!trades.length) {
    ledger.innerHTML = '<div class="small">No paper trades yet.</div>';
    return;
  }

  ledger.innerHTML = trades.slice().reverse().map(trade => {
    const action = trade.status === "OPEN"
      ? `<button class="secondary" data-settle="${Number(trade.id)}" style="width:auto;padding:8px 10px;margin-top:8px">Settle</button>`
      : `<span class="${trade.pnl >= 0 ? "good" : "bad"}">${trade.result} · ${trade.pnl >= 0 ? "+" : ""}${fmtMoney(trade.pnl)}</span>`;

    return `<div class="trade">
      <b>${trade.side}</b> · ${String(trade.market)} · ${fmtMoney(trade.stake)} stake · ${Number(trade.shares).toFixed(3)} shares<br>
      <span class="muted">${new Date(trade.created).toLocaleString()} · ${trade.status}</span><br>
      ${action}
    </div>`;
  }).join("");

  document.querySelectorAll("[data-settle]").forEach(button => {
    button.addEventListener("click", () => settleTrade(Number(button.dataset.settle)));
  });
}

function settleTrade(id) {
  const result = prompt("Which outcome won? Type UP or DOWN.");
  if (!result || !["UP", "DOWN"].includes(result.trim().toUpperCase())) return;

  const trades = getTrades();
  const trade = trades.find(item => item.id === id);
  if (!trade || trade.status !== "OPEN") return;

  const winningSide = result.trim().toUpperCase();
  trade.status = "SETTLED";
  trade.result = winningSide;
  trade.pnl = (trade.side === winningSide ? trade.shares : 0) - trade.stake;

  saveTrades(trades);
  renderLedger();
}

/* -------------------------------------------------------------------------- */
/* Refresh loop                                                               */
/* -------------------------------------------------------------------------- */

async function refresh() {
  if (refreshBusy) return;

  refreshBusy = true;
  const refreshButton = $("refreshBtn");
  if (refreshButton) refreshButton.textContent = "Refreshing…";

  try {
    const expected = getExpectedRound();
    const marketNameField = $("marketName");
    if (marketNameField) marketNameField.value = expected.slug;

 if (currentMarket && currentMarket.start !== expected.start) {
  currentMarket = null;
  lastRecordedKey = null;
}

if (officialReferenceRound !== expected.start) {
  officialReference = null;
  officialReferenceRound = null;
  officialReferenceStatus = "Waiting for Polymarket's official opening reference.";
  manualReference = null;
}

   const [candlesResult, marketResult, referenceResult] = await Promise.allSettled([
  fetchCandles(),
  fetchPolymarket(),
  fetchOfficialReference(expected.start)
]);

  if (referenceResult.status === "rejected") {
  console.warn("Official reference lookup failed:", referenceResult.reason);
}

    if (candlesResult.status === "fulfilled") {
      latestCandles = candlesResult.value;
      latest = analyze(latestCandles);
    } else {
      errors.push(`BTC candles: ${candlesResult.reason?.message || "unavailable"}`);
    }

    if (marketResult.status === "fulfilled") {
      currentMarket = marketResult.value;
    } else {
      errors.push(`Polymarket: ${marketResult.reason?.message || "unavailable"}`);
    }

    if (latest) render();

    if (errors.length) {
      setText("paperStatus", `${errors.join(" | ")}. No signal unless all required data is confirmed.`);
    } else {
      setText("paperStatus", "BTC indicators, Polymarket market data, and paper-only safeguards refreshed.");
    }

    if (currentMarket && latestCandles) {
  if (officialReferenceRound === currentMarket?.start && officialReference !== null) {
  officialReferenceStatus = `Official Polymarket reference: ${fmtMoney(officialReference)}`;
}
      if (reference === null) {
        currentMarket.referenceStatus = "Waiting for opening Chainlink 60-second TWAP report";
      } else {
        currentMarket.referenceStatus = `Opening Chainlink 60-second TWAP captured: ${fmtMoney(reference)}`;
      }
    }
  } catch (error) {
    console.error("Dashboard refresh error:", error);
    setText("paperStatus", `Refresh issue: ${error.message}. No new paper entry unless data is confirmed.`);
  } finally {
    if (refreshButton) refreshButton.textContent = "Refresh all data";
    refreshBusy = false;
  }
}

/* -------------------------------------------------------------------------- */
/* Polymarket RTDS live feeds                                                 */
/* -------------------------------------------------------------------------- */

function connectChainlink() {
  if (!("WebSocket" in window)) {
    console.error("This browser does not support WebSocket feeds.");
    return;
  }

  if (rtdsSocket && (
    rtdsSocket.readyState === WebSocket.OPEN ||
    rtdsSocket.readyState === WebSocket.CONNECTING
  )) return;

  try {
    rtdsSocket = new WebSocket(RTDS_URL);
  } catch (error) {
    console.error("Polymarket RTDS WebSocket error:", error);
    scheduleRtdsReconnect();
    return;
  }

  const socket = rtdsSocket;

  socket.onopen = () => {
    rtdsConnected = true;

    const filters = JSON.stringify({ symbol: "btc/usd" });

    socket.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        {
          topic: "crypto_prices_chainlink",
          type: "update",
          filters
        },
        {
          topic: "crypto_prices_twap_sixty",
          type: "update",
          filters
        }
      ]
    }));

    console.info("Connected to Polymarket RTDS. Subscribed to Chainlink BTC/USD and 60-second TWAP.");
  };

  socket.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      const payload = message.payload || {};

      if (message.topic === "crypto_prices_chainlink") {
        const symbol = String(payload.symbol || "").toLowerCase();
        const price = Number(payload.value);
        const sourceAt = normalizeTimestamp(payload.timestamp);

        if (
          symbol === "btc/usd" &&
          Number.isFinite(price) &&
          price > 0 &&
          sourceAt !== null
        ) {
          chainlinkPrice = price;
          chainlinkAt = Date.now();
          chainlinkSourceAt = sourceAt;
        }
      }

      if (message.topic === "crypto_prices_twap_sixty") {
        handleTwapMessage(message);
      }

      if (latestCandles) {
        latest = analyze(latestCandles);
        render();
      }
    } catch (error) {
      console.warn("RTDS message parsing error:", error);
    }
  };

  socket.onclose = () => {
    rtdsConnected = false;
    if (rtdsSocket === socket) rtdsSocket = null;
    console.warn("Polymarket RTDS disconnected. Reconnecting…");
    scheduleRtdsReconnect();
  };

  socket.onerror = error => {
    console.error("Polymarket RTDS connection error:", error);
    try {
      socket.close();
    } catch {
      // The close handler will schedule a reconnect.
    }
  };
}

function scheduleRtdsReconnect() {
  if (rtdsReconnectTimer) return;
  rtdsReconnectTimer = setTimeout(() => {
    rtdsReconnectTimer = null;
    connectChainlink();
  }, 5000);
}

/* -------------------------------------------------------------------------- */
/* UI event handlers and startup                                              */
/* -------------------------------------------------------------------------- */

function bindDashboardEvents() {
  const refreshButton = $("refreshBtn");
  if (refreshButton) refreshButton.addEventListener("click", refresh);

  const edgeInput = $("minEdge");
  if (edgeInput) {
    edgeInput.addEventListener("input", () => {
      if (latestCandles) {
        latest = analyze(latestCandles);
        render();
      }
    });
  }

  const referenceInput = $("reference");
  if (referenceInput) {
    referenceInput.addEventListener("input", () => {
      const raw = referenceInput.value.trim();
      const value = raw === "" ? null : Number(raw);

      manualReference = value !== null && Number.isFinite(value) && value > 0
        ? value
        : null;

      if (latestCandles) {
        latest = analyze(latestCandles);
        render();
      }
    });
  }

  const paperButton = $("paperBtn");
  if (paperButton) {
    paperButton.addEventListener("click", () => {
      const side = paperButton.dataset.side;
      const price = Number(paperButton.dataset.price);
      const stake = num("stake", 10);
      const reference = getReference();

      if (
        !side ||
        side === "PASS" ||
        !Number.isFinite(price) ||
        price <= 0 ||
        price >= 1 ||
        !Number.isFinite(stake) ||
        stake <= 0 ||
        reference === null
      ) return;

      const trades = getTrades();
      const nextId = trades.length
        ? Math.max(...trades.map(trade => Number(trade.id) || 0)) + 1
        : 1;

      trades.push({
        id: nextId,
        created: new Date().toISOString(),
        market: currentMarket.slug,
        side,
        price,
        stake,
        shares: stake / price,
        status: "OPEN",
        reference
      });

      saveTrades(trades);
      setText("paperStatus", "Paper trade recorded locally. No real order was sent.");
      renderLedger();
    });
  }
}

function startDashboard() {
  bindDashboardEvents();
  renderLedger();
  connectChainlink();
  refresh();

  setInterval(() => {
    const clock = roundClock();
    setText(
      "countdown",
      `${String(Math.floor(clock.remaining / 60)).padStart(2, "0")}:${String(clock.remaining % 60).padStart(2, "0")}`
    );
    setText("phase", clock.phase);

    if (latestCandles) {
      latest = analyze(latestCandles);
      render();
    }
  }, 1000);

  setInterval(refresh, 15000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(error => {
        console.warn("Service worker registration failed:", error);
      });
    });
  }
}

startDashboard();
