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
        console.log("Navigating to Google Login...");
        await page.goto('https://accounts.google.com/ServiceLogin', { waitUntil: 'networkidle2', timeout: 30000 });
        
        console.log("Waiting 3s for any redirects...");
        await new Promise(r => setTimeout(r, 3000));
        
        const url = page.url();
        console.log(`Current URL: ${url}`);
        
        // Capture perceptual state
        await page.screenshot({ path: 'perceptual_state_1.png' });
        
        // Extract key identifiers to build the state machine safely
        const state = await page.evaluate(() => {
            return {
                title: document.title,
                inputs: Array.from(document.querySelectorAll('input')).map(i => ({ type: i.type, name: i.name, id: i.id })),
                buttons: Array.from(document.querySelectorAll('button, input[type="submit"]')).map(b => b.innerText || b.value)
            };
        });
        
        fs.writeFileSync('perceptual_state_1.json', JSON.stringify(state, null, 2));
        console.log("State snapshot saved.");
        
    } catch (e) {
        console.error(`Error:`, e.message);
    } finally {
        // Do not close the page so you can see it visually if you want, just disconnect.
        browser.disconnect();
    }
}

snapshotState();
