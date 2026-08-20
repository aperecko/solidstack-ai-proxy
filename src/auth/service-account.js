/**
 * Google Workspace Domain-Wide Delegation Auth
 *
 * Provides functionality to generate short-lived OAuth 2.0 access tokens
 * for reseller accounts via Service Account impersonation.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../utils/logger.js';
import { OAUTH_CONFIG } from '../constants.js';

// Define where the service account key will reside
export const SERVICE_ACCOUNT_KEY_PATH = path.join(homedir(), '.config', 'antigravity-proxy', 'service-account.json');

let cachedKeyExists = null;

/**
 * Check if the service account key is available
 */
export function hasServiceAccountKey() {
    if (cachedKeyExists !== null) {
        return cachedKeyExists;
    }
    cachedKeyExists = existsSync(SERVICE_ACCOUNT_KEY_PATH);
    return cachedKeyExists;
}

/**
 * Generate an access token for an impersonated user
 * @param {string} userEmail - The email address of the workspace user to impersonate
 * @returns {Promise<{accessToken: string, expiresAt: number}>}
 */
export async function getDelegatedAccessToken(userEmail) {
    if (!hasServiceAccountKey()) {
        throw new Error(`Service account key not found at ${SERVICE_ACCOUNT_KEY_PATH}. Cannot authenticate ${userEmail}.`);
    }

    try {
        const auth = new GoogleAuth({
            keyFile: SERVICE_ACCOUNT_KEY_PATH,
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
            clientOptions: {
                subject: userEmail
            }
        });

        const client = await auth.getClient();
        
        // Force refresh to get a new token
        const tokens = await client.getAccessToken();
        
        if (!tokens.token) {
            throw new Error('Failed to retrieve access token via Domain-Wide Delegation');
        }

        logger.debug(`[Auth] Generated delegated token for ${userEmail}`);
        
        return {
            accessToken: tokens.token,
            // Google tokens usually expire in 1 hour (3600 seconds)
            expiresAt: Date.now() + (3500 * 1000) 
        };
    } catch (error) {
        logger.error(`[Auth] DWD error for ${userEmail}:`, error.message);
        throw error;
    }
}
