/**
 * Account Manager Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.accountManager = () => ({
    searchQuery: '',
    deleteTarget: '',
    refreshing: false,
    toggling: false,
    deleting: false,
    reloading: false,
    selectedAccountEmail: '',
    selectedAccountLimits: {},
    selectedAccount: null,
    quotaModalShowDetails: false,
    currentPage: 1,
    pageSize: 50,
    sortCol: 'email',
    sortAsc: true,

    // Health Inspector (Developer Mode)
    healthData: {},
    healthLoading: false,

    init() {
        if (Alpine.store('data').devMode && Alpine.store('settings').healthInspectorOpen) {
            this.fetchHealthData();
        }
    },

    setSort(col) {
        if (this.sortCol === col) {
            this.sortAsc = !this.sortAsc;
        } else {
            this.sortCol = col;
            // Default descending for metrics/numbers, ascending for text
            this.sortAsc = !['quota', 'health', 'enabled'].includes(col);
        }
    },

    compareAccounts(a, b) {
        const dir = this.sortAsc ? 1 : -1;
        
        switch (this.sortCol) {
            case 'enabled': {
                const aVal = a.enabled !== false ? 1 : 0;
                const bVal = b.enabled !== false ? 1 : 0;
                if (aVal !== bVal) return (aVal - bVal) * dir;
                return a.email.localeCompare(b.email);
            }
            case 'source': {
                const aVal = a.source || 'oauth';
                const bVal = b.source || 'oauth';
                if (aVal !== bVal) return aVal.localeCompare(bVal) * dir;
                return a.email.localeCompare(b.email);
            }
            case 'tier': {
                const TIER_RANK = { ultra: 5, pro: 4, plus: 3, apikey: 2, free: 1, unknown: 0 };
                const aTier = a.type === 'apikey' ? 'apikey' : (a.subscription?.tier || a.tier || 'free').toLowerCase();
                const bTier = b.type === 'apikey' ? 'apikey' : (b.subscription?.tier || b.tier || 'free').toLowerCase();
                const aRank = TIER_RANK[aTier] ?? 0;
                const bRank = TIER_RANK[bTier] ?? 0;
                if (aRank !== bRank) return (aRank - bRank) * dir;
                return a.email.localeCompare(b.email);
            }
            case 'quota': {
                const aQ = this.getAccountGroupedQuotas(a);
                const bQ = this.getAccountGroupedQuotas(b);
                const aVal = Math.max(aQ.claude?.percent ?? -1, aQ.gemini?.percent ?? -1);
                const bVal = Math.max(bQ.claude?.percent ?? -1, bQ.gemini?.percent ?? -1);
                if (aVal !== bVal) return (aVal - bVal) * dir;
                return a.email.localeCompare(b.email);
            }
            case 'health': {
                const HEALTH_RANK = { ok: 3, limited: 2, invalid: 1, banned: 0 };
                const aVal = HEALTH_RANK[a.status] ?? (a.isInvalid ? 1 : 3);
                const bVal = HEALTH_RANK[b.status] ?? (b.isInvalid ? 1 : 3);
                if (aVal !== bVal) return (aVal - bVal) * dir;
                return a.email.localeCompare(b.email);
            }
            case 'email':
            default: {
                return a.email.localeCompare(b.email) * dir;
            }
        }
    },

    get filteredAccounts() {
        const dataStore = Alpine.store('data');
        let accounts = dataStore.accounts || [];
        
        if (dataStore.filters && dataStore.filters.status === 'limited') {
            accounts = accounts.filter(acc => {
                if (acc.isInvalid) return true;
                // Check limits (remainingFraction) for quota exhaustion
                const limitsObj = acc.limits || {};
                for (const [model, l] of Object.entries(limitsObj)) {
                    if (l && l.remainingFraction !== null && l.remainingFraction !== undefined && l.remainingFraction <= 0.05) return true;
                }
                // Also check modelRateLimits for hard 429 blocks
                if (acc.modelRateLimits) {
                    for (const model of Object.keys(acc.modelRateLimits)) {
                        if (acc.modelRateLimits[model].isRateLimited) return true;
                    }
                }
                return false;
            });
        }
        
        let result = accounts;
        
        if (this.searchQuery && this.searchQuery.trim() !== '') {
            const query = this.searchQuery.toLowerCase().trim();
            result = accounts.filter(acc => {
                return acc.email.toLowerCase().includes(query) ||
                       (acc.projectId && acc.projectId.toLowerCase().includes(query)) ||
                       (acc.source && acc.source.toLowerCase().includes(query));
            });
        }
        
        return result.sort((a, b) => this.compareAccounts(a, b));
    },
    
    get pagedAccounts() {
        const start = (this.currentPage - 1) * this.pageSize;
        return this.filteredAccounts.slice(start, start + this.pageSize);
    },
    
    poolExpanded: {},
    
    get pagedAccountPools() {
        const pageAccs = this.pagedAccounts;
        
        const FAMILY_MAP = {
          'aptsoultuions@gmail.com': 'Adam\'s Family (Pro)',
          'apps000123000@gmail.com': 'Adam\'s Family (Pro)',
          'chrisjeomara@gmail.com': 'Adam\'s Family (Pro)',
          'adamperecko@gmail.com': 'Adam\'s Family (Pro)',
          'assistaius@gmail.com': 'Lesley\'s Family (Pro) [US]',
          'adamtechnicalsolutions@gmail.com': 'Lesley\'s Family (Pro) [US]',
          'falconeerkennels@gmail.com': 'Lesley\'s Family (Pro) [US]',
          'adampps@gmail.com': 'Kristen\'s Family (Plus) [US]',
          'haliburtonarcher@gmail.com': 'Standby Family'
        };

        const poolsMap = {};
        for (const acc of pageAccs) {
            let poolName = 'Individual Accounts';
            if (FAMILY_MAP[acc.email]) {
                poolName = FAMILY_MAP[acc.email];
            } else if (acc.email === 'adam@adamassist.com') {
                poolName = 'Individual Accounts';
            } else if (acc.email.endsWith('@adamassist.com')) {
                poolName = 'AdamAssist Swarm';
            } else if (acc.email.endsWith('@reseller.mysolidstate.ca')) {
                poolName = 'Reseller Swarm';
            }
            
            const needsFixing = acc.isInvalid || (acc.status && acc.status !== 'active' && acc.status !== 'ready' && acc.status !== 'ok');

            if (!poolsMap[poolName]) {
                poolsMap[poolName] = { 
                    name: poolName, 
                    accounts: [], 
                    maxClaudePercent: null,
                    maxGeminiPercent: null,
                    hasIssues: false
                };
            }

            if (needsFixing) {
                poolsMap[poolName].hasIssues = true;
            }

            poolsMap[poolName].accounts.push(acc);
            
            const limits = acc.limits || {};

            // Calculate max Claude quota for this pool ONLY on eligible Claude accounts (Pro, Ultra, Plus)
            const tier = (acc.subscription?.tier || acc.tier || 'free').toLowerCase();
            const isEligibleClaude = ['pro', 'ultra', 'plus'].includes(tier) && acc.type !== 'apikey' && !acc.email.includes('virtual-gemini-key') && !acc.isInvalid;

            if (isEligibleClaude) {
                let maxClaude = -1;
                for (const [id, l] of Object.entries(limits)) {
                    if (id.includes('claude') && l && l.remainingFraction !== undefined && l.remainingFraction !== null) {
                         const pct = Math.round(l.remainingFraction * 100);
                         if (pct > maxClaude) maxClaude = pct;
                    }
                }
                if (maxClaude > -1) {
                    if (poolsMap[poolName].maxClaudePercent === null || maxClaude > poolsMap[poolName].maxClaudePercent) {
                        poolsMap[poolName].maxClaudePercent = maxClaude;
                    }
                }
            }

            // Calculate max Gemini quota for this pool
            let maxGemini = -1;
            for (const [id, l] of Object.entries(limits)) {
                if (id.includes('gemini') && l && l.remainingFraction !== undefined && l.remainingFraction !== null) {
                     const pct = Math.round(l.remainingFraction * 100);
                     if (pct > maxGemini) maxGemini = pct;
                }
            }
            if (maxGemini > -1) {
                if (poolsMap[poolName].maxGeminiPercent === null || maxGemini > poolsMap[poolName].maxGeminiPercent) {
                    poolsMap[poolName].maxGeminiPercent = maxGemini;
                }
            }
        }
        
        return Object.values(poolsMap).map(pool => {
            pool.accounts.sort((a, b) => this.compareAccounts(a, b));
            return pool;
        }).sort((a, b) => {
            if (this.sortCol === 'health') {
                if (a.hasIssues && !b.hasIssues) return this.sortAsc ? 1 : -1;
                if (!a.hasIssues && b.hasIssues) return this.sortAsc ? -1 : 1;
            } else if (this.sortCol === 'quota') {
                const aMax = Math.max(a.maxClaudePercent ?? -1, a.maxGeminiPercent ?? -1);
                const bMax = Math.max(b.maxClaudePercent ?? -1, b.maxGeminiPercent ?? -1);
                if (aMax !== bMax) return (aMax - bMax) * (this.sortAsc ? 1 : -1);
            }
            if (a.name === 'Individual Accounts') return 1;
            if (b.name === 'Individual Accounts') return -1;
            const aIsFamily = a.name.includes('Family');
            const bIsFamily = b.name.includes('Family');
            if (aIsFamily && !bIsFamily) return -1;
            if (!aIsFamily && bIsFamily) return 1;
            return a.name.localeCompare(b.name);
        });
    },
    
    togglePool(poolName) {
        try {
            console.log("togglePool called for:", poolName);
            const pool = this.pagedAccountPools.find(p => p.name === poolName);
            const currentState = this.poolExpanded[poolName] !== undefined ? this.poolExpanded[poolName] : (pool ? pool.hasIssues : false);
            console.log("Current state:", currentState, "Setting to:", !currentState);
            
            // Reassign to ensure Alpine reactivity
            this.poolExpanded = { ...this.poolExpanded, [poolName]: !currentState };
        } catch (e) {
            console.error("Error in togglePool:", e);
        }
    },
    
    get totalPages() {
        return Math.ceil(this.filteredAccounts.length / this.pageSize);
    },

    formatEmail(email) {
        if (!email || email.length <= 40) return email;

        const [user, domain] = email.split('@');
        if (!domain) return email;

        // Preserve domain integrity, truncate username if needed
        if (user.length > 20) {
            return `${user.substring(0, 10)}...${user.slice(-5)}@${domain}`;
        }
        return email;
    },

    async refreshAccount(email) {
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');
            store.showToast(store.t('refreshingAccount', { email: Redact.email(email) }), 'info');

            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}/refresh`,
                { method: 'POST' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('refreshedAccount', { email: Redact.email(email) }), 'success');
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || store.t('refreshFailed'));
            }
        }, this, 'refreshing', { errorMessage: 'Failed to refresh account' });
    },

    async toggleAccount(email, enabled) {
        const store = Alpine.store('global');
        const password = store.webuiPassword;

        // Optimistic update: immediately update UI
        const dataStore = Alpine.store('data');
        const account = dataStore.accounts.find(a => a.email === email);
        if (account) {
            account.enabled = enabled;
        }

        try {
            const { response, newPassword } = await window.utils.request(`/api/accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            }, password);
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const status = enabled ? store.t('enabledStatus') : store.t('disabledStatus');
                store.showToast(store.t('accountToggled', { email: Redact.email(email), status }), 'success');
                // Refresh to confirm server state
                await dataStore.fetchData();
            } else {
                store.showToast(data.error || store.t('toggleFailed'), 'error');
                // Rollback optimistic update on error
                if (account) {
                    account.enabled = !enabled;
                }
                await dataStore.fetchData();
            }
        } catch (e) {
            store.showToast(store.t('toggleFailed') + ': ' + e.message, 'error');
            // Rollback optimistic update on error
            if (account) {
                account.enabled = !enabled;
            }
            await dataStore.fetchData();
        }
    },

    async fixAccount(email) {
        const store = Alpine.store('global');
        const dataStore = Alpine.store('data');

        // Auto-fetch credentials so password is on clipboard
        fetch(`/api/swarm/credentials/${encodeURIComponent(email)}`)
            .then(r => r.json())
            .then(data => {
                if (data.status === 'ok' && data.password) {
                    navigator.clipboard.writeText(data.password);
                }
            })
            .catch(() => {});

        // If the account has a verification URL (403 VALIDATION_REQUIRED), open in clean window
        const account = (dataStore.accounts || []).find(a => a.email === email);
        if (account?.verifyUrl) {
            await fetch('/api/swarm/launch-clean-window', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, url: account.verifyUrl })
            });
            store.showToast('Opened clean verification session. After verifying, click ↻ Refresh', 'info', 10000);
            return;
        }



        // Otherwise launch clean OAuth window
        store.showToast(store.t('reauthenticating', { email: Redact.email(email) }) || `Re-authenticating ${email}...`, 'info');
        const password = store.webuiPassword;

        try {
            const urlPath = `/api/auth/url?email=${encodeURIComponent(email)}`;
            const { response, newPassword } = await window.utils.request(urlPath, {}, password);
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok' && data.url) {
                // Launch clean window via backend (zero toomanysessions error)
                await fetch('/api/swarm/launch-clean-window', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, url: data.url })
                });

                let pollCount = 0;
                const maxPolls = 60; // 2 minutes
                let cancelled = false;

                store.oauthProgress = {
                    active: true,
                    current: 0,
                    max: maxPolls,
                    cancel: () => {
                        cancelled = true;
                        clearInterval(pollInterval);
                        store.oauthProgress.active = false;
                    }
                };

                const pollInterval = setInterval(async () => {
                    if (cancelled) {
                        clearInterval(pollInterval);
                        return;
                    }

                    pollCount++;
                    store.oauthProgress.current = pollCount;

                    await dataStore.fetchData();
                    const updatedAcc = (dataStore.accounts || []).find(a => a.email === email);

                    // Check if it's fixed (no longer invalid, and status is ok)
                    if (updatedAcc && !updatedAcc.isInvalid && updatedAcc.status === 'ok') {
                        clearInterval(pollInterval);
                        store.oauthProgress.active = false;
                        store.showToast(store.t('accountReauthSuccess') || 'Account re-authenticated successfully', 'success');
                    }

                    if (pollCount >= maxPolls) {
                        clearInterval(pollInterval);
                        store.oauthProgress.active = false;
                    }
                }, 3000);
            } else {
                store.showToast(data.error || store.t('authUrlFailed'), 'error');
            }
        } catch (e) {
            store.showToast(store.t('authUrlFailed') + ': ' + e.message, 'error');
        }
    },

    confirmDeleteAccount(email) {
        this.deleteTarget = email;
        document.getElementById('delete_account_modal').showModal();
    },

    async executeDelete() {
        const email = this.deleteTarget;
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');

            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(email)}`,
                { method: 'DELETE' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('deletedAccount', { email: Redact.email(email) }), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('delete_account_modal').close();
                this.deleteTarget = '';
            } else {
                throw new Error(data.error || store.t('deleteFailed'));
            }
        }, this, 'deleting', { errorMessage: 'Failed to delete account' });
    },

    async reloadAccounts() {
        return await window.ErrorHandler.withLoading(async () => {
            const store = Alpine.store('global');

            const { response, newPassword } = await window.utils.request(
                '/api/accounts/reload',
                { method: 'POST' },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                localStorage.removeItem('ag_data_cache');
                store.showToast(store.t('accountsReloaded'), 'success');
                await Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || store.t('reloadFailed'));
            }
        }, this, 'reloading', { errorMessage: 'Failed to reload accounts' });
    },

    openQuotaModal(account) {
        this.selectedAccount = account;
        this.selectedAccountEmail = account.email;
        this.selectedAccountLimits = account.limits || {};
        this.quotaModalShowDetails = false;
        document.getElementById('quota_modal').showModal();
    },

    /**
     * Get grouped pool-level quotas for an individual account
     * Matches the Claude Pool and Gemini Pool indications from the group level
     * @param {Object} account
     * @returns {Object} { claude: { percent, resetTime, models } | null, gemini: { percent, resetTime, models } | null, otherFamilies, totalModels }
     */
    getAccountGroupedQuotas(account) {
        if (!account) return { claude: null, gemini: null, otherFamilies: [], totalModels: 0 };

        const limits = account.limits || {};
        const tier = (account.subscription?.tier || account.tier || 'free').toLowerCase();
        const isEligibleClaude = ['pro', 'ultra', 'plus'].includes(tier) && account.type !== 'apikey' && !account.email.includes('virtual-gemini-key') && !account.isInvalid;

        let maxClaude = -1;
        let claudeReset = null;
        const claudeModels = [];

        let maxGemini = -1;
        let geminiReset = null;
        const geminiModels = [];

        const otherMap = {};

        for (const [id, l] of Object.entries(limits)) {
            if (!l || l.remainingFraction === null || l.remainingFraction === undefined) continue;
            const pct = Math.round(l.remainingFraction * 100);
            const lower = id.toLowerCase();

            if (lower.includes('claude')) {
                if (isEligibleClaude) {
                    if (pct > maxClaude) {
                        maxClaude = pct;
                    }
                    if (l.resetTime && (!claudeReset || new Date(l.resetTime) < new Date(claudeReset))) {
                        claudeReset = l.resetTime;
                    }
                    claudeModels.push({ modelId: id, pct, resetTime: l.resetTime, limit: l });
                }
            } else if (lower.includes('gemini')) {
                if (pct > maxGemini) {
                    maxGemini = pct;
                }
                const isFlagship = id.includes('pro') || id.includes('3.7') || id.includes('3.6');
                if (l.resetTime) {
                    if (!geminiReset) {
                        geminiReset = l.resetTime;
                    } else if (pct < 100) {
                        geminiReset = l.resetTime;
                    } else if (isFlagship && new Date(l.resetTime) > new Date(geminiReset)) {
                        // Prioritize the longer, more critical weekly flagship window when full
                        geminiReset = l.resetTime;
                    }
                }
                geminiModels.push({ modelId: id, pct, resetTime: l.resetTime, limit: l });
            } else {
                // Only display quota families that are actually reported by this
                // Google account. Catalog-only models (for example GPT/OpenAI
                // aliases) must not appear as account quota or inherit a value.
                const fam = Alpine.store('data')?.getModelFamily?.(id) || 'other';
                if (fam === 'openai') continue;
                if (!otherMap[fam]) {
                    otherMap[fam] = {
                        name: fam === 'other' ? 'Other reported models' : fam.toUpperCase() + ' Pool', 
                        family: fam,
                        maxPct: -1, 
                        resetTime: null, 
                        models: [] 
                    };
                }
                if (pct > otherMap[fam].maxPct) {
                    otherMap[fam].maxPct = pct;
                }
                if (l.resetTime && (!otherMap[fam].resetTime || new Date(l.resetTime) < new Date(otherMap[fam].resetTime))) {
                    otherMap[fam].resetTime = l.resetTime;
                }
                otherMap[fam].models.push({ modelId: id, pct, resetTime: l.resetTime, limit: l });
            }
        }

        const totalModels = claudeModels.length + geminiModels.length + Object.values(otherMap).reduce((sum, f) => sum + f.models.length, 0);

        return {
            claude: isEligibleClaude && maxClaude > -1 ? { 
                name: 'Anthropic Claude Pool',
                percent: maxClaude, 
                resetTime: claudeReset, 
                models: claudeModels 
            } : null,
            gemini: (!isEligibleClaude && maxGemini > -1) ? { 
                name: 'Google Gemini Pool',
                percent: maxGemini, 
                resetTime: geminiReset, 
                models: geminiModels 
            } : null,
            isEligibleClaude,
            otherFamilies: Object.values(otherMap),
            totalModels
        };
    },

    formatResetDay(isoString) {
        if (!isoString) return '';
        try {
            const date = new Date(isoString);
            if (isNaN(date.getTime())) return '';

            const now = new Date();
            const diffMs = date.getTime() - now.getTime();
            if (diffMs <= 0) return 'Resetting soon';

            const diffHours = Math.round(diffMs / (1000 * 60 * 60));
            const dayName = date.toLocaleDateString(undefined, { weekday: 'short' });
            const timeStr = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

            const isToday = date.toDateString() === now.toDateString();
            const dayPrefix = isToday ? 'Today' : dayName;
            return `${dayPrefix} ${timeStr} (${diffHours}h)`;
        } catch (e) {
            return '';
        }
    },

    // Threshold settings
    thresholdDialog: {
        email: '',
        quotaThreshold: null,  // null means use global
        modelQuotaThresholds: {},
        saving: false,
        addingModel: false,
        newModelId: '',
        newModelThreshold: 10
    },

    openThresholdModal(account) {
        this.thresholdDialog = {
            email: account.email,
            // Convert from fraction (0-1) to percentage (0-99) for display
            quotaThreshold: account.quotaThreshold !== undefined ? Math.round(account.quotaThreshold * 100) : null,
            modelQuotaThresholds: Object.fromEntries(
                Object.entries(account.modelQuotaThresholds || {}).map(([k, v]) => [k, Math.round(v * 100)])
            ),
            saving: false,
            addingModel: false,
            newModelId: '',
            newModelThreshold: 10
        };
        document.getElementById('threshold_modal').showModal();
    },

    async saveAccountThreshold() {
        const store = Alpine.store('global');
        this.thresholdDialog.saving = true;

        try {
            // Convert percentage back to fraction
            const quotaThreshold = this.thresholdDialog.quotaThreshold !== null && this.thresholdDialog.quotaThreshold !== ''
                ? parseFloat(this.thresholdDialog.quotaThreshold) / 100
                : null;

            // Convert model thresholds from percentage to fraction
            const modelQuotaThresholds = {};
            for (const [modelId, pct] of Object.entries(this.thresholdDialog.modelQuotaThresholds)) {
                modelQuotaThresholds[modelId] = parseFloat(pct) / 100;
            }

            const { response, newPassword } = await window.utils.request(
                `/api/accounts/${encodeURIComponent(this.thresholdDialog.email)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ quotaThreshold, modelQuotaThresholds })
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast('Settings saved', 'success');
                Alpine.store('data').fetchData();
                document.getElementById('threshold_modal').close();
            } else {
                throw new Error(data.error || 'Failed to save settings');
            }
        } catch (e) {
            store.showToast('Failed to save settings: ' + e.message, 'error');
        } finally {
            this.thresholdDialog.saving = false;
        }
    },

    clearAccountThreshold() {
        this.thresholdDialog.quotaThreshold = null;
    },

    // Per-model threshold methods
    addModelThreshold() {
        this.thresholdDialog.addingModel = true;
        this.thresholdDialog.newModelId = '';
        this.thresholdDialog.newModelThreshold = 10;
    },

    updateModelThreshold(modelId, value) {
        const numValue = parseInt(value);
        if (!isNaN(numValue) && numValue >= 0 && numValue <= 99) {
            this.thresholdDialog.modelQuotaThresholds[modelId] = numValue;
        }
    },

    removeModelThreshold(modelId) {
        delete this.thresholdDialog.modelQuotaThresholds[modelId];
    },

    confirmAddModelThreshold() {
        const modelId = this.thresholdDialog.newModelId;
        const threshold = parseInt(this.thresholdDialog.newModelThreshold) || 10;

        if (modelId && threshold >= 0 && threshold <= 99) {
            this.thresholdDialog.modelQuotaThresholds[modelId] = threshold;
            this.thresholdDialog.addingModel = false;
            this.thresholdDialog.newModelId = '';
            this.thresholdDialog.newModelThreshold = 10;
        }
    },

    getAvailableModelsForThreshold() {
        // Get models from data store, exclude already configured ones
        const allModels = Alpine.store('data').models || [];
        const configured = Object.keys(this.thresholdDialog.modelQuotaThresholds);
        return allModels.filter(m => !configured.includes(m));
    },

    getEffectiveThreshold(account) {
        // Return display string for effective threshold
        if (account.quotaThreshold !== undefined) {
            return Math.round(account.quotaThreshold * 100) + '%';
        }
        // If no per-account threshold, show global value
        const globalThreshold = Alpine.store('data').globalQuotaThreshold;
        if (globalThreshold > 0) {
            return Math.round(globalThreshold * 100) + '% (global)';
        }
        return 'Global';
    },

    /**
     * Get main model quota for display
     * Prioritizes flagship models (Opus > Sonnet > Flash)
     * @param {Object} account - Account object with limits
     * @returns {Object} { percent: number|null, model: string }
     */
    getMainModelQuota(account) {
        if (!account) return { percent: null, model: '-' };
        
        // Developer Mode Health Tracker info
        if (account._healthInfo && typeof account._healthInfo.quota === 'number') {
            return { percent: Math.round(account._healthInfo.quota * 100), model: 'health-check' };
        }

        const limits = account.limits || {};
        
        // Helper to safely get remaining fraction
        const getQuotaVal = (id) => {
             const l = limits[id];
             if (!l || l.remainingFraction === null || l.remainingFraction === undefined) return -1;
             return l.remainingFraction;
        };

        const validIds = Object.keys(limits).filter(id => getQuotaVal(id) >= 0);
        
        if (validIds.length === 0) return { percent: null, model: '-' };

        const DEAD_THRESHOLD = 0.01;
        
        const MODEL_TIERS = [
            { pattern: /\bopus\b/, aliveScore: 100, deadScore: 60 },
            { pattern: /\bsonnet\b/, aliveScore: 90, deadScore: 55 },
            // Gemini 3 Pro / Ultra
            { pattern: /\bgemini-3\b/, extraCheck: (l) => /\bpro\b/.test(l) || /\bultra\b/.test(l), aliveScore: 80, deadScore: 50 },
            { pattern: /\bpro\b/, aliveScore: 75, deadScore: 45 },
            // Mid/Low Tier
            { pattern: /\bhaiku\b/, aliveScore: 30, deadScore: 15 },
            { pattern: /\bflash\b/, aliveScore: 20, deadScore: 10 }
        ];

        const getPriority = (id) => {
            const lower = id.toLowerCase();
            const val = getQuotaVal(id);
            const isAlive = val > DEAD_THRESHOLD;
            
            for (const tier of MODEL_TIERS) {
                if (tier.pattern.test(lower)) {
                    if (tier.extraCheck && !tier.extraCheck(lower)) continue;
                    return isAlive ? tier.aliveScore : tier.deadScore;
                }
            }
            
            return isAlive ? 5 : 0;
        };

        // Sort by priority desc
        validIds.sort((a, b) => getPriority(b) - getPriority(a));

        const bestModel = validIds[0];
        const val = getQuotaVal(bestModel);
        
        return {
            percent: Math.round(val * 100),
            model: bestModel
        };
    },

    /**
     * Fetch strategy health data for the inspector panel
     */
    async fetchHealthData() {
        this.healthLoading = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request(
                '/api/strategy/health',
                {},
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                this.healthData = data;
            } else {
                this.healthData = {};
                if (response.status === 403) {
                    store.showToast(data.error || 'Developer mode is not enabled', 'warning');
                }
            }
        } catch (e) {
            console.error('Failed to fetch health data:', e);
        } finally {
            this.healthLoading = false;
        }
    },

    /**
     * Export accounts to JSON file
     */
    async exportAccounts() {
        const store = Alpine.store('global');
        try {
            const { response, newPassword } = await window.utils.request(
                '/api/accounts/export',
                {},
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            // API returns plain array directly
            if (Array.isArray(data)) {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `antigravity-accounts-${new Date().toISOString().split('T')[0]}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                store.showToast(store.t('exportSuccess', { count: data.length }), 'success');
            } else if (data.error) {
                throw new Error(data.error);
            }
        } catch (e) {
            store.showToast(store.t('exportFailed') + ': ' + e.message, 'error');
        }
    },

    /**
     * Import accounts from JSON file
     * @param {Event} event - file input change event
     */
    async importAccounts(event) {
        const store = Alpine.store('global');
        const file = event.target.files?.[0];
        if (!file) return;

        try {
            const text = await file.text();
            const importData = JSON.parse(text);

            // Support both plain array and wrapped format
            const accounts = Array.isArray(importData) ? importData : (importData.accounts || []);
            if (!Array.isArray(accounts) || accounts.length === 0) {
                throw new Error('Invalid file format: expected accounts array');
            }

            const { response, newPassword } = await window.utils.request(
                '/api/accounts/import',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(accounts)
                },
                store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const { added, updated, failed } = data.results;
                let msg = store.t('importSuccess') + ` ${added.length} added, ${updated.length} updated`;
                if (failed.length > 0) {
                    msg += `, ${failed.length} failed`;
                }
                store.showToast(msg, failed.length > 0 ? 'info' : 'success');
                Alpine.store('data').fetchData();
            } else {
                throw new Error(data.error || 'Import failed');
            }
        } catch (e) {
            store.showToast(store.t('importFailed') + ': ' + e.message, 'error');
        } finally {
            // Reset file input
            event.target.value = '';
        }
    },

    // Swarm Mode & Container Tab Helpers
    credentialsModalOpen: false,
    currentCreds: null,
    copiedKey: null,
    fetchingRecoveryCode: false,
    interceptedCode: null,

    async fetchLatestRecoveryCode(email) {
        this.fetchingRecoveryCode = true;
        this.interceptedCode = null;
        try {
            const res = await fetch(`/api/swarm/latest-verification-code?email=${encodeURIComponent(email)}&timeout=8`);
            const data = await res.json();
            if (data.status === 'ok' && data.code) {
                this.interceptedCode = data.code;
                this.copyCred(data.code, 'Recovery Code');
                Alpine.store('global').showToast(`Intercepted code: ${data.code} (Copied!)`, 'success');
            } else {
                Alpine.store('global').showToast(data.message || 'No new code found in recovery mailbox', 'info');
            }
        } catch (e) {
            console.error('Failed to intercept recovery code:', e);
            Alpine.store('global').showToast('Error intercepting recovery code', 'error');
        } finally {
            this.fetchingRecoveryCode = false;
        }
    },

    async openAccountTab(email) {
        // Direct 1-click action — launches clean window without modal or extension requirement
        await this.openCleanWindow(email);
    },

    async viewCredentials(email) {
        try {
            const res = await fetch(`/api/swarm/credentials/${encodeURIComponent(email)}`);
            const data = await res.json();
            if (data.status === 'ok') {
                this.currentCreds = data;
                this.credentialsModalOpen = true;
            }
        } catch (e) {
            console.error('Failed to load credentials:', e);
            Alpine.store('global').showToast('Failed to load credentials from vault', 'error');
        }
    },

    async openCleanWindow(email) {
        try {
            // Pre-fetch credentials in background so password is ready on clipboard
            fetch(`/api/swarm/credentials/${encodeURIComponent(email)}`)
                .then(r => r.json())
                .then(data => {
                    if (data.status === 'ok') {
                        this.currentCreds = data;
                        if (data.password) navigator.clipboard.writeText(data.password);
                    }
                })
                .catch(() => {});

            await fetch('/api/swarm/launch-clean-window', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            Alpine.store('global').showToast(`Opened clean window for ${email} (Password copied!)`, 'success');
        } catch (e) {
            console.error('Failed to launch clean window:', e);
            window.open(`https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(email)}&continue=https://myaccount.google.com`, '_blank');
        }
    },

    openAdminSecurity(email) {
        let adminEmail = 'apps@reseller.mysolidstate.ca';
        if (email.includes('@adamassist.com')) {
            adminEmail = 'adam@adamassist.com';
        } else if (email.includes('@mysolidstate.ca')) {
            adminEmail = 'hub@mysolidstate.ca';
        }

        const targetUrl = `https://admin.google.com/ac/users/${encodeURIComponent(email)}/security?authuser=${encodeURIComponent(adminEmail)}`;
        window.open(targetUrl, '_blank');
        Alpine.store('global').showToast(`Opening Admin Console in current window (${adminEmail})...`, 'info');
    },

    async autoOnboard(email) {
        try {
            Alpine.store('global').showToast(`Generating login link for ${email}...`, 'info');
            
            // 1. Get OAuth URL
            const urlRes = await fetch('/api/auth/url?email=' + encodeURIComponent(email));
            const urlData = await urlRes.json();
            if (urlData.status !== 'ok') throw new Error(urlData.error);
            
            // 2. Open in Active Browser
            await fetch('/api/swarm/launch-clean-window', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, url: urlData.url })
            });
            
            Alpine.store('global').showToast(`Opened active browser for ${email}! Please click through the login.`, 'success');
            if (this.credentialsModalOpen) this.credentialsModalOpen = false;
        } catch (e) {
            Alpine.store('global').showToast(`Failed to open active browser: ${e.message}`, 'error');
        }
    },

    copyCred(text, key) {
        navigator.clipboard.writeText(text);
        this.copiedKey = key;
        setTimeout(() => this.copiedKey = null, 2000);
        Alpine.store('global').showToast(`Copied ${key} to clipboard`, 'success');
    }
});
