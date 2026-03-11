const { Telegraf, Markup } = require("telegraf");
const puppeteer = require("puppeteer");
require("dotenv").config();

const clients = require("./clients.json").clients;
const RANGES = require("./ranges.json");

const bot = new Telegraf(process.env.BOT_TOKEN);

const userStates = {};
const userClientIds = {};

const COUNTRIES = Object.keys(RANGES);

bot.start((ctx) => {

  const savedId = userClientIds[ctx.from.id];

  if (savedId) {

    ctx.reply(
`👤 Your saved Client ID: ${savedId}

What would you like to do?`,
      Markup.inlineKeyboard([
        [{ text: "✅ Continue with this ID", callback_data: "continue_id" }],
        [{ text: "🔄 Change Client ID", callback_data: "change_id" }]
      ])
    );

  } else {

    ctx.reply("🔑 Enter Lamix Client ID");
    userStates[ctx.from.id] = { step: "waiting_client_id" };

  }

});

bot.on("text", async (ctx) => {

  const state = userStates[ctx.from.id];
  if (!state) return;

  const text = ctx.message.text.trim();

  // CLIENT ID
  if (state.step === "waiting_client_id") {

    if (!clients.includes(text)) {
      return ctx.reply("❌ Wrong client ID. Please enter your ID.");
    }

    userClientIds[ctx.from.id] = text;

    state.clientId = text;
    state.step = "choose_country";

    return ctx.reply("🌍 Send the country name");
  }

  // COUNTRY
  if (state.step === "choose_country") {

    const realCountry = COUNTRIES.find(
      c => c.toLowerCase() === text.toLowerCase()
    );

    if (!realCountry) {
      return ctx.reply("❌ Wrong country please send the country");
    }

    state.country = realCountry;
    state.step = "choose_range";

    return sendRanges(ctx, realCountry);
  }

  // QUANTITY
  if (state.step === "quantity") {

    const qty = parseInt(text);

    if (isNaN(qty) || qty < 5 || qty > 50) {
      return ctx.reply("❌ Enter quantity between 5 and 50");
    }

    ctx.reply("⏳ Allocating numbers...");

    const result = await allocateNumbers(
      state.clientId,
      state.country,
      state.rangeName,
      qty
    );

    if (!result.success) {
      return ctx.reply("❌ " + result.message);
    }

    ctx.reply(
`✅ Allocation Success

Client: ${state.clientId}
Country: ${state.country}
Range: ${state.rangeName}

Numbers:
${result.numbers.join("\n")}`
    );

    delete userStates[ctx.from.id];

  }

});

bot.on("callback_query", async (ctx) => {

  const data = ctx.callbackQuery.data;
  const state = userStates[ctx.from.id];

  await ctx.answerCbQuery();

  // CONTINUE WITH SAVED ID
  if (data === "continue_id") {

    const clientId = userClientIds[ctx.from.id];

    userStates[ctx.from.id] = {
      step: "choose_country",
      clientId
    };

    return ctx.reply("🌍 Send the country name");

  }

  // CHANGE CLIENT ID
  if (data === "change_id") {

    userStates[ctx.from.id] = { step: "waiting_client_id" };

    return ctx.reply("🔑 Enter new Lamix Client ID");

  }

  if (!state) return;

  // RANGE SELECT
  if (data.startsWith("range_")) {

    const index = parseInt(data.split("_")[1]);

    state.rangeName = RANGES[state.country][index];
    state.step = "quantity";

    return ctx.reply("📦 How many numbers? (5-50)");

  }

  // BACK BUTTON
  if (data === "back_country") {

    state.step = "choose_country";

    return ctx.reply("🌍 Send the country name");

  }

});

// SEND RANGES
function sendRanges(ctx, country) {

  const ranges = RANGES[country];
  const buttons = [];

  for (let i = 0; i < ranges.length; i += 2) {

    const row = [
      { text: ranges[i], callback_data: `range_${i}` }
    ];

    if (ranges[i + 1]) {
      row.push({
        text: ranges[i + 1],
        callback_data: `range_${i + 1}`
      });
    }

    buttons.push(row);
  }

  buttons.push([
    { text: "⬅ Back", callback_data: "back_country" }
  ]);

  return ctx.reply(
    `📱 Choose Range (${country})`,
    Markup.inlineKeyboard(buttons)
  );

}

// ALLOCATION
async function allocateNumbers(clientId, country, rangeName, qty) {

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ]
  });

  const page = await browser.newPage();
  await page.setDefaultTimeout(60000);

  try {

    await page.goto(process.env.LAMIX_URL + "/login", { waitUntil: "networkidle2" });

    await page.type('input[type="text"],input[name="username"]', process.env.LAMIX_USER);
    await page.type('input[type="password"]', process.env.LAMIX_PASS);

    await solveMathCaptcha(page);

    await page.click("button[type=submit]");
    await page.waitForNavigation({ timeout: 20000 });

    await page.goto(process.env.LAMIX_URL + "/numbers", { waitUntil: "networkidle2" });

    await page.evaluate((rangeName) => {
      const el = [...document.querySelectorAll("*")]
        .find(e => e.textContent.includes(rangeName));
      if (el) el.click();
    }, rangeName);

    await page.waitForTimeout(2000);

    const numbers = await page.evaluate(() => {

      const rows = [...document.querySelectorAll("tr")];

      return rows
        .filter(r => !r.innerText.toLowerCase().includes("allocated"))
        .map(r => r.innerText.trim())
        .filter(t => /\d{8,}/.test(t));

    });

    if (numbers.length === 0) {
      await browser.close();
      return { success: false, message: "No free numbers in this range" };
    }

    const selected = numbers.slice(0, qty);

    await browser.close();

    return {
      success: true,
      numbers: selected
    };

  } catch (e) {

    await browser.close();
    return { success: false, message: e.message };

  }

}

// CAPTCHA
async function solveMathCaptcha(page) {

  try {

    const text = await page.evaluate(() => document.body.innerText);

    const match = text.match(/(\d+)\s*([+\-])\s*(\d+)/);

    if (!match) return;

    const a = parseInt(match[1]);
    const op = match[2];
    const b = parseInt(match[3]);

    let result;

    if (op === "+") result = a + b;
    if (op === "-") result = a - b;

    await page.type('input[name="captcha"],#captcha', result.toString());

  } catch (e) {
    console.log("captcha skipped");
  }

}

bot.catch(err => console.log("BOT ERROR:", err));

bot.launch({ dropPendingUpdates: true });

console.log("🚀 Lamix Bot Running");
