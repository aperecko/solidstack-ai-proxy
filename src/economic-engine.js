import fs from 'fs';
import path from 'path';

// Pre-calculated pricing based on typical model costs (USD per 1M tokens)
const MARKET_RATES_USD = {
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'claude-3-7-sonnet': { input: 3.00, output: 15.00 },
    'default': { input: 1.00, output: 3.00 }
};

// Static CAD conversion for now (can be made dynamic)
const USD_TO_CAD = 1.35;

let lorePools = null;

function loadLorePools() {
    if (lorePools) return lorePools;
    lorePools = [];
    const loreDir = path.resolve('../registry/lore');
    try {
        const files = fs.readdirSync(loreDir);
        for (const file of files) {
            if (file.startsWith('lore-pool-') && file.endsWith('.json')) {
                const data = JSON.parse(fs.readFileSync(path.join(loreDir, file), 'utf-8'));
                lorePools.push(data);
            }
        }
    } catch (e) {
        // Ignore if directory doesn't exist
    }
    return lorePools;
}

export function resolvePoolForAccount(accountEmail) {
    if (!accountEmail) return null;
    const pools = loadLorePools();
    for (const pool of pools) {
        if (pool.billing_topology && pool.billing_topology.shared_profiles) {
            // Find by matching Profile alias (e.g. "Profile 19") 
            // In a real system we'd map email to profile alias, but for now we fallback
            // since we might not have the mapping readily available.
            // Let's assume the email is the key or we just look up by email.
            // Actually, we need to map email to profile name.
        }
    }
    // Simplification for now: Hardcode the email mapping based on chrome_profiles.md
    const profileMap = {
        'assistaius@gmail.com': 'lore-pool-lesley-family',
        'adamtechnicalsolutions@gmail.com': 'lore-pool-lesley-family',
        'falconeerkennels@gmail.com': 'lore-pool-lesley-family',
        
        'aptsoultuions@gmail.com': 'lore-pool-adam-family',
        'apps000123000@gmail.com': 'lore-pool-adam-family',
        'chrisjeomara@gmail.com': 'lore-pool-adam-family',
        'adamperecko@gmail.com': 'lore-pool-adam-family',
        
        'adampps@gmail.com': 'lore-pool-kristen-family'
    };
    
    return profileMap[accountEmail.toLowerCase()] || 'unattributed-pool';
}

export function calculateEconomics(model, inputTokens, outputTokens, accountEmail) {
    const poolId = resolvePoolForAccount(accountEmail);
    
    // Find market rate
    let rates = MARKET_RATES_USD.default;
    for (const key of Object.keys(MARKET_RATES_USD)) {
        if (model && model.includes(key)) {
            rates = MARKET_RATES_USD[key];
            break;
        }
    }
    
    const inputCostUsd = (inputTokens / 1_000_000) * rates.input;
    const outputCostUsd = (outputTokens / 1_000_000) * rates.output;
    const marketValueUsd = inputCostUsd + outputCostUsd;
    
    const marketValueCad = marketValueUsd * USD_TO_CAD;
    
    // Fractional COGS calculation
    // E.g., if subscription is $10 USD/mo and we assume a pool cap of 50M tokens
    // COGS = (Tokens / 50M) * $10 USD
    const assumedMonthlyTokens = 50_000_000;
    const totalTokens = inputTokens + outputTokens;
    let poolMonthlyCostUsd = 10.00; // Default
    if (poolId === 'lore-pool-kristen-family') poolMonthlyCostUsd = 20.00;
    
    const fractionalCogsUsd = (totalTokens / assumedMonthlyTokens) * poolMonthlyCostUsd;
    const actualCogsCad = fractionalCogsUsd * USD_TO_CAD;
    
    return {
        poolId,
        marketValueCad,
        actualCogsCad
    };
}
