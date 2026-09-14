const puppeteer = require('puppeteer-core');
const fs = require('fs');

async function snapshotState() {
    console.log("Connecting to Chrome on port 9222...");
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null
    });

    const page = await browser.newPage();
    
    try {
        console.log("Navigating to AddSession...");
        await page.goto('https://accounts.google.com/AddSession', { waitUntil: 'networkidle2', timeout: 30000 });
        
        await new Promise(r => setTimeout(r, 2000));
        
        console.log(`Current URL: ${page.url()}`);
        await page.screenshot({ path: 'perceptual_addsession.png' });
        
        const state = await page.evaluate(() => {
            return {
                title: document.title,
                inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, id: i.id })),
                buttons: Array.from(document.querySelectorAll('button, input[type="submit"]')).map(b => b.innerText || b.value)
            };
        });
        
        fs.writeFileSync('perceptual_addsession.json', JSON.stringify(state, null, 2));
        console.log("AddSession snapshot saved.");
        
    } catch (e) {
        console.error(`Error:`, e.message);
    } finally {
        browser.disconnect();
    }
}

snapshotState();
