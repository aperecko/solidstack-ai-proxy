import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

const BASE_DIR = path.join(process.cwd(), 'ai-proxy');
const API_FILE = path.join(BASE_DIR, 'src', 'commander-api.js');
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const DEFICIT_LEDGER = path.join(BASE_DIR, 'scratch', 'dark-apis-ledger.json');

/**
 * Scans the codebase for "Dark APIs" — backend endpoints that exist 
 * but are never called by the frontend UI.
 */
export function scanForDarkAPIs() {
    logger.info(`[DarkAPI-Scanner] Starting scan for orphaned backend capabilities...`);

    if (!fs.existsSync(API_FILE)) {
        logger.warn(`[DarkAPI-Scanner] Cannot find commander-api.js`);
        return;
    }

    // 1. Extract all registered API routes
    const apiCode = fs.readFileSync(API_FILE, 'utf8');
    const routeRegex = /router\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g;
    
    const endpoints = [];
    let match;
    while ((match = routeRegex.exec(apiCode)) !== null) {
        let route = match[2];
        // Normalize route to handle path params (e.g., /services/:id/toggle -> /services/)
        const normalizedMatch = route.match(/^(\/[a-zA-Z0-9\-_]+)/);
        if (normalizedMatch) {
            endpoints.push({
                method: match[1].toUpperCase(),
                fullRoute: route,
                baseRoute: normalizedMatch[1]
            });
        }
    }

    // 2. Scan all frontend files for references to these routes
    const frontendFiles = [];
    function walkDir(dir) {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isDirectory()) {
                walkDir(fullPath);
            } else if (file.endsWith('.html') || file.endsWith('.js')) {
                frontendFiles.push(fullPath);
            }
        }
    }
    walkDir(PUBLIC_DIR);

    let allFrontendCode = '';
    for (const file of frontendFiles) {
        allFrontendCode += fs.readFileSync(file, 'utf8') + '\n';
    }

    // 3. Identify Dark APIs
    const darkAPIs = [];
    for (const ep of endpoints) {
        // Look for the base route in the frontend code (e.g., fetch('/api/routing-mode'))
        // Note: commander-api routes are usually prefixed with /api in the main server.js
        const expectedFetchPath = `/api${ep.baseRoute}`;
        
        if (!allFrontendCode.includes(expectedFetchPath) && !allFrontendCode.includes(ep.baseRoute)) {
            darkAPIs.push({
                method: ep.method,
                route: `/api${ep.fullRoute}`,
                detected_at: new Date().toISOString(),
                status: 'ORPHANED_BACKEND_CAPABILITY',
                recommended_action: `Generate frontend UI view in ai-proxy/public/views/ to expose this capability.`
            });
        }
    }

    // 4. Update the Deficit Ledger
    fs.mkdirSync(path.dirname(DEFICIT_LEDGER), { recursive: true });
    fs.writeFileSync(DEFICIT_LEDGER, JSON.stringify(darkAPIs, null, 2), 'utf8');

    logger.success(`[DarkAPI-Scanner] Scan complete. Found ${darkAPIs.length} orphaned endpoints.`);
    if (darkAPIs.length > 0) {
        logger.warn(`[DarkAPI-Scanner] Action Required: The Overnight Evolution Engine should generate UI for these endpoints.`);
    }

    return darkAPIs;
}

// Allow running standalone: node ai-proxy/src/modules/dark-api-scanner.js
if (import.meta.url === `file://${process.argv[1]}`) {
    scanForDarkAPIs();
}
