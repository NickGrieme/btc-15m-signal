
const $ = id => document.getElementById(id);
let latest = null;
let lastRecordedKey = null;
const storeKey = "btc15m_paper_trades_v1";

function num(id, fallback=0){ const v=Number($(id).value); return Number.isFinite(v)?v:fallback; }
function fmtMoney(v){return "$"+Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
function getTrades(){try{return JSON.parse(localStorage.getItem(storeKey)||"[]")}catch{return []}}
function saveTrades(t){localStorage.setItem(storeKey,JSON.stringify(t));}
async function fetchCandles(){
  const urls=[
    "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100",
    "https://api.binance.us/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=100"
  ];
  let response, error;
  for(const url of urls){try{response=await fetch(url,{cache:"no-store"});if(response.ok)break;error=new Error("HTTP "+response.status)}catch(e){error=e}}
  if(!response || !response.ok) throw error || new Error("Price feed unavailable");
  const raw=await response.json();
  return raw.map(k=>({time:k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
}
function ema(values,period){const a=2/(period+1);let out=values[0];for(let i=1;i<values.length;i++)out=values[i]*a+out*(1-a);return out;}
function calculateRSI(closes,period=14){
  let gains=0,losses=0;for(let i=closes.length-period;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses-=d;}
  if(losses===0)return 100;const rs=(gains/period)/(losses/period);return 100-100/(1+rs);
}
function analyze(candles){
  const closes=candles.map(x=>x.close), volumes=candles.map(x=>x.volume);
  const price=closes.at(-1), e9=ema(closes.slice(-40),9),e21=ema(closes.slice(-60),21);
  const rsi=calculateRSI(closes),mom3=(price/closes.at(-4)-1)*100;
  const avgVol=volumes.slice(-21,-1).reduce((a,b)=>a+b,0)/20,volRatio=avgVol?volumes.at(-1)/avgVol:1;
  const reference=num("reference",price);
  let score=0,reasons=[];
  if(e9>e21){score+=1.4;reasons.push("1m EMA trend bullish")}else{score-=1.4;reasons.push("1m EMA trend bearish")}
  if(mom3>.025){score+=1;reasons.push("3-minute momentum positive")}else if(mom3<-.025){score-=1;reasons.push("3-minute momentum negative")}
  if(price>reference){score+=.9;reasons.push("BTC above market reference")}else if(price<reference){score-=.9;reasons.push("BTC below market reference")}
  if(volRatio>1.25&&mom3>0){score+=.6;reasons.push("Volume expansion supports upside")}else if(volRatio>1.25&&mom3<0){score-=.6;reasons.push("Volume expansion supports downside")}
  if(rsi>=72&&mom3<0){score-=1;reasons.push("Potential bearish reversal: elevated RSI, momentum rolling over")}
  else if(rsi<=28&&mom3>0){score+=1;reasons.push("Potential bullish reversal: low RSI, momentum turning up")}
  const pUp=1/(1+Math.exp(-.42*score));
  return {price,rsi,mom3,volRatio,score,pUp,time:candles.at(-1).time};
}
function render(){
  if(!latest)return;
  const upAsk=num("upAsk",.5),downAsk=num("downAsk",.5),edge=num("minEdge",5)/100;
  const upEdge=latest.pUp-upAsk,downEdge=(1-latest.pUp)-downAsk;
  let side="PASS";
  if(latest.score>=2&&upEdge>=edge)side="UP";
  else if(latest.score<=-2&&downEdge>=edge)side="DOWN";
  $("btcPrice").textContent=fmtMoney(latest.price);
  $("updated").textContent="Updated "+new Date().toLocaleTimeString();
  $("pUp").textContent=(latest.pUp*100).toFixed(1)+"%";
  $("upEdge").textContent=(upEdge*100>=0?"+":"")+(upEdge*100).toFixed(1)+" pp";
  $("downEdge").textContent=(downEdge*100>=0?"+":"")+(downEdge*100).toFixed(1)+" pp";
  $("score").textContent=latest.score.toFixed(2);
  $("rsi").textContent=latest.rsi.toFixed(1);
  $("mom").textContent=(latest.mom3>=0?"+":"")+latest.mom3.toFixed(3)+"%";
  $("vol").textContent=latest.volRatio.toFixed(2)+"x";
  $("signalText").textContent=side;
  $("signalDetail").textContent=side==="PASS"?"Conditions do not meet both the score and edge thresholds.":`Experimental ${side} candidate. Check the market's official rules and current quote.`;
  $("signalBox").className="signal "+side.toLowerCase();
  $("reasons").innerHTML=latest.reasons.map(r=>`<div class="reason">• ${r}</div>`).join("");
  $("paperBtn").disabled=side==="PASS";
  $("paperBtn").style.opacity=side==="PASS"?.45:1;
  $("paperBtn").dataset.side=side;
  $("paperBtn").dataset.price=side==="UP"?upAsk:downAsk;
}
function renderLedger(){
  const trades=getTrades(),settled=trades.filter(t=>t.status==="SETTLED"),open=trades.filter(t=>t.status==="OPEN");
  const pnl=settled.reduce((s,t)=>s+(t.pnl||0),0),wins=settled.filter(t=>t.pnl>0).length;
  $("pnl").textContent=(pnl>=0?"+":"")+fmtMoney(pnl);
  $("pnl").className="value "+(pnl>=0?"good":"bad");
  $("winRate").textContent=settled.length?(wins/settled.length*100).toFixed(1)+"%":"—";
  $("openCount").textContent=open.length;$("settledCount").textContent=settled.length;
  if(!trades.length){$("ledger").innerHTML='<div class="small">No paper trades yet.</div>';return;}
  $("ledger").innerHTML=trades.slice().reverse().map(t=>{
    const action=t.status==="OPEN"?`<button class="secondary" data-settle="${t.id}" style="width:auto;padding:8px 10px;margin-top:8px">Settle</button>`:`<span class="${t.pnl>=0?"good":"bad"}">${t.result} · ${t.pnl>=0?"+":""}${fmtMoney(t.pnl)}</span>`;
    return `<div class="trade"><b>${t.side}</b> · ${t.market} · ${fmtMoney(t.stake)} stake · ${t.shares.toFixed(3)} shares<br><span class="muted">${new Date(t.created).toLocaleString()} · ${t.status}</span><br>${action}</div>`;
  }).join("");
  document.querySelectorAll("[data-settle]").forEach(btn=>btn.addEventListener("click",()=>settleTrade(Number(btn.dataset.settle))));
}
function settleTrade(id){
  const result=prompt("Which outcome won? Type UP or DOWN.");
  if(!result||!["UP","DOWN"].includes(result.trim().toUpperCase()))return;
  const trades=getTrades(),t=trades.find(x=>x.id===id);if(!t||t.status!=="OPEN")return;
  const winning=result.trim().toUpperCase();t.status="SETTLED";t.result=winning;t.pnl=(t.side===winning?t.shares:0)-t.stake;
  saveTrades(trades);renderLedger();
}
async function refresh(){
  $("refreshBtn").textContent="Refreshing…";
  try{const candles=await fetchCandles();latest=analyze(candles);render();$("paperStatus").textContent="Live public BTC data received."}
  catch(e){$("updated").textContent="Feed unavailable";$("signalText").textContent="DATA ERROR";$("signalDetail").textContent=e.message+" · Try again shortly."}
  finally{$("refreshBtn").textContent="Refresh BTC data"}
}
$("refreshBtn").addEventListener("click",refresh);
["reference","upAsk","downAsk","minEdge"].forEach(id=>$(id).addEventListener("input",()=>{if(latest){latest=analyzeCache(latest);render()}}));
function analyzeCache(old){return old}
$("paperBtn").addEventListener("click",()=>{
  const side=$("paperBtn").dataset.side,price=Number($("paperBtn").dataset.price),stake=num("stake",10);
  if(!side||side==="PASS"||!Number.isFinite(price)||price<=0||price>=1||stake<=0)return;
  const trades=getTrades(),id=trades.length?Math.max(...trades.map(t=>t.id))+1:1;
  trades.push({id,created:new Date().toISOString(),market:$("marketName").value||"BTC 15m",side,price,stake,shares:stake/price,status:"OPEN"});
  saveTrades(trades);$("paperStatus").textContent="Paper trade recorded locally. No real order was sent.";renderLedger();
});
renderLedger();refresh();setInterval(refresh,15000);
if("serviceWorker" in navigator){window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));}
