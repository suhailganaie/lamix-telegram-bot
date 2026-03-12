const { Telegraf, Markup } = require("telegraf");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
require("dotenv").config();

const clients = require("./clients.json").clients;
const RANGES = require("./ranges.json");

const bot = new Telegraf(process.env.BOT_TOKEN);

const userStates = {};
const userClientIds = {};
const COUNTRIES = Object.keys(RANGES);

let browser;
let page;
let loggedIn = false;

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

async function loginLamix(){

if(loggedIn){
console.log("Already logged in");
return;
}

console.log("Opening Lamix login page");

await page.goto(process.env.LAMIX_URL,{
waitUntil:"networkidle2",
timeout:60000
});

await sleep(4000);

console.log("Waiting for login inputs");

await page.waitForSelector('input[name="username"]',{timeout:60000});

console.log("Typing username");

await page.focus('input[name="username"]');
await page.keyboard.type(process.env.LAMIX_USER,{delay:40});

console.log("Typing password");

await page.focus('input[name="password"]');
await page.keyboard.type(process.env.LAMIX_PASS,{delay:40});

console.log("Solving captcha");

const bodyText = await page.evaluate(()=>document.body.innerText);

const match = bodyText.match(/(\d+)\s*\+\s*(\d+)/);

if(match){

const result = parseInt(match[1]) + parseInt(match[2]);

console.log(`Captcha solved: ${match[1]} + ${match[2]} = ${result}`);

await page.type('input[name="capt"]',result.toString());

}

console.log("Submitting login form");

await page.click("button[type='submit'],button");

await sleep(5000);

console.log("Checking bulk allocation page");

await page.goto(
process.env.LAMIX_URL+"/agent/SMSBulkAllocations",
{waitUntil:"networkidle2"}
);

const url = page.url();

console.log("Bulk page URL:",url);

if(url.includes("login")){

console.log("LOGIN FAILED ❌");

loggedIn = false;

throw new Error("Invalid Lamix credentials");

}

console.log("LOGIN SUCCESS ✅");

loggedIn = true;

}

bot.start((ctx)=>{

const savedId = userClientIds[ctx.from.id];

if(savedId){

ctx.reply(
`👤 Your saved Client ID: ${savedId}

What would you like to do?`,
Markup.inlineKeyboard([
[{text:"✅ Continue with this ID",callback_data:"continue_id"}],
[{text:"🔄 Change Client ID",callback_data:"change_id"}]
])
);

}else{

ctx.reply("🔑 Enter Lamix Client ID");
userStates[ctx.from.id]={step:"waiting_client_id"};

}

});

bot.on("text",async(ctx)=>{

const state=userStates[ctx.from.id];
if(!state) return;

const text=ctx.message.text.trim();

if(state.step==="waiting_client_id"){

if(!clients.includes(text))
return ctx.reply("❌ Wrong client ID. Please enter your ID.");

userClientIds[ctx.from.id]=text;

state.clientId=text;
state.step="choose_country";

return ctx.reply("🌍 Send the country name");

}

if(state.step==="choose_country"){

const realCountry=COUNTRIES.find(
c=>c.toLowerCase()===text.toLowerCase()
);

if(!realCountry)
return ctx.reply("❌ Wrong country please send the country");

state.country=realCountry;
state.step="choose_range";

return sendRanges(ctx,realCountry);

}

if(state.step==="quantity"){

const qty=parseInt(text);

if(isNaN(qty)||qty<5||qty>50)
return ctx.reply("❌ Enter quantity between 5 and 50");

ctx.reply("⏳ Allocating numbers...");

const result = await allocateNumbers(
state.clientId,
state.country,
state.rangeName,
qty
);

if(!result.success)
return ctx.reply("❌ "+result.message);

ctx.reply(
`✅ Allocation Success

Client: ${state.clientId}
Country: ${state.country}
Range: ${state.rangeName}

Quantity: ${qty}`
);

delete userStates[ctx.from.id];

}

});

bot.on("callback_query",async(ctx)=>{

const data=ctx.callbackQuery.data;
const state=userStates[ctx.from.id];

await ctx.answerCbQuery();

if(data==="continue_id"){

const clientId=userClientIds[ctx.from.id];

userStates[ctx.from.id]={
step:"choose_country",
clientId
};

return ctx.reply("🌍 Send the country name");

}

if(data==="change_id"){

userStates[ctx.from.id]={step:"waiting_client_id"};

return ctx.reply("🔑 Enter new Lamix Client ID");

}

if(!state) return;

if(data.startsWith("range_")){

const index=parseInt(data.split("_")[1]);

state.rangeName=RANGES[state.country][index];
state.step="quantity";

return ctx.reply("📦 How many numbers? (5-50)");

}

if(data==="back_country"){

state.step="choose_country";

return ctx.reply("🌍 Send the country name");

}

});

function sendRanges(ctx,country){

const ranges=RANGES[country];
const buttons=[];

for(let i=0;i<ranges.length;i+=2){

const row=[{text:ranges[i],callback_data:`range_${i}`}];

if(ranges[i+1]){
row.push({text:ranges[i+1],callback_data:`range_${i+1}`});
}

buttons.push(row);

}

buttons.push([{text:"⬅ Back",callback_data:"back_country"}]);

return ctx.reply(
`📱 Choose Range (${country})`,
Markup.inlineKeyboard(buttons)
);

}

async function allocateNumbers(clientId,country,rangeName,qty){

try{

await loginLamix();

console.log("Opening Bulk Allocation page");

await page.goto(
process.env.LAMIX_URL+"/agent/SMSBulkAllocations",
{waitUntil:"networkidle2"}
);

await sleep(3000);

console.log("Preparing bulk allocation form");

/*
================================================
SELECTORS WILL BE ADDED HERE NEXT STEP
================================================

We will replace this block after you send
the exact HTML selectors from the page.

Example placeholders:

client field
range dropdown
quantity field
allocate button

================================================
*/

console.log("⚠ Waiting for selectors update");

return {success:true};

}catch(e){

console.log("ERROR:",e.message);

loggedIn=false;

return {success:false,message:e.message};

}

}

bot.catch(err=>console.log("BOT ERROR:",err));

(async()=>{

await initBrowser();

bot.launch({dropPendingUpdates:true});

console.log("🚀 Lamix Bot Running");

})();
