import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export async function injectSwarmPassword(debugPort = 9223, email = '') {
    try {
        const puppeteer = (await import('puppeteer-core')).default;
        
        // Retry connection a few times while Chrome boots
        let browser;
        for (let i = 0; i < 5; i++) {
            try {
                // Delay 1.5 seconds between retries
                await new Promise(r => setTimeout(r, 1500));
                browser = await puppeteer.connect({ browserURL: `http://localhost:${debugPort}` });
                break;
            } catch (err) {
                if (i === 4) throw new Error('Could not connect to Chrome CDP after 5 attempts');
            }
        }

        logger.info(`[CDP] Connected to Chrome on port ${debugPort} for ${email}`);
        
        // Find the Google Auth page
        const pages = await browser.pages();
        let authPage = pages.find(p => p.url().includes('accounts.google.com') || p.url().includes('oauth'));
        
        if (!authPage) {
            // Wait a bit and check again
            await new Promise(r => setTimeout(r, 2000));
            const newPages = await browser.pages();
            authPage = newPages.find(p => p.url().includes('accounts.google.com') || p.url().includes('oauth'));
        }

        if (!authPage) {
            logger.warn('[CDP] Could not find Google Auth page to inject password.');
            browser.disconnect();
            return;
        }

        // The password we want to inject
        const swarmPassword = process.env.SWARM_PASSWORD || 'Swarmd6f9b714!!2026';

        // Check if we are stuck on the email screen (even though login_hint pre-fills it, we sometimes need to hit Enter)
        try {
            logger.info(`[CDP-DEMO] Looking for email input field...`);
            const emailInput = await authPage.$('input[type="email"]');
            if (emailInput) {
                logger.info(`[CDP-DEMO] Email screen detected. Hitting Enter to advance to password...`);
                await new Promise(r => setTimeout(r, 1500));
                await authPage.keyboard.press('Enter');
            }
        } catch (e) {
            // ignore if not found
        }

        logger.info(`[CDP-DEMO] Waiting for password field to render on screen...`);
        await authPage.waitForSelector('input[type="password"]', { visible: true, timeout: 15000 });
        
        logger.info('[CDP-DEMO] Password field detected! Pausing for 3 seconds so you can verify...');
        await new Promise(r => setTimeout(r, 3000));
        
        logger.info('[CDP-DEMO] Beginning slow-motion password injection...');
        // Type the password extremely slowly (200ms per character) so it's easily observable
        await authPage.type('input[type="password"]', swarmPassword, { delay: 200 });
        
        logger.info('[CDP-DEMO] Password typing complete. Pausing for 2 seconds before submission...');
        await new Promise(r => setTimeout(r, 2000));
        
        logger.info('[CDP-DEMO] Hitting Enter!');
        await authPage.keyboard.press('Enter');
        
        logger.info('[CDP-DEMO] Injection sequence finished.');

        // Disconnect CDP
        browser.disconnect();

    } catch (error) {
        logger.error(`[CDP] Password injection failed: ${error.message}`);
    }
}
