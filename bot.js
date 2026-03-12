const { Telegraf, Markup } = require("telegraf");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
require("dotenv").config();

const clients = require("./clients.json");

const bot = new Telegraf(process.env.BOT_TOKEN);

const userStates = {};
const userClientIds = {};

let browser;
let page;

let RANGE_MAP = {};
let RANGE_LIST = [];

let lamixReady = false;
let lamixLoginInProgress = false;
let allocationLock = false;

async function sleep(ms){
  return new Promise(r=>setTimeout(r,ms));
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

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
  );

}

async function ensureSession(){

  try{

    await page.goto(
      process.env.LAMIX_URL+"/ints/agent/SMSBulkAllocations",
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

  await page.goto(process.env.LAMIX_URL,{waitUntil:"networkidle2"});

  await page.waitForSelector('input[name="username"]');

  await page.type('input[name="username"]',process.env.LAMIX_USER,{delay:20});
  await page.type('input[name="password"]',process.env.LAMIX_PASS,{delay:20});

  const body = await page.evaluate(()=>document.body.innerText);

  const match = body.match(/(\d+)\s*\+\s*(\d+)/);

  if(match){

    const result = Number(match[1]) + Number(match[2]);

    await page.type('input[name="capt"],input[name="captcha"]',String(result));

    console.log("Captcha solved:",result);

  }

  await page.click('button[type="submit"],button');

  await sleep(4000);

  await page.goto(
    process.env.LAMIX_URL+"/ints/agent/SMSBulkAllocations",
    {waitUntil:"networkidle2"}
  );

  if(page.url().includes("login")){
    throw new Error("Lamix login failed");
  }

  console.log("✅ LOGIN SUCCESS");

}

async function fetchRanges(){

  console.log("📡 Fetching ranges");

  RANGE_MAP = {};
  RANGE_LIST = [];

  let pageNum = 1;

  while(true){

    const data = await page.evaluate(async(pageNum)=>{

      const res = await fetch(
        `/ints/agent/res/aj_smsranges.php?max=25&page=${pageNum}`,
        {headers:{"X-Requested-With":"XMLHttpRequest"}}
      );

      const text = await res.text();

      try{
        return JSON.parse(text);
      }catch{
        return {error:text};
      }

    },pageNum);

    if(data.error) throw new Error("Range API error");

    if(!data.results || data.results.length===0) break;

    data.results.forEach(r=>{

      const name = r.title.trim().replace(/^-\s*/,"");

      RANGE_MAP[name] = r.id;
      RANGE_LIST.push(name);

    });

    pageNum++;

  }

  console.log("✅ Total ranges:",RANGE_LIST.length);

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

  console.log("🔐 Preparing Lamix");

  await loginLamix();

  await fetchRanges();

  lamixReady=true;
  lamixLoginInProgress=false;

}

bot.start(async(ctx)=>{

  try{

    await ctx.reply("🔄 Connecting to Lamix...");

    await prepareLamix();

    const saved=userClientIds[ctx.from.id];

    if(saved){

      return ctx.reply(
`👤 Saved Client: ${saved}`,
Markup.inlineKeyboard([
[{text:"Continue",callback_data:"continue"}],
[{text:"Change",callback_data:"change"}]
])
);

    }

    userStates[ctx.from.id]={step:"client"};

    ctx.reply("Enter Lamix Client ID");

  }catch(e){

    console.log("Start error:",e.message);

    ctx.reply("❌ Failed to connect Lamix");

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

    return ctx.reply("Send country or range");

  }

  if(state.step==="range"){
    return sendRanges(ctx,text);
  }

  if(state.step==="qty"){

    const qty=Number(text);

    if(!qty||qty<1||qty>50){
      return ctx.reply("Quantity must be 1-50");
    }

    ctx.reply("Allocating numbers...");

    const res=await allocateNumbers(
      state.clientId,
      state.range,
      qty
    );

    if(!res.success){
      return ctx.reply("❌ "+res.message);
    }

    ctx.reply(
`✅ Allocation Success

Client: ${state.clientId}
Range: ${state.range}
Qty: ${qty}`
);

    delete userStates[ctx.from.id];

  }

});

bot.on("callback_query",async(ctx)=>{

  const data=ctx.callbackQuery.data;
  const state=userStates[ctx.from.id];

  await ctx.answerCbQuery();

  if(data==="continue"){

    const id=userClientIds[ctx.from.id];

    userStates[ctx.from.id]={step:"range",clientId:id};

    return ctx.reply("Send country or range");

  }

  if(data==="change"){

    userStates[ctx.from.id]={step:"client"};

    return ctx.reply("Enter client ID");

  }

  if(data.startsWith("range_")){

    const index=Number(data.split("_")[1]);

    state.range=state.ranges[index];

    state.step="qty";

    return ctx.reply("Enter quantity");

  }

});

function sendRanges(ctx,input){

  const clean=input.replace(/xxxx/ig,"").trim();

  const ranges=RANGE_LIST
  .filter(r=>r.toLowerCase().includes(clean.toLowerCase()))
  .slice(0,40);

  if(!ranges.length){
    return ctx.reply("❌ No ranges found");
  }

  const buttons=[];

  for(let i=0;i<ranges.length;i+=2){

    const row=[
      {text:ranges[i],callback_data:`range_${i}`}
    ];

    if(ranges[i+1]){
      row.push({text:ranges[i+1],callback_data:`range_${i+1}`});
    }

    buttons.push(row);

  }

  userStates[ctx.from.id].ranges=ranges;

  ctx.reply(
"Choose Range",
Markup.inlineKeyboard(buttons)
);

}

async function allocateNumbers(clientName,rangeName,qty){

  while(allocationLock){
    await sleep(300);
  }

  allocationLock=true;

  try{

    await prepareLamix();

    const rangeId=RANGE_MAP[rangeName];
    const clientId=clients[clientName];

    if(!rangeId){
      allocationLock=false;
      return {success:false,message:"Range not found"};
    }

    const payload={
      action:"allocate",
      ntype:"-2",
      "range[]":rangeId,
      "client[]":clientId,
      payterm:"9",
      payout:"0.011",
      qty
    };

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

    allocationLock=false;

    if(res.includes("Well Done")){
      return {success:true};
    }

    if(res.toLowerCase().includes("no numbers")){
      return {success:false,message:"No numbers available"};
    }

    return {success:false,message:"Panel rejected request"};

  }catch(e){

    allocationLock=false;

    return {success:false,message:e.message};

  }

}

setInterval(async()=>{

  try{

    const valid=await ensureSession();

    if(!valid){

      console.log("Session expired → reconnect");

      lamixReady=false;

      await prepareLamix();

    }

  }catch(e){

    console.log("KeepAlive error:",e.message);

  }

},600000);

(async()=>{

  await initBrowser();

  bot.launch({dropPendingUpdates:true});

  console.log("🤖 Lamix Bot Running");

})();
