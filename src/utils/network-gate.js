import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GATE_PATH = path.resolve(__dirname, '../../../stack/runtime/network-traffic-gate.json');

export function readNetworkGate() {
    try {
        const gate = JSON.parse(fs.readFileSync(GATE_PATH, 'utf8'));
        return gate && gate.blocked ? gate : null;
    } catch {
        return null;
    }
}

export function sendNetworkUnavailable(res, gate = readNetworkGate()) {
    if (!gate || res.headersSent || res.writableEnded) return false;
    res.setHeader('Retry-After', '15');
    res.status(503).json({
        error: {
            type: 'network_unavailable',
            message: 'SolidStack is holding outbound AI traffic while network recovery runs.',
            detail: gate.reason || 'Network path is temporarily unavailable.',
            retry_after_seconds: 15,
        },
    });
    return true;
}
