const { Telegraf, Markup } = require("telegraf");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
require("dotenv").config();

const clients = require("./clients.json").clients;

const bot = new Telegraf(process.env.BOT_TOKEN);

const userStates = {};
const userClientIds = {};

let browser;
let page;
let loggedIn = false;

let RANGE_MAP = {};
let RANGE_LIST = [];

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

  const response = await page.evaluate(async ()=>{
    const res = await fetch("/ints/agent/aj_smsranges.php?max=1000&page=1");
    return await res.json();
  });

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
      console.log("✅ Session still valid");
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

  console.log("✏ Typing username");

  await page.type('input[name="username"]',process.env.LAMIX_USER,{delay:40});

  console.log("✏ Typing password");

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

  await page.goto(process.env.LAMIX_URL+"/agent/SMSBulkAllocations",{waitUntil:"networkidle2"});

  if(page.url().includes("login")){
    throw new Error("Lamix login failed");
  }

  console.log("✅ LOGIN SUCCESS");

  loggedIn = true;

  await fetchRanges();

}

bot.start((ctx)=>{

  const savedId = userClientIds[ctx.from.id];

  if(savedId){

    ctx.reply(
`👤 Saved Client ID: ${savedId}`,
Markup.inlineKeyboard([
[{text:"✅ Continue",callback_data:"continue_id"}],
[{text:"🔄 Change ID",callback_data:"change_id"}]
])
);

  }else{

    ctx.reply("🔑 Enter Lamix Client ID");

    userStates[ctx.from.id] = {step:"waiting_client_id"};

  }

});

bot.on("text",async(ctx)=>{

  const state = userStates[ctx.from.id];
  if(!state) return;

  const text = ctx.message.text.trim();

  if(state.step==="waiting_client_id"){

    console.log("Client received:",text);

    if(!clients[text]){
      return ctx.reply("❌ Wrong client ID");
    }

    userClientIds[ctx.from.id] = text;

    state.clientId = text;
    state.step = "choose_country";

    return ctx.reply("🌍 Send country name");

  }

  if(state.step==="choose_country"){

    state.country = text;
    state.step = "choose_range";

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
      state.country,
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

    userStates[ctx.from.id] = {step:"choose_country",clientId};

    return ctx.reply("🌍 Send country name");

  }

  if(data==="change_id"){

    userStates[ctx.from.id] = {step:"waiting_client_id"};

    return ctx.reply("🔑 Enter new client ID");

  }

  if(!state) return;

  if(data.startsWith("range_")){

    const index = parseInt(data.split("_")[1]);

    state.rangeName = state.countryRanges[index];

    state.step = "quantity";

    return ctx.reply("📦 Enter quantity");

  }

});

function sendRanges(ctx,country){

  const ranges = RANGE_LIST.filter(r =>
    r.toLowerCase().includes(country.toLowerCase())
  );

  if(ranges.length===0){
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

  userStates[ctx.from.id].countryRanges = ranges;

  return ctx.reply(
`📱 Choose Range (${country})`,
Markup.inlineKeyboard(buttons)
);

}

async function allocateNumbers(clientName,country,rangeName,qty){

  try{

    console.log("------------------------------------------------");
    console.log("📦 FAST ALLOCATION");
    console.log("Client:",clientName);
    console.log("Range:",rangeName);

    await loginLamix();

    const rangeId = RANGE_MAP[rangeName];
    const clientId = clients[clientName];

    if(!rangeId){
      return {success:false,message:"Range not found"};
    }

    if(!clientId){
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

    const response = await page.evaluate(async(payload)=>{

      const res = await fetch("/ints/agent/SMSBulkAllocations",{
        method:"POST",
        headers:{
          "Content-Type":"application/x-www-form-urlencoded"
        },
        body:new URLSearchParams(payload)
      });

      return await res.text();

    },payload);

    if(response.includes("Well Done")){
      console.log("✅ Allocation success");
      return {success:true};
    }

    if(response.toLowerCase().includes("no numbers")){
      return {success:false,message:"No numbers available"};
    }

    return {success:false,message:"Panel rejected request"};

  }catch(e){

    console.log("❌ ERROR:",e.message);
    loggedIn=false;

    return {success:false,message:e.message};

  }

}

bot.catch((err,ctx)=>{
  console.error("BOT ERROR:",err);
  if(ctx) ctx.reply("⚠ Bot error occurred");
});

(async()=>{

  await initBrowser();

  bot.launch({dropPendingUpdates:true});

  console.log("🤖 Lamix Bot Running");

})();
