const puppeteer = require('puppeteer-core');
const fs = require('fs');
const { execSync } = require('child_process');
const fetch = require('node-fetch');

const VOIP_USER = process.env.VOIPMS_API_USERNAME;
const VOIP_PASS = process.env.VOIPMS_API_PASSWORD;
const DIDs = ["6476002326", "6476002327"];
const ACCOUNTS_TO_RECOVER = [
    "13@adamassist.com",
    "14@adamassist.com",
    "15@adamassist.com"
];
const PASSWORD = process.env.DEFAULT_PASSWORD || 'Swarmd6f9b714!!2026';

async function getSMSCode(did, afterTimestamp) {
    console.log(`Polling VoIP.ms for new SMS on DID ${did}...`);
    const dateStr = new Date().toISOString().split('T')[0];
    const url = `https://voip.ms/api/v1/rest.php?api_username=${encodeURIComponent(VOIP_USER)}&api_password=${encodeURIComponent(VOIP_PASS)}&method=getSMS&from=${dateStr}&to=${dateStr}&did=${did}`;
    
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 4000));
        try {
            const fetch = (await import('node-fetch')).default;
            const res = await fetch(url);
            const data = await res.json();
            if (data.status === 'success' && data.sms) {
                const messages = Array.isArray(data.sms) ? data.sms : [data.sms];
                for (const msg of messages) {
                    const msgTime = new Date(msg.date).getTime();
                    if (msgTime > afterTimestamp) {
                        const match = msg.message.match(/G-(\d{6})/);
                        if (match) {
                            console.log(`✅ Extracted Google Code: ${match[1]}`);
                            return match[1];
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`SMS Fetch Error:`, e.message);
        }
    }
    return null;
}

async function run() {
    console.log("Connecting to Chrome on port 9222...");
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null
    });

    let didIndex = 0;

    for (const email of ACCOUNTS_TO_RECOVER) {
        console.log(`\n========================================`);
        console.log(`Attempting to recover: ${email}`);
        
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        
        try {
            await page.goto('https://accounts.google.com/ServiceLogin');
            
            try {
                await page.waitForSelector('#identifierId', { timeout: 15000 });
                await page.type('#identifierId', email, { delay: 50 });
            } catch (e) {
                console.log(`Failed to find #identifierId, taking screenshot...`);
                await page.screenshot({ path: `error_${email}.png` });
                throw e;
            }
            await page.keyboard.press('Enter');
            
            // Wait for password or challenge
            await new Promise(r => setTimeout(r, 3000));
            
            const isPassword = await page.$('input[type="password"]');
            if (isPassword) {
                await page.type('input[type="password"]', PASSWORD, { delay: 50 });
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 4000));
            }

            // Check if we hit the "Verify it's you" screen
            const bodyText = await page.evaluate(() => document.body.innerText);
            if (bodyText.includes("Verify it's you") || bodyText.includes("unusual activity")) {
                console.log("Hit verification screen. Proceeding with SMS recovery.");
                
                // If it asks for a phone number input
                const phoneInput = await page.$('input[type="tel"]');
                if (phoneInput) {
                    const did = DIDs[didIndex % 2];
                    didIndex++;
                    console.log(`Inputting DID: ${did}`);
                    await page.type('input[type="tel"]', did, { delay: 100 });
                    
                    // Hit Next/Send
                    await page.keyboard.press('Enter');
                    
                    const reqTime = Date.now() - 60000; // Look at last minute
                    console.log("Waiting for code input box...");
                    await page.waitForSelector('input[type="tel"], input[aria-label="Enter code"]', { timeout: 10000 });
                    
                    const code = await getSMSCode(did, reqTime);
                    if (code) {
                        await page.keyboard.type(code, { delay: 100 });
                        await page.keyboard.press('Enter');
                        await new Promise(r => setTimeout(r, 5000));
                        console.log(`✅ ${email} recovered successfully!`);
                    } else {
                        console.log(`❌ No code received for ${email}.`);
                    }
                } else {
                    console.log("Could not find phone input field. Manual intervention might be needed.");
                }
            } else {
                console.log(`No verification challenge detected for ${email}. It might already be unlocked or blocked differently.`);
                await page.screenshot({ path: `status_${email}.png` });
            }

        } catch (e) {
            console.error(`Error processing ${email}:`, e.message);
        } finally {
            try { await page.close(); } catch(e){}
            // Omit context.close() to prevent Chrome from crashing
        }
    }
    
    browser.disconnect();
    console.log("Done.");
}

run();
