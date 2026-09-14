const puppeteer = require('puppeteer-core');

async function punch() {
    const browser = await puppeteer.connect({ browserURL: 'http://localhost:9223', defaultViewport: null });
    const pages = await browser.pages();
    const page = pages[0];
    
    console.log("Entering phone number...");
    await page.evaluate(() => document.querySelector('#phoneNumberId').value = ''); // sometimes it's phoneNumberId
    // or just tel
    await page.type('input[type="tel"]', '5184197151', { delay: 100 });
    
    console.log("Clicking Next...");
    await page.evaluate(() => {
        let buttons = Array.from(document.querySelectorAll('button'));
        let next = buttons.find(b => b.innerText.includes('Next'));
        if (next) next.click();
    });
    
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: 'after_phone.png' });
    browser.disconnect();
}
punch();
