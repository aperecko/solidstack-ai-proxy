const puppeteer = require('puppeteer-core');
const fs = require('fs');

const PHONE_NUMBER = process.argv[2];
const EMAIL = '13@adamassist.com';
const PASSWORD = process.env.DEFAULT_PASSWORD || 'Swarmd6f9b714!!2026';
const CODE_FILE = '/tmp/sms_code.txt';

if (fs.existsSync(CODE_FILE)) fs.unlinkSync(CODE_FILE);

async function run() {
    console.log("Connecting to Chrome on port 9223...");
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9223',
        defaultViewport: null
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    
    try {
        console.log("Navigating to AddSession...");
        await page.goto('https://accounts.google.com/AddSession', { waitUntil: 'networkidle2', timeout: 30000 });
        
        let currentState = "START";
        let loopCount = 0;
        
        while (currentState !== "SUCCESS" && loopCount < 15) {
            loopCount++;
            await new Promise(r => setTimeout(r, 2000));
            
            const html = await page.evaluate(() => document.body.innerHTML);
            const url = page.url();
            
            if (url.includes('myaccount.google.com') || url.includes('myaccount.google.com/u/')) {
                console.log("State: SUCCESS (Logged in)");
                currentState = "SUCCESS";
                break;
            }
            
            if (html.includes('identifierId') && !url.includes('login.microsoftonline.com')) {
                console.log("State: GOOGLE_EMAIL_PROMPT");
                await page.waitForSelector('#identifierId', { visible: true });
                await page.evaluate(() => document.querySelector('#identifierId').value = '');
                await page.type('#identifierId', EMAIL, { delay: 50 });
                await page.keyboard.press('Enter');
                continue;
            }
            
            // Microsoft Email Prompt (Look for i0116 and verify it is visible)
            const msEmailVisible = await page.evaluate(() => {
                const el = document.querySelector('#i0116');
                return el && el.offsetParent !== null;
            });
            if (msEmailVisible) {
                console.log("State: MICROSOFT_EMAIL_PROMPT");
                await page.evaluate(() => document.querySelector('#i0116').value = '');
                await page.type('#i0116', EMAIL, { delay: 50 });
                await page.keyboard.press('Enter');
                continue;
            }
            
            // Microsoft Password Prompt
            const msPassVisible = await page.evaluate(() => {
                const el = document.querySelector('#i0118');
                return el && el.offsetParent !== null;
            });
            if (msPassVisible) {
                console.log("State: MICROSOFT_PASSWORD_PROMPT");
                await page.evaluate(() => document.querySelector('#i0118').value = '');
                await page.type('#i0118', PASSWORD, { delay: 50 });
                await page.keyboard.press('Enter');
                continue;
            }
            
            // Microsoft Stay Signed In (Look for KMSI)
            if (html.includes('Stay signed in?') || html.includes('KmsiCheckboxField')) {
                console.log("State: MICROSOFT_STAY_SIGNED_IN");
                await page.click('#idSIButton9');
                continue;
            }
            
            // Google Verify Phone Challenge
            const phoneInputVisible = await page.evaluate(() => {
                const el = document.querySelector('input[type="tel"]');
                return el && el.offsetParent !== null;
            });
            
            if (phoneInputVisible && !html.includes('Enter code')) {
                console.log("State: GOOGLE_VERIFY_CHALLENGE (Inputting Phone Number)");
                await page.evaluate(() => document.querySelector('input[type="tel"]').value = '');
                await page.type('input[type="tel"]', PHONE_NUMBER, { delay: 100 });
                await page.keyboard.press('Enter');
                continue;
            }
            
            // SMS Code Entry
            if (html.includes('Enter code') || html.includes('aria-label="Enter code"')) {
                console.log("WAITING_FOR_CODE");
                let code = null;
                for (let i = 0; i < 120; i++) { // wait up to 4 minutes
                    if (fs.existsSync(CODE_FILE)) {
                        code = fs.readFileSync(CODE_FILE, 'utf8').trim();
                        break;
                    }
                    await new Promise(r => setTimeout(r, 2000));
                }
                
                if (code) {
                    console.log("Code received! Entering it into Google...");
                    await page.keyboard.type(code, { delay: 100 });
                    await page.keyboard.press('Enter');
                    fs.unlinkSync(CODE_FILE);
                    continue; // Loop will verify SUCCESS
                } else {
                    console.log("TIMED_OUT waiting for SMS code.");
                    break;
                }
            }
            
            console.log(`State: UNKNOWN. Current URL: ${url}`);
        }
        
        await page.screenshot({ path: 'final_interactive_state.png' });
        
    } catch(e) {
        console.error(`Error:`, e.message);
        await page.screenshot({ path: 'error_interactive.png' });
    } finally {
        // Do not close page
        browser.disconnect();
    }
}

run();
