/**
 * Shared SOCKS5 Proxy Agent Utility
 *
 * Provides cached SocksProxyAgent instances for PrivadoVPN mesh egress nodes.
 */

import { SocksProxyAgent } from 'socks-proxy-agent';

export const SOCKS_CREDENTIALS = {
    user: 'nhrekww83362',
    pass: 'jgu4y8kedp6w'
};

const socksAgentCache = new Map();

/**
 * Get or create a SocksProxyAgent for a specified egress node.
 * @param {string} egressNode - Hostname of the SOCKS node (e.g. 'dfw.socks.privado.io')
 * @returns {SocksProxyAgent|undefined}
 */
export function getSocksAgent(egressNode) {
    if (!egressNode || egressNode === 'local') return undefined;
    if (socksAgentCache.has(egressNode)) return socksAgentCache.get(egressNode);
    
    const proxyUrl = `socks5h://${SOCKS_CREDENTIALS.user}:${SOCKS_CREDENTIALS.pass}@${egressNode}:1080`;
    const agent = new SocksProxyAgent(proxyUrl);
    socksAgentCache.set(egressNode, agent);
    return agent;
}

/**
 * Clear the in-memory SOCKS agent cache.
 */
export function clearSocksAgentCache() {
    socksAgentCache.clear();
}
