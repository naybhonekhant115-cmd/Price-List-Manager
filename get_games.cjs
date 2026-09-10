const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://2gethermart.com/');
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="/game/"]')).map(a => ({ name: a.innerText.trim(), href: a.href })).filter(x => x.name);
  });
  console.log(JSON.stringify(links, null, 2));
  await browser.close();
})();
