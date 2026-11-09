const $ = id => document.getElementById(id);
let latest = null;
let latestCandles = null;
let currentMarket = null;
let manualReference = null;
let chainlinkPrice = null;
let chainlinkAt = 0;
let lastRecordedKey = null;
let refreshBusy = false;
const storeKey = "btc15m_paper_trades_v1";

function num(id, fallback=0){ const v=Number($(id).value); return Number.isFinite(v)?v:fallback; }
function getReference(){ return manualReference!==null ? manualReference : (Number.isFinite(currentMarket?.reference) ? currentMarket.reference : null); }
function fmtMoney(v){return "$"+Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
function getTrades(){try{return JSON.parse(localStorage.getItem(storeKey)||"[]")}catch{return []}}
function saveTrades(t){localStorage.setItem(storeKey,JSON.stringify(t));}
function iso(ts){return new Date(ts*1000).toISOString().replace(/\.\d{3}Z$/,"Z");}
async function getJSON(url){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),9000);
  try {
    const r=await fetch(url,{cache:"no-store",headers:{"Accept":"application/json"},signal:controller.signal});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {clearTimeout(timer);}
}
async function fetchCandles(){
  const sources=[
    {url:"https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60",parse:raw=>raw.map(k=>({time:k[0]*1000,low:+k[1],high:+k[2],open:+k[3],close:+k[4],volume:+k[5]})).reverse()},
    {url:"https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100",parse:raw=>raw.map(k=>({time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}))}
  ];
  let lastError=null;
  for(const s of sources){try{const raw=await getJSON(s.url);const c=s.parse(raw).filter(x=>Number.isFinite(x.close)&&x.close>0&&Number.isFinite(x.volume));if(c.length>=30)return c.slice(-100);}catch(e){lastError=e;}}
  throw lastError||new Error("Public BTC candle feeds unavailable");
}
async function fetchPolymarket(){
  const now=Math.floor(Date.now()/1000), start=now-now%900, end=start+900;
  const slug=`btc-updown-15m-${start}`;
  const events=await getJSON(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
  if(!Array.isArray(events)||!events.length||!Array.isArray(events[0].markets)||!events[0].markets.length) throw new Error("Active BTC 15-minute market not found yet");
  const event=events[0], market=event.markets[0];
  const parseArray=v=>Array.isArray(v)?v:(typeof v==="string"?JSON.parse(v):[]);
  const outcomes=parseArray(market.outcomes), tokens=parseArray(market.clobTokenIds);
  const tokenBySide={};
  outcomes.forEach((o,i)=>{if(tokens[i])tokenBySide[String(o).toLowerCase()]=tokens[i];});
  if(!tokenBySide.up||!tokenBySide.down) throw new Error("Could not identify UP and DOWN market tokens");
  const [strikeData,upBook,downBook]=await Promise.all([
    getJSON(`https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime=${encodeURIComponent(iso(start))}&variant=fifteen&endDate=${encodeURIComponent(iso(end))}`).catch(()=>null),
    getJSON(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenBySide.up)}`).catch(()=>null),
    getJSON(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenBySide.down)}`).catch(()=>null)
  ]);
  const bestAsk=book=>{
    const asks=Array.isArray(book?.asks)?book.asks:[];
    const prices=asks.map(x=>Number(x.price)).filter(x=>Number.isFinite(x)&&x>0&&x<1);
    return prices.length?Math.min(...prices):null;
  };
  const open=Number(strikeData?.openPrice);
  return {
    slug, title:event.title||market.question||"BTC Up or Down 15m",
    start,end, upToken:tokenBySide.up, downToken:tokenBySide.down,
    reference:Number.isFinite(open)&&open>0?open:null,
    upAsk:bestAsk(upBook),downAsk:bestAsk(downBook),
    fetchedAt:Date.now(),
    referenceStatus:Number.isFinite(open)&&open>0?"Official Polymarket opening reference received":"Waiting for Polymarket opening reference",
    quoteStatus:bestAsk(upBook)!==null&&bestAsk(downBook)!==null?"Live Polymarket best asks received":"Waiting for both Polymarket order books"
  };
}
function ema(values,period){const a=2/(period+1);let out=values[0];for(let i=1;i<values.length;i++)out=values[i]*a+out*(1-a);return out;}
function calculateRSI(closes,period=14){let gains=0,losses=0;for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses-=d;}if(losses===0)return 100;const rs=(gains/period)/(losses/period);return 100-100/(1+rs);}
function analyze(candles){
  const closes=candles.map(x=>x.close),volumes=candles.map(x=>x.volume),spot=closes.at(-1),e9=ema(closes.slice(-40),9),e21=ema(closes.slice(-60),21);
  const rsi=calculateRSI(closes),mom3=(spot/closes.at(-4)-1)*100,avgVol=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20,volRatio=avgVol?volumes.at(-1)/avgVol:1;
  const oracleFresh=chainlinkPrice&&Date.now()-chainlinkAt<30000;
  const comparePrice=oracleFresh?chainlinkPrice:null;
  let score=0,reasons=[];
  if(e9>e21){score+=1.4;reasons.push("1m EMA trend bullish");}else{score-=1.4;reasons.push("1m EMA trend bearish");}
  if(mom3>.025){score+=1;reasons.push("3-minute momentum positive");}else if(mom3<-.025){score-=1;reasons.push("3-minute momentum negative");}
  const reference=getReference();
  if(comparePrice!==null&&reference){if(comparePrice>reference){score+=.9;reasons.push("Chainlink BTC price above official market reference");}else if(comparePrice<reference){score-=.9;reasons.push("Chainlink BTC price below official market reference");}}
  else reasons.push("Waiting for live Chainlink price and official reference comparison");
  if(volRatio>1.25&&mom3>0){score+=.6;reasons.push("Volume expansion supports upside");}else if(volRatio>1.25&&mom3<0){score-=.6;reasons.push("Volume expansion supports downside");}
  if(rsi>=72&&mom3<0){score-=1;reasons.push("Potential bearish reversal: elevated RSI, momentum rolling over");}else if(rsi<=28&&mom3>0){score+=1;reasons.push("Potential bullish reversal: low RSI, momentum turning up");}
  const pUp=1/(1+Math.exp(-.42*score));
  return {price:comparePrice??spot,spot,priceSource:comparePrice!==null?"Polymarket Chainlink BTC/USD":"Coinbase BTC/USD proxy",rsi,mom3,volRatio,score,pUp,time:candles.at(-1).time,reasons,oracleFresh};
}
function roundClock(){
  if(!currentMarket)return {remaining:null,elapsed:null,phase:"Waiting for market"};
  const remaining=Math.max(0,currentMarket.end-Math.floor(Date.now()/1000)),elapsed=900-remaining;
  let phase=remaining>600?"WAIT · Opens at 10 minutes remaining":remaining>420?"INITIAL SCAN":remaining>300?"CONFIRMATION WINDOW":remaining>120?"FINAL EVALUATION": "NO NEW ENTRIES";
  return {remaining,elapsed,phase};
}
async function sendSignalToCloudflare(side, upAsk, downAsk, upEdge, downEdge, reference) {
  if (side === "PASS" || !currentMarket || lastRecordedKey === currentMarket.slug) return;

  const roundId = currentMarket.slug;
  lastRecordedKey = roundId;

  try {
    const response = await fetch("https://btc-15m-accuracy.nicholasgrieme.workers.dev/signal", {
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
          price_source: latest.priceSource
        }
      })
    });

    const result = await response.json();
    $("paperStatus").textContent = result.ok
      ? "Signal sent to Cloudflare for accuracy tracking."
      : "Cloudflare recording error: " + (result.error || "Unknown error");
  } catch (error) {
    lastRecordedKey = null;
    $("paperStatus").textContent = "Signal recording failed: " + error.message;
  }
}
function render(){
  if(!latest)return;
  const clock=roundClock(),reference=getReference(),marketFresh=!!currentMarket&&(Date.now()-currentMarket.fetchedAt<30000)&&(currentMarket.end>Math.floor(Date.now()/1000)),marketReady=!!(marketFresh&&reference&&currentMarket?.upAsk!==null&&currentMarket?.downAsk!==null);
  const upAsk=currentMarket?.upAsk??null,downAsk=currentMarket?.downAsk??null,edgeFloor=num("minEdge",5)/100;
  const upEdge=upAsk===null?null:latest.pUp-upAsk,downEdge=downAsk===null?null:(1-latest.pUp)-downAsk;
  let side="PASS",detail="";
  if(!marketReady)detail="Waiting for fresh official opening reference and live UP/DOWN asks from Polymarket.";
  else if(!latest.oracleFresh)detail="Waiting for fresh Chainlink BTC/USD data. Coinbase candles are only technical indicators.";
  else if(clock.remaining>600)detail="Wait until 10 minutes remain before evaluating an entry.";
  else if(clock.remaining<=120)detail="Entry window closed. No new paper entries in the final 2 minutes.";
  else if(latest.score>=2&&upEdge>=edgeFloor)side="UP";
  else if(latest.score<=-2&&downEdge>=edgeFloor)side="DOWN";
  else detail="Conditions do not meet both the score and edge thresholds.";
  if(side!=="PASS")detail=`Experimental ${side} candidate · ${clock.phase}. Paper testing only.`;
  sendSignalToCloudflare(side, upAsk, downAsk, upEdge, downEdge, reference);
  $("btcPrice").textContent=fmtMoney(latest.price);
  $("updated").textContent=`${latest.priceSource} · ${new Date().toLocaleTimeString()}`;
  $("pUp").textContent=(latest.pUp*100).toFixed(1)+"%";
  $("upEdge").textContent=upEdge===null?"—":(upEdge*100>=0?"+":"")+(upEdge*100).toFixed(1)+" pp";
  $("downEdge").textContent=downEdge===null?"—":(downEdge*100>=0?"+":"")+(downEdge*100).toFixed(1)+" pp";
  $("score").textContent=latest.score.toFixed(2);$("rsi").textContent=latest.rsi.toFixed(1);$("mom").textContent=(latest.mom3>=0?"+":"")+latest.mom3.toFixed(3)+"%";$("vol").textContent=latest.volRatio.toFixed(2)+"x";
  $("signalText").textContent=side;$("signalDetail").textContent=detail;$("signalBox").className="signal "+side.toLowerCase();
  $("reasons").innerHTML=latest.reasons.map(r=>`<div class="reason">• ${r}</div>`).join("");
  $("marketName").value=currentMarket?.slug||"Finding active BTC 15m market";
  if(document.activeElement!==$("reference")) $("reference").value=reference!==null?reference.toFixed(2):"";
  $("upAsk").value=upAsk===null?"":upAsk.toFixed(3);$("downAsk").value=downAsk===null?"":downAsk.toFixed(3);
  $("marketTitle").textContent=currentMarket?.title||"Locating current BTC 15-minute market…";
  $("countdown").textContent=clock.remaining===null?"--:--":`${String(Math.floor(clock.remaining/60)).padStart(2,"0")}:${String(clock.remaining%60).padStart(2,"0")}`;
  $("phase").textContent=clock.phase;
  $("marketStatus").textContent=marketFresh?`${currentMarket.referenceStatus} · ${currentMarket.quoteStatus}`:"Polymarket market data missing or stale. No entries allowed.";
  $("paperBtn").disabled=side==="PASS";$("paperBtn").style.opacity=side==="PASS"?.45:1;$("paperBtn").dataset.side=side;$("paperBtn").dataset.price=side==="UP"?upAsk:downAsk;
}
function renderLedger(){
  const trades=getTrades(),settled=trades.filter(t=>t.status==="SETTLED"),open=trades.filter(t=>t.status==="OPEN"),pnl=settled.reduce((s,t)=>s+(t.pnl||0),0),wins=settled.filter(t=>t.pnl>0).length;
  $("pnl").textContent=(pnl>=0?"+":"")+fmtMoney(pnl);$("pnl").className="value "+(pnl>=0?"good":"bad");$("winRate").textContent=settled.length?(wins/settled.length*100).toFixed(1)+"%":"—";$("openCount").textContent=open.length;$("settledCount").textContent=settled.length;
  if(!trades.length){$("ledger").innerHTML='<div class="small">No paper trades yet.</div>';return;}
  $("ledger").innerHTML=trades.slice().reverse().map(t=>{const action=t.status==="OPEN"?`<button class="secondary" data-settle="${t.id}" style="width:auto;padding:8px 10px;margin-top:8px">Settle</button>`:`<span class="${t.pnl>=0?"good":"bad"}">${t.result} · ${t.pnl>=0?"+":""}${fmtMoney(t.pnl)}</span>`;return `<div class="trade"><b>${t.side}</b> · ${t.market} · ${fmtMoney(t.stake)} stake · ${t.shares.toFixed(3)} shares<br><span class="muted">${new Date(t.created).toLocaleString()} · ${t.status}</span><br>${action}</div>`;}).join("");
  document.querySelectorAll("[data-settle]").forEach(btn=>btn.addEventListener("click",()=>settleTrade(Number(btn.dataset.settle))));
}
function settleTrade(id){const result=prompt("Which outcome won? Type UP or DOWN.");if(!result||!["UP","DOWN"].includes(result.trim().toUpperCase()))return;const trades=getTrades(),t=trades.find(x=>x.id===id);if(!t||t.status!=="OPEN")return;const winning=result.trim().toUpperCase();t.status="SETTLED";t.result=winning;t.pnl=(t.side===winning?t.shares:0)-t.stake;saveTrades(trades);renderLedger();}
async function refresh(){
  if(refreshBusy)return;refreshBusy=true;$("refreshBtn").textContent="Refreshing…";
  try{
    const expectedStart=Math.floor(Date.now()/1000)-Math.floor(Date.now()/1000)%900;
    if(currentMarket&&currentMarket.start!==expectedStart)currentMarket=null;
    const [candles,market]=await Promise.all([fetchCandles(),fetchPolymarket()]);
    latestCandles=candles;currentMarket=market;latest=analyze(latestCandles);render();
    $("paperStatus").textContent="Public BTC indicators and Polymarket market data refreshed. Paper trades only.";
  }catch(e){
    if(latestCandles){latest=analyze(latestCandles);render();}
    $("marketStatus").textContent=`Market data issue: ${e?.message||"Unknown error"}. Automatic quotes/reference may be unavailable.`;
    $("paperStatus").textContent="No new trade until official Polymarket data is confirmed.";
  }finally{$("refreshBtn").textContent="Refresh all data";refreshBusy=false;}
}
function connectChainlink(){
  if(!("WebSocket" in window))return;
  let ws;try{ws=new WebSocket("wss://ws-live-data.polymarket.com");}catch{return;}
  ws.onopen=()=>ws.send(JSON.stringify({action:"subscribe",subscriptions:[{topic:"crypto_prices_chainlink",type:"*"}]}));
  ws.onmessage=event=>{try{const d=JSON.parse(event.data),p=d.payload||{};if(String(p.symbol||"").toLowerCase()==="btc/usd"&&Number(p.value)>0){chainlinkPrice=Number(p.value);chainlinkAt=Date.now();if(latestCandles){latest=analyze(latestCandles);render();}}}catch{}};
  ws.onclose=()=>setTimeout(connectChainlink,5000);ws.onerror=()=>{try{ws.close();}catch{}};
}
$("refreshBtn").addEventListener("click",refresh);
$("minEdge").addEventListener("input",()=>{if(latestCandles){latest=analyze(latestCandles);render();}});
$("reference").addEventListener("input",()=>{const raw=$("reference").value.trim();const value=raw===""?null:Number(raw);manualReference=(value!==null&&Number.isFinite(value)&&value>0)?value:null;if(latestCandles){latest=analyze(latestCandles);render();}});
$("paperBtn").addEventListener("click",()=>{
  const side=$("paperBtn").dataset.side,price=Number($("paperBtn").dataset.price),stake=num("stake",10);
  if(!side||side==="PASS"||!Number.isFinite(price)||price<=0||price>=1||stake<=0||!getReference())return;
  const trades=getTrades(),id=trades.length?Math.max(...trades.map(t=>t.id))+1:1;
  trades.push({id,created:new Date().toISOString(),market:currentMarket.slug,side,price,stake,shares:stake/price,status:"OPEN",reference:getReference()});
  saveTrades(trades);$("paperStatus").textContent="Paper trade recorded locally. No real order was sent.";renderLedger();
});
renderLedger();connectChainlink();refresh();
setInterval(()=>{const c=roundClock();if(c.remaining!==null){$("countdown").textContent=`${String(Math.floor(c.remaining/60)).padStart(2,"0")}:${String(c.remaining%60).padStart(2,"0")}`;$("phase").textContent=c.phase;if(latestCandles){latest=analyze(latestCandles);render();}}},1000);
setInterval(refresh,15000);
if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));}
