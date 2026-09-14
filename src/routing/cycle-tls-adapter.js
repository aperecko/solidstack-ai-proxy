const initCycleTLS = require('cycletls');

let cycleTLSInstance = null;
let isInitialized = false;

async function getCycleTLS() {
    if (!isInitialized) {
        cycleTLSInstance = await initCycleTLS();
        isInitialized = true;
    }
    return cycleTLSInstance;
}

/**
 * Spoofs a TLS JA3 fingerprint and proxies the request to the upstream server.
 * 
 * @param {string} url - The full upstream URL (e.g., https://cloudcode-pa.googleapis.com/v1/...)
 * @param {object} options - Request options (method, headers, body, ja3)
 * @returns {object} The response from CycleTLS
 */
async function requestWithSpoofedTLS(url, options) {
    const cycle = await getCycleTLS();
    
    // Select a randomized or pinned JA3 fingerprint for Chrome
    // In a full implementation, this could map to the account ID to pin the fingerprint
    const defaultChromeJa3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513-21,29-23-24,0';
    
    const cycleOptions = {
        ja3: options.ja3 || defaultChromeJa3,
        userAgent: options.headers['user-agent'] || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        body: options.body,
        headers: options.headers,
        timeout: options.timeout || 30000,
    };

    try {
        const response = await cycle(url, cycleOptions, options.method || 'GET');
        return {
            status: response.status,
            headers: response.headers,
            body: response.body
        };
    } catch (error) {
        console.error(`[CycleTLS Adapter] Error requesting ${url}:`, error.message);
        throw error;
    }
}

/**
 * Gracefully close the Go sidecar
 */
function closeAdapter() {
    if (cycleTLSInstance) {
        cycleTLSInstance.exit();
        isInitialized = false;
    }
}

module.exports = {
    requestWithSpoofedTLS,
    closeAdapter
};
