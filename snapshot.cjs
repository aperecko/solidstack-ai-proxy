const puppeteer = require('puppeteer-core');

async function snapshot() {
    const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
    const pages = await browser.pages();
    // Assuming the active page is the last one
    const page = pages[pages.length - 1];
    await page.screenshot({ path: 'stuck_state.png' });
    const html = await page.evaluate(() => document.body.innerHTML);
    require('fs').writeFileSync('stuck_state.html', html);
    browser.disconnect();
}
snapshot();
