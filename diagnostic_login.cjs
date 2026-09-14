const puppeteer = require('puppeteer-core');


const ACCOUNTS_TO_RECOVER = [
    "13@adamassist.com"
];

async function run() {
    console.log("Connecting to Chrome on port 9222...");
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null
    });

    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    
    try {
        console.log("Navigating to Google Login...");
        await page.goto('https://accounts.google.com/AccountChooser/signinchooser?flowName=GlifWebSignIn&flowEntry=AccountChooser', { waitUntil: 'networkidle2' });
        
        console.log("Waiting for identifier field...");
        await page.waitForSelector('#identifierId', { timeout: 10000 });
        console.log("Typing email...");
        await page.type('#identifierId', ACCOUNTS_TO_RECOVER[0], { delay: 50 });
        await page.keyboard.press('Enter');
        
        await new Promise(r => setTimeout(r, 4000));
        
        console.log("Checking page state...");
        const html = await page.evaluate(() => document.body.innerHTML);
        if (html.includes('password')) {
            console.log("Password field found.");
        } else if (html.includes('Verify it')) {
            console.log("Verification challenge found.");
        } else {
            console.log("Unknown state.");
        }
        
    } catch (e) {
        console.error(`Error:`, e.message);
    } finally {
        await page.close();
        await context.close();
        browser.disconnect();
    }
}

run();
