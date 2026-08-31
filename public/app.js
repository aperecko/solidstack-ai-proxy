/**
 * Antigravity Console - Main Entry
 *
 * This file orchestrates Alpine.js initialization.
 * Components are loaded via separate script files that register themselves
 * to window.Components before this script runs.
 */

document.addEventListener('alpine:init', () => {
    // Register Components (loaded from separate files via window.Components)
    Alpine.data('dashboard', window.Components.dashboard);
    Alpine.data('models', window.Components.models);
    Alpine.data('accountManager', window.Components.accountManager);
    Alpine.data('swarmVisualizer', window.Components.swarmVisualizer);
    Alpine.data('claudeConfig', window.Components.claudeConfig);
    Alpine.data('logsViewer', window.Components.logsViewer);
    Alpine.data('addAccountModal', window.Components.addAccountModal);
    Alpine.data('processes', window.Components.processes);
    Alpine.data('infrastructure', window.Components.infrastructure);
    Alpine.data('agentSkills', window.Components.agentSkills);
    Alpine.data('loadBalancer', window.Components.loadBalancer);
    Alpine.data('philosophyDomain', window.Components.philosophyDomain);
    Alpine.data('agentChat', window.Components.agentChat);
    Alpine.data('overnight', window.Components.overnight);
    Alpine.data('economics', window.Components.economics);
    Alpine.data('uad', window.Components.uad);
    Alpine.data('workflow', window.Components.workflow);
    Alpine.data('aiCopilot', window.Components.aiCopilot);

    // View Loader Directive
    Alpine.directive('load-view', (el, { expression }, { evaluate }) => {
        if (!window.viewCache) window.viewCache = new Map();

        // Evaluate the expression to get the actual view name (removes quotes)
        const viewName = evaluate(expression);

        if (window.viewCache.has(viewName)) {
            el.innerHTML = window.viewCache.get(viewName);
            Alpine.initTree(el);
            return;
        }

        fetch(`views/${viewName}.html?t=${Date.now()}`)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.text();
            })
            .then(html => {
                // Update cache (optional, or remove if we want always-fresh)
                // keeping cache for session performance, but initial load will now bypass browser cache
                window.viewCache.set(viewName, html);
                el.innerHTML = html;
                Alpine.initTree(el);
            })
            .catch(err => {
                console.error('Failed to load view:', viewName, err);
                el.innerHTML = `<div class="p-4 border border-red-500/50 bg-red-500/10 rounded-lg text-red-400 font-mono text-sm">
                    Error loading view: ${viewName}<br>
                    <span class="text-xs opacity-75">${err.message}</span>
                </div>`;
            });
    });

    // Main App Controller
    Alpine.data('app', () => ({
        get connectionStatus() {
            return Alpine.store('data')?.connectionStatus || 'connecting';
        },
        get loading() {
            return Alpine.store('data')?.loading || false;
        },

        sidebarOpen: window.innerWidth >= 1024,
        toggleSidebar() {
            this.sidebarOpen = !this.sidebarOpen;
        },

        init() {
            // Handle responsive sidebar transitions
            let lastWidth = window.innerWidth;
            let resizeTimeout = null;
            
            window.addEventListener('resize', () => {
                if (resizeTimeout) clearTimeout(resizeTimeout);
                
                resizeTimeout = setTimeout(() => {
                    const currentWidth = window.innerWidth;
                    const lgBreakpoint = 1024;
                    
                    // Desktop -> Mobile: Auto-close sidebar to prevent overlay blocking screen
                    if (lastWidth >= lgBreakpoint && currentWidth < lgBreakpoint) {
                        this.sidebarOpen = false;
                    }
                    
                    // Mobile -> Desktop: Auto-open sidebar (restore standard desktop layout)
                    if (lastWidth < lgBreakpoint && currentWidth >= lgBreakpoint) {
                        this.sidebarOpen = true;
                    }
                    
                    lastWidth = currentWidth;
                }, 150);
            });

            // Theme setup
            document.documentElement.setAttribute('data-theme', 'black');
            document.documentElement.classList.add('dark');

            // Chart Defaults
            if (typeof Chart !== 'undefined') {
                Chart.defaults.color = window.utils.getThemeColor('--color-text-dim');
                Chart.defaults.borderColor = window.utils.getThemeColor('--color-space-border');
                Chart.defaults.font.family = '"JetBrains Mono", monospace';
            }

            // Start Data Polling
            this.startAutoRefresh();
            document.addEventListener('refresh-interval-changed', () => this.startAutoRefresh());

            // Initial Fetch
            Alpine.store('data').fetchData();
        },

        refreshTimer: null,

        fetchData() {
            Alpine.store('data').fetchData();
        },

        startAutoRefresh() {
            if (this.refreshTimer) clearInterval(this.refreshTimer);
            const interval = parseInt(Alpine.store('settings')?.refreshInterval || 3);
            if (interval > 0) {
                this.refreshTimer = setInterval(() => Alpine.store('data').fetchData(), interval * 1000);
            }
        },

        t(key) {
            return Alpine.store('global')?.t(key) || key;
        },

                async autoAddSwarm(domain) {
            Alpine.store('global').showToast('🤖 Finding next available account...', 'info');
            try {
                const res1 = await fetch('/api/swarm/next-pending?domain=' + encodeURIComponent(domain));
                const data1 = await res1.json();
                if (data1.status !== 'ok') {
                    Alpine.store('global').showToast('Error: ' + data1.error, 'error');
                    return;
                }
                const targetEmail = data1.email;
                Alpine.store('global').showToast('🤖 Starting Zero-Touch robot for ' + targetEmail + '...', 'info');
                
                const res2 = await fetch('/api/swarm/auto-onboard', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: targetEmail })
                });
                const data2 = await res2.json();
                if (data2.status === 'ok') {
                    Alpine.store('global').showToast('Zero-Touch robot running for ' + targetEmail + '!', 'success');
                    const modal = document.getElementById('add_account_modal');
                    if (modal) modal.close();
                } else {
                    Alpine.store('global').showToast('Error: ' + data2.error, 'error');
                }
            } catch (e) {
                Alpine.store('global').showToast('Failed to launch auto-onboard: ' + e.message, 'error');
            }
        },

                async addAccountWeb(reAuthEmail = null) {
            const password = Alpine.store('global').webuiPassword;
            
            if (typeof reAuthEmail === 'string' && reAuthEmail.startsWith('@')) {
                const domain = reAuthEmail;
                try {
                    const res = await fetch('/api/swarm/next-pending?domain=' + encodeURIComponent(domain));
                    const data = await res.json();
                    if (data.status === 'ok') {
                        reAuthEmail = data.email;
                    } else {
                        Alpine.store('global').showToast('Error finding account: ' + data.error, 'error');
                        return;
                    }
                } catch(e) {
                    Alpine.store('global').showToast('Error: ' + e.message, 'error');
                    return;
                }
            }
            
            try {
                const urlPath = reAuthEmail
                    ? `/api/auth/url?email=${encodeURIComponent(reAuthEmail)}`
                    : '/api/auth/url';

                const { response, newPassword } = await window.utils.request(urlPath, {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;

                const data = await response.json();

                if (data.status === 'ok' && data.url) {
                    // Show info toast that OAuth is in progress
                    Alpine.store('global').showToast(Alpine.store('global').t('oauthInProgress'), 'info');

                    // Launch clean window via backend to bypass 10-account limit
                    await fetch('/api/swarm/launch-clean-window', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ email: reAuthEmail, url: data.url })
                    });

                    // Poll for account changes instead of relying on postMessage
                    // (since OAuth callback is now on port 51121, not this server)
                    const initialAccountCount = Alpine.store('data').accounts.length;
                    const initialEmails = new Set(Alpine.store('data').accounts.map((account) => account.email));
                    let pollCount = 0;
                    const maxPolls = 60; // 2 minutes (2 second intervals)
                    let cancelled = false;

                    // Show progress modal
                    Alpine.store('global').oauthProgress = {
                        active: true,
                        current: 0,
                        max: maxPolls,
                        cancel: () => {
                            cancelled = true;
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(Alpine.store('global').t('oauthCancelled'), 'info');
                        }
                    };

                    const pollInterval = setInterval(async () => {
                        if (cancelled) {
                            clearInterval(pollInterval);
                            return;
                        }

                        pollCount++;
                        Alpine.store('global').oauthProgress.current = pollCount;

                        // Refresh account list before deciding whether the
                        // browser window closing means failure. OAuth can finish
                        // and close its tab before the next dashboard poll.
                        await Alpine.store('data').fetchData();

                        const currentAccounts = Alpine.store('data').accounts;
                        const addedAccount = currentAccounts.find((account) => !initialEmails.has(account.email));
                        const targetAccount = reAuthEmail ? currentAccounts.find((account) => account.email === reAuthEmail) : null;

                        // Check for a newly added account or a re-authenticated target.
                        if (addedAccount || (targetAccount && !targetAccount.isInvalid)) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;

                            const actionKey = reAuthEmail ? 'accountReauthSuccess' : 'accountAddedSuccess';
                            Alpine.store('global').showToast(
                                Alpine.store('global').t(actionKey),
                                'success'
                            );
                            document.getElementById('add_account_modal')?.close();

                            if (oauthWindow && !oauthWindow.closed) {
                                oauthWindow.close();
                            }
                        }

                        // Only report a closed window after checking the refreshed
                        // account list. The prior code returned too early here.
                        if (oauthWindow && oauthWindow.closed && !cancelled) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(Alpine.store('global').t('oauthWindowClosed'), 'warning');
                            return;
                        }

                        // Stop polling after max attempts
                        if (pollCount >= maxPolls) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(
                                Alpine.store('global').t('oauthTimeout'),
                                'warning'
                            );
                        }
                    }, 5000); // Poll every 5 seconds instead of 2 to reduce load
                } else {
                    if (oauthWindow) oauthWindow.close();
                    Alpine.store('global').showToast(data.error || Alpine.store('global').t('failedToGetAuthUrl'), 'error');
                }
            } catch (e) {
                if (oauthWindow) oauthWindow.close();
                Alpine.store('global').showToast(Alpine.store('global').t('failedToStartOAuth') + ': ' + e.message, 'error');
            }
        }
    }));
});