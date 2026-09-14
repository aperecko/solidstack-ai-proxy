/**
 * HTTP Proxy Support
 * 
 * Configures global fetch to use HTTP proxy from environment variables.
 * Supports: http_proxy, HTTP_PROXY, https_proxy, HTTPS_PROXY
 * Honors NO_PROXY / no_proxy for loop safety (see SKILL: ja3-forward-proxy).
 * 
 * This module should be imported at the very beginning of the application
 * entry point (src/index.js) before any fetch calls are made.
 */

import { Agent, setGlobalDispatcher } from 'undici';
import { EnvHttpProxyAgent } from 'undici';
import { logger } from './logger.js';

/**
 * Initialize proxy support from environment variables
 * Call this once at application startup
 */
export function initProxy() {
    const proxyUrl = process.env.http_proxy ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.HTTPS_PROXY;

    if (!proxyUrl) {
        try {
            setGlobalDispatcher(new Agent({
                connect: {
                    family: 4
                }
            }));
            logger.debug('[Proxy] undici GlobalDispatcher initialized with IPv4 family preference');
        } catch (e) {
            logger.warn(`[Proxy] Failed to set IPv4 Agent: ${e.message}`);
        }
        return;
    }

    // EnvHttpProxyAgent reads HTTPS_PROXY/HTTP_PROXY and honors
    // NO_PROXY / no_proxy. The pinned cloud-code hosts
    // (cloudcode-pa.googleapis.com, daily-cloudcode-pa.googleapis.com)
    // MUST be in NO_PROXY: they resolve to 127.0.0.1 via /etc/hosts, and
    // forwarding their CONNECT through ja3proxy would loop back into the
    // ssl-proxy interceptor on :443. Non-pinned googleapis hosts (e.g.
    // daily-cloudcode-pa.sandbox.googleapis.com) egress through ja3proxy
    // with a Chrome TLS fingerprint.
    try {
        const envProxyAgent = new EnvHttpProxyAgent({
            connect: {
                family: 4
            }
        });
        setGlobalDispatcher(envProxyAgent);
        logger.info(`[Proxy] Using EnvHttpProxyAgent with proxy: ${proxyUrl} (NO_PROXY honored)`);
    } catch (error) {
        logger.error(`[Proxy] Failed to configure proxy: ${error.message}`);
    }
}

// Auto-initialize on import
initProxy();
