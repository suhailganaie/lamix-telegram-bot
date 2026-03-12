const { Telegraf, Markup } = require("telegraf");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
require("dotenv").config();

const clients = require("./clients.json");

const bot = new Telegraf(process.env.BOT_TOKEN);

const userStates = {};
const userClientIds = {};
const clientClaims = {};

let browser;
let page;

let lamixReady = false;
let lamixLoginInProgress = false;

let ALL_RANGES = [];

const allocationQueue = [];
let allocating = false;

function sleep(ms){
  return new Promise(r=>setTimeout(r,ms));
}

function getToday(){
  return new Date().toDateString();
}

function getPayout(country){

  country = country.toLowerCase();

  if(country.includes("tanzania")) return "0.015";
  if(country.includes("cambodia")) return "0.014";
  if(country.includes("comoros")) return "0.014";
  if(country.includes("sri lanka")) return "0.014";
  if(country.includes("malaysia")) return "0.013";

  return "0.011";
}

async function initBrowser(){

  console.log("🚀 Starting browser");

  browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });

  page = await browser.newPage();

  await page.setViewport({width:1280,height:800});
  await page.setUserAgent("Mozilla/5.0");

}

async function ensureSession(){

  try{

    await page.goto(
      process.env.LAMIX_URL + "/ints/agent/SMSBulkAllocations",
      {waitUntil:"networkidle2"}
    );

    return !page.url().includes("login");

  }catch{
    return false;
  }

}

async function loginLamix(){

  if(await ensureSession()){
    console.log("✅ Session already valid");
    return;
  }

  console.log("🌐 Opening Lamix login");

  await page.goto(
    process.env.LAMIX_URL + "/ints/login",
    {waitUntil:"networkidle2"}
  );

  await page.waitForSelector('input[name="username"]');

  await page.type('input[name="username"]',process.env.LAMIX_USER,{delay:20});
  await page.type('input[name="password"]',process.env.LAMIX_PASS,{delay:20});

  const body = await page.evaluate(()=>document.body.innerText);
  const match = body.match(/(\d+)\s*\+\s*(\d+)/);

  if(match){

    const result = Number(match[1]) + Number(match[2]);
    await page.type('input[name="capt"]',String(result));

  }

  await Promise.all([
    page.click('button'),
    page.waitForNavigation({waitUntil:"networkidle2"})
  ]);

  console.log("✅ LOGIN SUCCESS");

}

async function loadAllRanges(){

  console.log("📡 Loading ranges");

  ALL_RANGES=[];

  await page.goto(
    process.env.LAMIX_URL+"/ints/agent/SMSBulkAllocations",
    {waitUntil:"networkidle2"}
  );

  let pageNum=1;

  while(true){

    const text=await page.evaluate(async(pageNum)=>{

      const res=await fetch(
        `/ints/agent/res/aj_smsranges.php?max=25&page=${pageNum}`,
        {
          headers:{
            "X-Requested-With":"XMLHttpRequest"
          },
          credentials:"include"
        }
      );

      return await res.text();

    },pageNum);

    if(text.startsWith("<")) break;

    const data=JSON.parse(text);

    if(!data.results || !data.results.length) break;

    data.results.forEach(r=>{

      const name=r.title.trim().replace(/^-\s*/,"");

      ALL_RANGES.push({
        id:r.id,
        name
      });

    });

    if(!data.pagination || !data.pagination.more) break;

    pageNum++;

  }

  console.log("✅ Total ranges:",ALL_RANGES.length);

}

async function prepareLamix(){

  if(lamixReady) return;

  if(lamixLoginInProgress){

    while(lamixLoginInProgress){
      await sleep(500);
    }

    return;

  }

  lamixLoginInProgress=true;

  await loginLamix();
  await loadAllRanges();

  lamixReady=true;
  lamixLoginInProgress=false;

}

bot.start(async(ctx)=>{

  await prepareLamix();

  const saved=userClientIds[ctx.from.id];

  if(saved){

    return ctx.reply(
`Saved Client ID: ${saved}`,
Markup.inlineKeyboard([
[{text:"Use Saved ID",callback_data:"use_saved"}],
[{text:"Enter New ID",callback_data:"new_id"}]
])
);

  }

  userStates[ctx.from.id]={step:"client"};

  ctx.reply("Enter Lamix Client ID");

});

bot.on("callback_query",async(ctx)=>{

  const data=ctx.callbackQuery.data;

  if(data==="use_saved"){

    const id=userClientIds[ctx.from.id];

    userStates[ctx.from.id]={
      step:"range",
      clientId:id
    };

    await ctx.answerCbQuery();
    return ctx.reply("Send country");

  }

  if(data==="new_id"){

    userStates[ctx.from.id]={step:"client"};

    await ctx.answerCbQuery();
    return ctx.reply("Enter Lamix Client ID");

  }

  const state=userStates[ctx.from.id];
  if(!state) return;

  if(data.startsWith("range_")){

    const index=Number(data.split("_")[1]);
    const r=state.ranges[index];

    state.rangeId=r.id;
    state.rangeName=r.name;
    state.step="qty";

    await ctx.answerCbQuery();
    ctx.reply("Enter quantity (1-20)");

  }

});

bot.on("text",async(ctx)=>{

  const state=userStates[ctx.from.id];
  if(!state) return;

  const text=ctx.message.text.trim();

  if(state.step==="client"){

    if(!clients[text]){
      return ctx.reply("❌ Wrong client ID");
    }

    userClientIds[ctx.from.id]=text;

    state.clientId=text;
    state.step="range";

    return ctx.reply("Send country");

  }

  if(state.step==="range"){

    const ranges=ALL_RANGES
      .filter(r=>r.name.toLowerCase().includes(text.toLowerCase()))
      .slice(0,40);

    if(!ranges.length){
      return ctx.reply("No ranges found");
    }

    const buttons=[];

    for(let i=0;i<ranges.length;i+=2){

      const row=[{text:ranges[i].name,callback_data:`range_${i}`}];

      if(ranges[i+1]){
        row.push({text:ranges[i+1].name,callback_data:`range_${i+1}`});
      }

      buttons.push(row);

    }

    state.ranges=ranges;

    return ctx.reply("Choose Range",Markup.inlineKeyboard(buttons));

  }

  if(state.step==="qty"){

    const qty=Number(text);

    if(!qty || qty<1 || qty>20){
      return ctx.reply("Quantity must be 1-20");
    }

    const client=state.clientId;
    const today=getToday();

    if(!clientClaims[client]){
      clientClaims[client]={date:today,count:0};
    }

    if(clientClaims[client].date!==today){
      clientClaims[client]={date:today,count:0};
    }

    if(clientClaims[client].count>=10){
      return ctx.reply("⚠ Daily limit reached (10 claims)");
    }

    ctx.reply("⏳ Queued for allocation...");

    allocationQueue.push({
      ctx,
      client,
      rangeId:state.rangeId,
      rangeName:state.rangeName,
      qty
    });

    delete userStates[ctx.from.id];

    processQueue();

  }

});

async function processQueue(){

  if(allocating) return;
  if(!allocationQueue.length) return;

  allocating=true;

  const job=allocationQueue.shift();

  const sessionValid=await ensureSession();

  if(!sessionValid){

    console.log("⚠ Session expired → relogin");

    lamixReady=false;

    await loginLamix();

  }

  const payout=getPayout(job.rangeName);

  const payload={
    action:"allocate",
    ntype:"-2",
    "range[]":job.rangeId,
    "client[]":clients[job.client],
    payterm:"9",
    payout,
    qty:job.qty
  };

  try{

    const res=await page.evaluate(async(payload)=>{

      const r=await fetch(
        "/ints/agent/SMSBulkAllocations",
        {
          method:"POST",
          headers:{
            "Content-Type":"application/x-www-form-urlencoded"
          },
          body:new URLSearchParams(payload)
        }
      );

      return await r.text();

    },payload);

    if(res.includes("Well Done")){

      const today=getToday();

      if(!clientClaims[job.client]){
        clientClaims[job.client]={date:today,count:0};
      }

      if(clientClaims[job.client].date!==today){
        clientClaims[job.client]={date:today,count:0};
      }

      clientClaims[job.client].count++;

      job.ctx.reply(
`✅ Allocation success

Range: ${job.rangeName}
Qty: ${job.qty}
Payout: ${payout}

Claims today: ${clientClaims[job.client].count}/10

Send country to claim again`
);

      userStates[job.ctx.from.id]={
        step:"range",
        clientId:job.client
      };

    }else{

      job.ctx.reply("❌ Allocation failed");

    }

  }catch(e){

    job.ctx.reply("Error: "+e.message);

  }

  allocating=false;

  processQueue();

}

setInterval(async()=>{

  try{

    console.log("♻ Refreshing ranges");

    await loadAllRanges();

  }catch(e){

    console.log("Range refresh error",e.message);

  }

},600000);

setInterval(async()=>{

  try{

    const valid=await ensureSession();

    if(!valid){

      console.log("⚠ Session expired → reconnect");

      lamixReady=false;

      await loginLamix();

    }

  }catch(e){

    console.log("KeepAlive error",e.message);

  }

},300000);

(async()=>{

  await initBrowser();

  await prepareLamix();

  bot.launch({dropPendingUpdates:true});

  console.log("🤖 Lamix Bot Running");

})();
