
/**
 * Add Account Modal Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.addAccountModal = () => ({
    manualMode: false,
    authUrl: '',
    authState: '',
    callbackInput: '',
    submitting: false,
    nextAdamAssist: null,
    nextReseller: null,

    init() {
        this.loadNextAccounts();
        this.$watch('$store.data.accounts', () => {
            this.loadNextAccounts();
        });
        window.addEventListener('refresh-add-modal', () => {
            this.loadNextAccounts();
        });
    },

    async loadNextAccounts() {
        try {
            const [resAdam, resReseller] = await Promise.all([
                fetch('/api/swarm/next-pending?domain=adamassist.com').then(r => r.json()).catch(() => null),
                fetch('/api/swarm/next-pending?domain=reseller.mysolidstate.ca').then(r => r.json()).catch(() => null)
            ]);
            if (resAdam?.status === 'ok') {
                this.nextAdamAssist = resAdam.email;
            } else {
                this.nextAdamAssist = null;
            }
            if (resReseller?.status === 'ok') {
                this.nextReseller = resReseller.email;
            } else {
                this.nextReseller = null;
            }
        } catch (e) {}
    },

    async addAccountWeb(domainOrEmail = null) {
        const password = Alpine.store('global').webuiPassword;
        let targetEmail = null;
        
        if (typeof domainOrEmail === 'string' && domainOrEmail.startsWith('@')) {
            const domain = domainOrEmail;
            Alpine.store('global').showToast('Finding next sequential account for ' + domain + '...', 'info');
            try {
                const res = await fetch('/api/swarm/next-pending?domain=' + encodeURIComponent(domain));
                const data = await res.json();
                if (data.status === 'ok') {
                    targetEmail = data.email;
                    // Auto-copy password to clipboard for 1-click convenience
                    fetch(`/api/swarm/credentials/${encodeURIComponent(targetEmail)}`)
                        .then(r => r.json())
                        .then(d => {
                            if (d.status === 'ok' && d.password) {
                                navigator.clipboard.writeText(d.password);
                            }
                        })
                        .catch(() => {});
                } else {
                    Alpine.store('global').showToast(data.error || 'All accounts logged in!', 'info');
                    return;
                }
            } catch(e) {
                Alpine.store('global').showToast('Error: ' + e.message, 'error');
                return;
            }
        }
        
        try {
            const urlPath = targetEmail
                ? '/api/auth/url?email=' + encodeURIComponent(targetEmail)
                : '/api/auth/url';

            Alpine.store('global').showToast('Generating login link...', 'info');
            const { response, newPassword } = await window.utils.request(urlPath, {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const modal = document.getElementById('add_account_modal');
                if (modal) modal.close();
                
                // Open in active browser using our backend launch-clean-window
                await fetch('/api/swarm/launch-clean-window', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: targetEmail, url: data.url })
                });
                
                Alpine.store('global').showToast('Opened active browser! Please click through the login.', 'info');

                // Fast 1-second background poller for instant UI detection
                const initialEmails = new Set((Alpine.store('data').accounts || []).map(a => a.email));
                let pollAttempts = 0;
                const maxAttempts = 90; // 90 seconds
                const fastPoller = setInterval(async () => {
                    pollAttempts++;
                    await Alpine.store('data').fetchData();
                    const currentAccounts = Alpine.store('data').accounts || [];
                    const newlyAdded = currentAccounts.find(a => !initialEmails.has(a.email));
                    const isTargetPresent = targetEmail && currentAccounts.some(a => a.email === targetEmail);

                    if (newlyAdded || isTargetPresent) {
                        clearInterval(fastPoller);
                        const addedEmail = newlyAdded ? newlyAdded.email : targetEmail;
                        Alpine.store('global').showToast(`✓ Account ${addedEmail} added successfully!`, 'success');
                        this.loadNextAccounts();
                    } else if (pollAttempts >= maxAttempts) {
                        clearInterval(fastPoller);
                    }
                }, 1000);
            } else {
                Alpine.store('global').showToast(data.error || 'Failed to get auth URL', 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        }
    },

    resetState() {
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;
        const details = document.querySelectorAll('#add_account_modal details[open]');
        details.forEach(d => d.removeAttribute('open'));
    },

    async copyLink() {
        if (!this.authUrl) return;
        await navigator.clipboard.writeText(this.authUrl);
        Alpine.store('global').showToast(Alpine.store('global').t('linkCopied'), 'success');
    },

    async initManualAuth(event) {
        if (event.target.open && !this.authUrl) {
            try {
                const password = Alpine.store('global').webuiPassword;
                const { response, newPassword } = await window.utils.request('/api/auth/url', {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;
                const data = await response.json();
                if (data.status === 'ok') {
                    this.authUrl = data.url;
                    this.authState = data.state;
                }
            } catch (e) {
                Alpine.store('global').showToast(e.message, 'error');
            }
        }
    },

    async completeManualAuth() {
        if (!this.callbackInput || !this.authState) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/auth/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callbackInput: this.callbackInput, state: this.authState })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountAddedSuccess'), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || store.t('authFailed'), 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    }
});
