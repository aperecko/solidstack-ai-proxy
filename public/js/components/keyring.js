window.Components = window.Components || {};

window.Components.keyring = function () {
    return {
        activeStep: 1,
        provider: 'nvidia', // nvidia, openrouter, groq
        method: 'auto', // auto, manual
        
        status: null,
        loadingStatus: false,
        
        autoProvisioning: false,
        provisionLogs: '',
        provisionError: null,
        provisionSuccess: false,
        
        manualKey: '',
        manualLabel: 'Manual Web Setup',
        manualSaving: false,
        manualError: null,
        manualSuccess: false,

        init() {
            this.fetchStatus();
            // Poll status if we are on step 4
            setInterval(() => {
                if (this.$store.global.activeTab === 'keyring') {
                    this.fetchStatus();
                }
            }, 10000);
        },

        async fetchStatus() {
            this.loadingStatus = true;
            try {
                const res = await fetch('/api/keyring/status');
                this.status = await res.json();
            } catch (err) {
                console.error("Failed to fetch keyring status", err);
            } finally {
                this.loadingStatus = false;
            }
        },

        nextStep() {
            if (this.activeStep < 4) this.activeStep++;
        },
        
        prevStep() {
            if (this.activeStep > 1) this.activeStep--;
        },

        startAutoProvision() {
            this.autoProvisioning = true;
            this.provisionError = null;
            this.provisionSuccess = false;
            this.provisionLogs = "Initializing Zero-Touch Headless Profile...\nConnecting to Chrome Profile 24 (assistaius@gmail.com)...\n";
            
            fetch('/api/keyring/provision', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: this.provider })
            })
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    this.provisionError = data.error;
                    this.provisionLogs += `\nError: ${data.stderr || data.error}\n`;
                } else if (data.status === 'ok' || data.status === 'exists') {
                    this.provisionSuccess = true;
                    this.provisionLogs += `\nSuccess: Key stored in 1Password and Keyring JSON.\n`;
                    this.fetchStatus();
                } else {
                    this.provisionError = "Unknown error occurred.";
                    this.provisionLogs += `\nUnexpected Output: ${JSON.stringify(data)}\n`;
                }
            })
            .catch(err => {
                this.provisionError = err.message;
                this.provisionLogs += `\nFetch Error: ${err.message}\n`;
            })
            .finally(() => {
                this.autoProvisioning = false;
            });
        },

        saveManualKey() {
            if (!this.manualKey) return;
            this.manualSaving = true;
            this.manualError = null;
            this.manualSuccess = false;

            fetch('/api/keyring/key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: this.provider,
                    key: this.manualKey,
                    label: this.manualLabel
                })
            })
            .then(res => res.json())
            .then(data => {
                if (data.error) throw new Error(data.error);
                this.manualSuccess = true;
                this.manualKey = '';
                this.fetchStatus();
            })
            .catch(err => {
                this.manualError = err.message;
            })
            .finally(() => {
                this.manualSaving = false;
            });
        }
    };
};
