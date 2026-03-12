async function allocateNumbers(clientId, country, rangeName, qty) {

  console.log("-----------");
  console.log("Starting allocation");
  console.log("Client:", clientId);
  console.log("Country:", country);
  console.log("Range:", rangeName);

  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });

  const page = await browser.newPage();

  try {

    console.log("Opening login page");

    await page.goto(process.env.LAMIX_URL + "/login", {
      waitUntil: "domcontentloaded"
    });

    console.log("Waiting for username field");

    await page.waitForSelector('input[name="username"]');

    console.log("Typing username");

    await page.type('input[name="username"]', process.env.LAMIX_USER, { delay: 40 });

    console.log("Typing password");

    await page.type('input[name="password"]', process.env.LAMIX_PASS, { delay: 40 });

    console.log("Solving captcha");

    const text = await page.evaluate(() => document.body.innerText);

    const match = text.match(/(\d+)\s*\+\s*(\d+)/);

    if (match) {

      const a = parseInt(match[1]);
      const b = parseInt(match[2]);
      const result = a + b;

      console.log(`Captcha solved: ${a}+${b}=${result}`);

      await page.type('input[name="capt"]', result.toString(), { delay: 40 });

    } else {

      console.log("Captcha not detected");

    }

    console.log("Submitting login");

    await page.click("button");

    await page.waitForNavigation({ timeout: 20000 });

    const currentUrl = page.url();

    if (currentUrl.includes("login")) {

      console.log("LOGIN FAILED ❌");

      await browser.close();

      return { success: false, message: "Login failed" };

    }

    console.log("LOGIN SUCCESS ✅");

    console.log("Opening numbers page");

    await page.goto(process.env.LAMIX_URL + "/numbers", {
      waitUntil: "networkidle2"
    });

    console.log("Opening range:", rangeName);

    await page.evaluate((rangeName) => {

      const el = [...document.querySelectorAll("*")]
        .find(e => e.textContent.includes(rangeName));

      if (el) el.click();

    }, rangeName);

    await page.waitForTimeout(2000);

    console.log("Collecting numbers");

    const numbers = await page.evaluate(() => {

      const rows = [...document.querySelectorAll("tr")];

      return rows
        .filter(r => !r.innerText.toLowerCase().includes("allocated"))
        .map(r => r.innerText.trim())
        .filter(t => /\d{8,}/.test(t));

    });

    console.log("Numbers found:", numbers.length);

    if (numbers.length === 0) {

      await browser.close();

      return { success: false, message: "No free numbers in this range" };

    }

    const selected = numbers.slice(0, qty);

    console.log("Selected numbers:", selected);

    await browser.close();

    return {
      success: true,
      numbers: selected
    };

  } catch (e) {

    console.log("ERROR:", e.message);

    await browser.close();

    return { success: false, message: e.message };

  }

}
