/**
 * Redact Mode & Smart Account Label Utility
 * Provides clear, distinct account identifiers and anonymous labels for screenshots.
 */
window.Redact = {
    email(email) {
        if (!Alpine.store('settings')?.redactMode) return email;
        if (!email) return email;
        const accounts = Alpine.store('data')?.accounts || [];
        const idx = accounts.findIndex(a => a.email === email || (a.email && a.email.split('@')[0] === email));
        return idx >= 0 ? `Account ${idx + 1}` : 'Account';
    },

    /**
     * Smart account pill label generator with domain distinctions for clarity.
     */
    shortLabel(email) {
        if (!email) return '';
        if (Alpine.store('settings')?.redactMode) return this.email(email);

        // Virtual API keys
        if (email.includes('virtual-gemini-key') || email.includes('apikey') || email.includes('solidstack.local')) {
            return 'Virtual API Key';
        }

        const parts = email.split('@');
        const user = parts[0] || email;
        const domain = (parts[1] || '').toLowerCase();

        // Domain distinction rules for account clarity
        if (domain.includes('adamassist')) return 'adam (assist)';
        if (domain.includes('reseller')) return 'apps (reseller)';
        if (domain.includes('mysolidstate')) return 'adam (mysolidstate)';

        // Username abbreviations
        if (user === 'adamtechnicalsolutions') return 'ats';
        if (user === 'aptsoultuions') return 'apts';
        if (user === 'apps000123000') return 'apps123';

        return user;
    },

    logMessage(message) {
        if (!Alpine.store('settings')?.redactMode) return message;
        const accounts = Alpine.store('data')?.accounts || [];
        let result = message;
        accounts.forEach((acc, idx) => {
            if (!acc.email) return;
            const escaped = acc.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(escaped, 'g'), `Account ${idx + 1}`);
            const user = acc.email.split('@')[0];
            if (user) {
                const escapedUser = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                result = result.replace(new RegExp(`\\b${escapedUser}\\b`, 'g'), `Account ${idx + 1}`);
            }
        });
        return result;
    }
};
