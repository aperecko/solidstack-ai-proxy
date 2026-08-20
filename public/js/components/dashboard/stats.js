/**
 * Dashboard Stats Module
 * 职责：根据 Alpine.store('data') 计算账号统计数据
 *
 * 调用时机：
 *   - dashboard 组件 init() 时
 *   - $store.data 更新时（通过 $watch 监听）
 *
 * 统计维度：
 *   - total: 启用账号总数（排除禁用账号）
 *   - active: 有可用配额的账号数
 *   - limited: 配额受限或失效的账号数
 *   - subscription: 按订阅级别分类（ultra/pro/free）
 *
 * @module DashboardStats
 */
window.DashboardStats = window.DashboardStats || {};

/**
 * 更新账号统计数据
 *
 * 统计逻辑：
 *   1. 仅统计启用的账号（enabled !== false）
 *   2. 检查账号下所有追踪模型的配额
 *   3. 如果任一追踪模型配额 <= 5%，则标记为 limited (Rate Limited Cooldown)
 *   4. 如果所有追踪模型配额 > 5%，则标记为 active
 *   5. 状态非 'ok' 的账号归为 limited
 *
 * @param {object} component - Dashboard 组件实例（Alpine.js 上下文）
 * @param {object} component.stats - 统计数据对象（会被修改）
 * @param {number} component.stats.total - 启用账号总数
 * @param {number} component.stats.active - 活跃账号数
 * @param {number} component.stats.limited - 受限账号数
 * @param {object} component.stats.subscription - 订阅级别分布
 * @returns {void}
 */
window.DashboardStats.updateStats = function(component) {
    const accounts = Alpine.store('data').accounts;
    let active = 0, limited = 0;

    // Only count enabled accounts in statistics
    const enabledAccounts = accounts.filter(acc => acc.enabled !== false);

    enabledAccounts.forEach(acc => {
        if (acc.isInvalid) {
            limited++;
            return;
        }

        const limitsObj = acc.limits || {};
        const entries = Object.entries(limitsObj);

        // Filter to entries that actually have data (non-null value)
        const withData = entries.filter(([_, l]) => l !== null && l !== undefined);

        if (withData.length === 0) {
            // No quota data at all (e.g. swarm accounts that haven't been used yet)
            // Treat as active/standby, not rate-limited
            active++;
            return;
        }

        // Check if ANY tracked model with data is rate limited (<= 5%)
        const hasRateLimitedModel = withData.some(([_, l]) => {
            if (l.remainingFraction === null || l.remainingFraction === undefined) return false;
            return l.remainingFraction <= 0.05;
        });

        if (hasRateLimitedModel) {
            limited++;
        } else {
            active++;
        }
    });

    // TOTAL shows only enabled accounts
    component.stats.total = enabledAccounts.length;
    component.stats.active = active;
    component.stats.limited = limited;

    // Calculate model usage for rate limit details
    let totalLimitedModels = 0;
    let totalTrackedModels = 0;

    enabledAccounts.forEach(acc => {
         const entries = Object.entries(acc.limits || {});
         entries.forEach(([id, l]) => {
             // Skip null entries (no data)
             if (l === null || l === undefined) return;
             totalTrackedModels++;
             if (l.remainingFraction !== null && l.remainingFraction !== undefined && l.remainingFraction <= 0.05) {
                 totalLimitedModels++;
             }
         });
    });
    
    component.stats.modelUsage = {
        limited: totalLimitedModels,
        total: totalTrackedModels
    };

    // Calculate subscription tier distribution
    const subscription = { ultra: 0, pro: 0, free: 0, apikey: 0 };
    enabledAccounts.forEach(acc => {
        if (acc.type === 'apikey') {
            subscription.apikey++;
        } else {
            const tier = acc.subscription?.tier || 'free';
            if (tier === 'ultra') {
                subscription.ultra++;
            } else if (tier === 'pro') {
                subscription.pro++;
            } else {
                subscription.free++;
            }
        }
    });
    component.stats.subscription = subscription;
};
