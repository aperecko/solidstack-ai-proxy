/**
 * Add Account Modal Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.addAccountModal = () => ({
    manualMode: false,
    provisionDomain: 'reseller.mysolidstate.ca',
    provisionPrefix: '',
    provisionStart: 1,
    provisionCount: 1,
    provisioning: false,
    discoveredAccounts: [],
    authUrl: '',
    authState: '',
    callbackInput: '',
    submitting: false,
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

    async discoverSwarm() {
        try {
            const response = await fetch('/api/swarm/discover');
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            this.discoveredAccounts = data.accounts || [];
            Alpine.store('global').showToast(`Found ${data.count || 0} swarm account(s)`, 'success');
        } catch (e) {
            Alpine.store('global').showToast('Discovery failed: ' + e.message, 'error');
        }
    },

    async provisionSwarm() {
        const count = Number(this.provisionCount);
        const startIdx = Number(this.provisionStart);
        if (!Number.isInteger(count) || count < 1 || count > 100 || !Number.isInteger(startIdx) || startIdx < 0) {
            Alpine.store('global').showToast('Use a count from 1–100 and a non-negative start number.', 'error');
            return;
        }
        this.provisioning = true;
        try {
            const response = await fetch('/api/swarm/provision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ domain: this.provisionDomain, prefix: this.provisionPrefix, startIdx, count })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
            Alpine.store('global').showToast(`Created ${data.created} swarm account(s)`, 'success');
            Alpine.store('data').fetchData();
        } catch (e) {
            Alpine.store('global').showToast('Provisioning failed: ' + e.message, 'error');
        } finally {
            this.provisioning = false;
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
                ? '/api/auth/url?email=' + encodeURIComponent(reAuthEmail)
                : '/api/auth/url';

            const { response, newPassword } = await window.utils.request(urlPath, {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            const data = await response.json();
            if (data.status === 'ok') {
                const modal = document.getElementById('add_account_modal');
                if (modal) modal.close();
                window.open(data.url, '_blank');
            } else {
                Alpine.store('global').showToast(data.error || 'Failed to get auth URL', 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        }
    },


    /**
     * Reset all state to initial values
     */
    resetState() {
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;
        // Close any open details elements
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
                const {
                    response,
                    newPassword
                } = await window.utils.request('/api/auth/url', {}, password);
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
            const {
                response,
                newPassword
            } = await window.utils.request('/api/auth/complete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    callbackInput: this.callbackInput,
                    state: this.authState
                })
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
