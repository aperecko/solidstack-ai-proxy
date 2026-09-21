import puppeteer from 'puppeteer';
import { logger } from '../utils/logger.js';
import { getSwarmLoginUrl } from '../constants.js';

export async function clearAccountBrowserContext(email) {
    try {
        logger.info(`[Logout] Resetting browser context for ${email}`);
        
        // Connect to existing browser
        const browser = await puppeteer.connect({
            browserURL: 'http://localhost:9222',
            defaultViewport: null
        });

        const contexts = await browser.browserContexts();
        for (const context of contexts) {
            const pages = await context.pages();
            for (const page of pages) {
                const url = page.url();
                if (url.includes(email) || url.includes('microsoftonline')) {
                    await context.clearCookies();
                    await page.goto(getSwarmLoginUrl(email));
                }
            }
        }
    } catch (error) {
        logger.error(`[Logout] Error resetting context for ${email}:`, error);
    }
}
