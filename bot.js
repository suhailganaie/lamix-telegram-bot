const { Telegraf, Markup } = require("telegraf");
const puppeteer = require("puppeteer");
require("dotenv").config();

const clients = require("./clients.json").clients;

const bot = new Telegraf(process.env.BOT_TOKEN);

const userStates = {};

const RANGES = {
Afghanistan:["Afghanistan LX 03D","Afghanistan LX 09D","Afghanistan LX 12D"],
Algeria:["Algeria LX 25F","Algeria LX 05Mar","Algeria LX 10Mar"],
Angola:["Angola LX 02D","Angola LX 03F","Angola LX 08D"],
Nigeria:["Nigeria LX MIX 1","Nigeria LX MIX 2","Nigeria LX MIX 3"]
};

bot.start((ctx)=>{
ctx.reply("🔑 Enter Lamix Client ID");
userStates[ctx.from.id]={step:"waiting_client_id"};
});

bot.on("text",async(ctx)=>{

const state=userStates[ctx.from.id];
if(!state) return;

const text=ctx.message.text.trim();

if(state.step==="waiting_client_id"){

if(!clients.includes(text))
return ctx.reply("❌ Wrong client ID. Please enter your ID.");

state.clientId=text;
state.step="choose_country";

const countries = Object.keys(RANGES);

const buttons=[];

for(let i=0;i<countries.length;i+=2){

const row=[
{
text:`${countries[i]} (${RANGES[countries[i]].length})`,
callback_data:`country_${countries[i]}`
}
];

if(countries[i+1]){

row.push({
text:`${countries[i+1]} (${RANGES[countries[i+1]].length})`,
callback_data:`country_${countries[i+1]}`
});

}

buttons.push(row);

}

return ctx.reply(
"🌍 Choose Country",
Markup.inlineKeyboard(buttons)
);

}

if(state.step==="quantity"){

const qty=parseInt(text);

if(isNaN(qty)||qty<5||qty>50)
return ctx.reply("❌ Enter quantity between 5 and 50");

ctx.reply("⏳ Allocating numbers...");

const result=await allocateNumbers(
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
Range: ${state.rangeName}

Numbers:
${result.numbers.join("\n")}`
);

delete userStates[ctx.from.id];

}

});

bot.on("callback_query",async(ctx)=>{

const data=ctx.callbackQuery.data;
const state=userStates[ctx.from.id];

await ctx.answerCbQuery();

if(!state) return;

if(data.startsWith("country_")){

state.country=data.replace("country_","");
state.step="choose_range";

const ranges=RANGES[state.country];

const buttons=[];

for(let i=0;i<ranges.length;i+=2){

const row=[{
text:ranges[i],
callback_data:`range_${i}`
}];

if(ranges[i+1]){

row.push({
text:ranges[i+1],
callback_data:`range_${i+1}`
});

}

buttons.push(row);

}

return ctx.reply(
`📱 Choose Range (${state.country})`,
Markup.inlineKeyboard(buttons)
);

}

if(data.startsWith("range_")){

const index=parseInt(data.split("_")[1]);

state.rangeName=RANGES[state.country][index];
state.step="quantity";

return ctx.reply("📦 How many numbers? (5-50)");

}

});

async function allocateNumbers(clientId,country,rangeName,qty){

const browser=await puppeteer.launch({
headless:"new",
args:[
"--no-sandbox",
"--disable-setuid-sandbox",
"--disable-dev-shm-usage",
"--disable-gpu"
]
});

const page=await browser.newPage();

try{

await page.goto(process.env.LAMIX_URL+"/login",{waitUntil:"networkidle2"});

await page.type('input[type="text"],input[name="username"]',process.env.LAMIX_USER);
await page.type('input[type="password"]',process.env.LAMIX_PASS);

await solveMathCaptcha(page);

await page.click("button[type=submit]");

await page.waitForNavigation({timeout:20000});

await page.goto(process.env.LAMIX_URL+"/numbers",{waitUntil:"networkidle2"});

await page.evaluate((rangeName)=>{
const el=[...document.querySelectorAll("*")]
.find(e=>e.textContent.includes(rangeName));
if(el) el.click();
},rangeName);

await page.waitForTimeout(2000);

const numbers=await page.evaluate(()=>{

const rows=[...document.querySelectorAll("tr")];

return rows
.filter(r=>!r.innerText.toLowerCase().includes("allocated"))
.map(r=>r.innerText.trim())
.filter(t=>/\d{8,}/.test(t));

});

if(numbers.length===0){
await browser.close();
return {success:false,message:"No free numbers in this range"};
}

const selected=numbers.slice(0,qty);

for(const num of selected){

await page.evaluate((num)=>{

const row=[...document.querySelectorAll("tr")]
.find(r=>r.innerText.includes(num));

if(!row) return;

const btn=row.querySelector(".allocate,.btn-allocate,[title*='allocate']");

if(btn) btn.click();

},num);

await page.waitForSelector(".client-search,input[placeholder*='client']");

await page.type(".client-search,input[placeholder*='client']",clientId);

await page.waitForSelector(".client-item,.dropdown-item");

await page.click(".client-item,.dropdown-item");

await page.click(".confirm,.btn-primary");

await page.waitForTimeout(700);

}

await browser.close();

return {
success:true,
numbers:selected
};

}catch(e){

await browser.close();

return {success:false,message:e.message};

}

}

async function solveMathCaptcha(page){

try{

const html=await page.content();

const match=html.match(/(\d+)\s*([+\-])\s*(\d+)/);

if(!match) return;

const a=parseInt(match[1]);
const op=match[2];
const b=parseInt(match[3]);

let result;

if(op==="+") result=a+b;
if(op==="-") result=a-b;

await page.type('input[name="captcha"],#captcha',result.toString());

}catch(e){
console.log("captcha skipped");
}

}

bot.catch(err=>console.log("BOT ERROR:",err));

bot.launch();

console.log("🚀 Lamix Bot Running");
