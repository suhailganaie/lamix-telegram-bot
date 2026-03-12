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
let loggedIn = false;

let RANGE_MAP = {};
let RANGE_LIST = [];

let lamixReady = false;
let lamixLoginInProgress = false;
let allocationLock = false;

async function sleep(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function initBrowser(){

  console.log("🚀 Starting browser");

  browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });

  page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );

  await page.setViewport({ width:1280, height:800 });

}

async function fetchRanges(){

  console.log("📡 Fetching ranges from Lamix");

  const response = await page.evaluate(async (base)=>{

    const url = base + "/ints/agent/aj_smsranges.php?max=1000&page=1";

    const res = await fetch(url);

    const text = await res.text();

    try{
      return JSON.parse(text);
    }catch(e){
      return {error:text};
    }

  }, process.env.LAMIX_URL);

  if(response.error){
    throw new Error("Range API error: " + response.error);
  }

  RANGE_MAP = {};
  RANGE_LIST = [];

  response.results.forEach(r=>{
    const name = r.title.trim().replace(/^-\s*/,"");
    RANGE_MAP[name] = r.id;
    RANGE_LIST.push(name);
  });

  console.log("✅ Ranges loaded:", RANGE_LIST.length);

}

async function ensureSession(){

  try{

    await page.goto(process.env.LAMIX_URL + "/agent/SMSBulkAllocations",{waitUntil:"networkidle2"});

    if(!page.url().includes("login")){
      loggedIn = true;
      return true;
    }

    loggedIn = false;
    return false;

  }catch(e){

    loggedIn = false;
    return false;

  }

}

async function loginLamix(){

  if(await ensureSession()){
    return;
  }

  console.log("🌐 Opening Lamix login");

  await page.goto(process.env.LAMIX_URL,{waitUntil:"networkidle2"});

  await sleep(3000);

  await page.waitForSelector('input[name="username"]');

  await page.type('input[name="username"]',process.env.LAMIX_USER,{delay:40});
  await page.type('input[name="password"]',process.env.LAMIX_PASS,{delay:40});

  console.log("🧠 Solving captcha");

  const bodyText = await page.evaluate(()=>document.body.innerText);

  const match = bodyText.match(/(\d+)\s*\+\s*(\d+)/);

  if(match){

    const result = parseInt(match[1]) + parseInt(match[2]);

    await page.type('input[name="capt"]',result.toString());

    console.log(`Captcha: ${match[1]} + ${match[2]} = ${result}`);

  }

  await page.click("button");

  await sleep(4000);

  await page.goto(process.env.LAMIX_URL + "/agent/SMSBulkAllocations",{waitUntil:"networkidle2"});

  if(page.url().includes("login")){
    throw new Error("Lamix login failed");
  }

  console.log("✅ LOGIN SUCCESS");

  loggedIn = true;

  await fetchRanges();

}

async function prepareLamix(){

  if(lamixReady){
    return;
  }

  if(lamixLoginInProgress){

    while(lamixLoginInProgress){
      await sleep(1000);
    }

    return;

  }

  lamixLoginInProgress = true;

  console.log("🔐 Preparing Lamix session");

  await loginLamix();

  lamixReady = true;
  lamixLoginInProgress = false;

}

bot.start(async(ctx)=>{

  try{

    ctx.reply("🔄 Connecting to Lamix...");

    await prepareLamix();

    const savedId = userClientIds[ctx.from.id];

    if(savedId){

      return ctx.reply(
`👤 Saved Client ID: ${savedId}`,
Markup.inlineKeyboard([
[{text:"✅ Continue",callback_data:"continue_id"}],
[{text:"🔄 Change ID",callback_data:"change_id"}]
])
);

    }

    userStates[ctx.from.id] = {step:"waiting_client_id"};

    ctx.reply("🔑 Enter Lamix Client ID");

  }catch(e){

    console.log("Start error:",e.message);

    ctx.reply("❌ Failed to connect Lamix");

  }

});

bot.on("text",async(ctx)=>{

  const state = userStates[ctx.from.id];
  if(!state) return;

  const text = ctx.message.text.trim();

  if(state.step==="waiting_client_id"){

    if(!clients[text]){
      return ctx.reply("❌ Wrong client ID");
    }

    userClientIds[ctx.from.id] = text;

    state.clientId = text;
    state.step = "choose_range";

    return ctx.reply("🔎 Send country or range");

  }

  if(state.step==="choose_range"){

    return sendRanges(ctx,text);

  }

  if(state.step==="quantity"){

    const qty = parseInt(text);

    if(isNaN(qty)||qty<1||qty>50){
      return ctx.reply("❌ Quantity must be 1-50");
    }

    ctx.reply("⏳ Allocating numbers...");

    const result = await allocateNumbers(
      state.clientId,
      state.rangeName,
      qty
    );

    if(!result.success){
      return ctx.reply("❌ "+result.message);
    }

    ctx.reply(
`✅ Allocation Success

Client: ${state.clientId}
Range: ${state.rangeName}
Quantity: ${qty}`
);

    delete userStates[ctx.from.id];

  }

});

bot.on("callback_query",async(ctx)=>{

  const data = ctx.callbackQuery.data;
  const state = userStates[ctx.from.id];

  await ctx.answerCbQuery();

  if(data==="continue_id"){

    const clientId = userClientIds[ctx.from.id];

    userStates[ctx.from.id] = {step:"choose_range",clientId};

    return ctx.reply("🔎 Send country or range");

  }

  if(data==="change_id"){

    userStates[ctx.from.id] = {step:"waiting_client_id"};

    return ctx.reply("🔑 Enter new client ID");

  }

  if(!state) return;

  if(data.startsWith("range_")){

    const index = parseInt(data.split("_")[1]);

    state.rangeName = state.countryRanges[index];

    state.step="quantity";

    return ctx.reply("📦 Enter quantity");

  }

});

function sendRanges(ctx,input){

  const clean = input
    .replace(/xxxx/ig,"")
    .replace(/\s+/g," ")
    .trim();

  const ranges = RANGE_LIST.filter(r =>
    r.toLowerCase().includes(clean.toLowerCase())
  );

  if(ranges.length===0){

    return ctx.reply("❌ No ranges found\n\nSend another range");

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

  userStates[ctx.from.id].countryRanges = ranges;

  return ctx.reply(
`📱 Choose Range`,
Markup.inlineKeyboard(buttons)
);

}

async function allocateNumbers(clientName,rangeName,qty){

  while(allocationLock){
    await sleep(1000);
  }

  allocationLock = true;

  try{

    await prepareLamix();

    const rangeId = RANGE_MAP[rangeName];
    const clientId = clients[clientName];

    if(!rangeId){
      allocationLock=false;
      return {success:false,message:"Range not found"};
    }

    if(!clientId){
      allocationLock=false;
      return {success:false,message:"Client not found"};
    }

    const payload = {
      action:"allocate",
      ntype:"-2",
      "range[]":rangeId,
      "client[]":clientId,
      payterm:"9",
      payout:"0.011",
      qty:qty
    };

    const response = await page.evaluate(async(payload,base)=>{

      const url = base + "/ints/agent/SMSBulkAllocations";

      const res = await fetch(url,{
        method:"POST",
        headers:{
          "Content-Type":"application/x-www-form-urlencoded"
        },
        body:new URLSearchParams(payload)
      });

      return await res.text();

    },payload,process.env.LAMIX_URL);

    allocationLock=false;

    if(response.includes("Well Done")){
      return {success:true};
    }

    if(response.toLowerCase().includes("no numbers")){
      return {success:false,message:"No numbers available"};
    }

    return {success:false,message:"Panel rejected request"};

  }catch(e){

    allocationLock=false;
    loggedIn=false;

    return {success:false,message:e.message};

  }

}

setInterval(async()=>{

  try{

    console.log("🔄 Keeping Lamix session alive");

    const valid = await ensureSession();

    if(!valid){

      lamixReady=false;

      await prepareLamix();

    }

  }catch(e){

    console.log("Keep alive error:",e.message);

  }

},600000);

bot.catch((err,ctx)=>{
  console.error("BOT ERROR:",err);
  if(ctx) ctx.reply("⚠ Bot error occurred");
});

(async()=>{

  await initBrowser();

  bot.launch({dropPendingUpdates:true});

  console.log("🤖 Lamix Bot Running");

})();
