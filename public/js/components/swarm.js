window.Components = window.Components || {};

window.Components.swarm = () => ({
    searchQuery: '',
    selectedDomain: 'all',
    pinnedPersonas: [],
    expandedCreds: null,
    credsData: null,
    
    get accounts() {
        return Alpine.store('data').accounts || [];
    },
    
    get domains() {
        const domainSet = new Set();
        this.accounts.forEach(acc => {
            if (acc.email && acc.email.includes('@')) {
                domainSet.add(acc.email.split('@')[1]);
            }
        });
        return ['all', ...Array.from(domainSet).sort()];
    },
    
    get filteredAccounts() {
        let accs = this.accounts;
        
        // Filter by domain
        if (this.selectedDomain !== 'all') {
            accs = accs.filter(a => a.email && a.email.endsWith('@' + this.selectedDomain));
        }
        
        // Filter by search query
        if (this.searchQuery && this.searchQuery.trim() !== '') {
            const query = this.searchQuery.toLowerCase().trim();
            accs = accs.filter(a => a.email && a.email.toLowerCase().includes(query));
        }
        
        // Sort: pinned first, then by email
        return accs.sort((a, b) => {
            const aPinned = this.pinnedPersonas.includes(a.email) ? 1 : 0;
            const bPinned = this.pinnedPersonas.includes(b.email) ? 1 : 0;
            
            if (aPinned !== bPinned) return bPinned - aPinned; // Pinned items come first
            
            // Then sort by email alphabetically
            return a.email.localeCompare(b.email);
        });
    },
    
    togglePin(email) {
        if (this.pinnedPersonas.includes(email)) {
            this.pinnedPersonas = this.pinnedPersonas.filter(e => e !== email);
        } else {
            this.pinnedPersonas.push(email);
        }
        // Save to localStorage for persistence
        try {
            localStorage.setItem('swarm_pinned_personas', JSON.stringify(this.pinnedPersonas));
        } catch (e) {
            console.error('Failed to save pinned personas', e);
        }
    },
    
    async fetchCredentials(email) {
        // Toggle off if clicking the same one
        if (this.expandedCreds === email) {
            this.expandedCreds = null;
            this.credsData = null;
            return;
        }
        
        this.expandedCreds = email;
        this.credsData = { password: 'Loading...', backup_codes: [] };
        
        try {
            const store = Alpine.store('global');
            const res = await fetch(`/api/swarm/credentials/${encodeURIComponent(email)}`);
            const data = await res.json();
            
            if (data.status === 'ok') {
                this.credsData = {
                    password: data.password || 'N/A',
                    backup_codes: data.backup_codes || []
                };
                
                if (data.password) {
                    navigator.clipboard.writeText(data.password).catch(() => {});
                    store.showToast('Password copied to clipboard', 'info');
                }
            } else {
                this.credsData = { password: 'Error fetching', backup_codes: [] };
                store.showToast(data.error || 'Failed to fetch credentials', 'error');
            }
        } catch (e) {
            this.credsData = { password: 'Error fetching', backup_codes: [] };
            Alpine.store('global').showToast('Failed to fetch credentials', 'error');
        }
    },
    
    init() {
        // Load pinned personas from localStorage
        try {
            const saved = localStorage.getItem('swarm_pinned_personas');
            if (saved) {
                this.pinnedPersonas = JSON.parse(saved);
            }
        } catch (e) {
            console.error('Failed to load pinned personas', e);
        }
    }
});
