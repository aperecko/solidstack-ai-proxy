/**
 * Agent Skills Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.agentSkills = () => ({
    activeTab: 'focus', // focus, vault, twin, genius
    
    // Idea Containment Vault
    ideas: [],
    loadingIdeas: false,
    newIdea: {
        title: '',
        description: '',
        channel: 'B', // default next-cycle
        energy: 'High',
        dependency: '',
        mainAgent: 'Claude'
    },
    
    // Executive Focus
    nextStep: '',
    savedNextStep: '',
    timerMinutes: 25,
    timerSeconds: 0,
    timerActive: false,
    timerInterval: null,
    
    // Digital Twin Sync
    userContext: '',
    operatingManual: '',
    loadingContext: false,
    savingContext: false,
    
    // Prompt Genius (Expert Emulation)
    geniusInput: '',
    geniusOutput: '',
    geniusLoading: false,

    init() {
        // Load saved Focus settings
        this.savedNextStep = localStorage.getItem('solidstack_focus_step') || '';
        this.nextStep = this.savedNextStep;
        
        // Fetch initial data
        this.fetchIdeas();
        this.fetchContext();
    },

    // --- Idea Containment Vault ---
    async fetchIdeas() {
        this.loadingIdeas = true;
        try {
            const response = await fetch('/api/skills/containment');
            this.ideas = await response.json();
        } catch (error) {
            console.error('Error fetching ideas:', error);
        } finally {
            this.loadingIdeas = false;
        }
    },

    async saveIdea() {
        if (!this.newIdea.title.trim()) return;
        try {
            const response = await fetch('/api/skills/containment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.newIdea)
            });
            if (response.ok) {
                window.Alpine.store('global').showToast('Idea externalized successfully!', 'success');
                // Reset form
                this.newIdea = {
                    title: '',
                    description: '',
                    channel: 'B',
                    energy: 'High',
                    dependency: '',
                    mainAgent: 'Claude'
                };
                await this.fetchIdeas();
            }
        } catch (error) {
            console.error('Error saving idea:', error);
            window.Alpine.store('global').showToast('Failed to save idea.', 'error');
        }
    },

    async archiveIdea(filename) {
        try {
            const response = await fetch(`/api/skills/containment/${encodeURIComponent(filename)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'archived' })
            });
            if (response.ok) {
                window.Alpine.store('global').showToast('Idea archived to Vault.', 'success');
                await this.fetchIdeas();
            }
        } catch (error) {
            console.error('Error archiving idea:', error);
        }
    },

    async deleteIdea(filename) {
        if (!confirm('Are you sure you want to delete this idea permanently?')) return;
        try {
            const response = await fetch(`/api/skills/containment/${encodeURIComponent(filename)}`, {
                method: 'DELETE'
            });
            if (response.ok) {
                window.Alpine.store('global').showToast('Idea deleted.', 'success');
                await this.fetchIdeas();
            }
        } catch (error) {
            console.error('Error deleting idea:', error);
        }
    },

    // --- Executive Focus ---
    saveNextStep() {
        this.savedNextStep = this.nextStep.trim();
        localStorage.setItem('solidstack_focus_step', this.savedNextStep);
        window.Alpine.store('global').showToast('Focus Next Step locked in.', 'success');
    },

    clearNextStep() {
        this.nextStep = '';
        this.savedNextStep = '';
        localStorage.removeItem('solidstack_focus_step');
    },

    startTimer() {
        if (this.timerActive) return;
        this.timerActive = true;
        this.timerInterval = setInterval(() => {
            if (this.timerSeconds === 0) {
                if (this.timerMinutes === 0) {
                    this.stopTimer();
                    this.playNotificationSound();
                    alert('Focus session completed! Take a break.');
                    return;
                }
                this.timerMinutes--;
                this.timerSeconds = 59;
            } else {
                this.timerSeconds--;
            }
        }, 1000);
    },

    stopTimer() {
        this.timerActive = false;
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    },

    resetTimer(mins = 25) {
        this.stopTimer();
        this.timerMinutes = mins;
        this.timerSeconds = 0;
    },

    playNotificationSound() {
        try {
            const context = new (window.AudioContext || window.webkitAudioContext)();
            const osc = context.createOscillator();
            const gain = context.createGain();
            osc.connect(gain);
            gain.connect(context.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, context.currentTime); // A5 note
            gain.gain.setValueAtTime(0.1, context.currentTime);
            osc.start();
            osc.stop(context.currentTime + 0.5);
        } catch (e) {
            console.error('Audio context error:', e);
        }
    },

    // --- Digital Twin Context Sync ---
    async fetchContext() {
        this.loadingContext = true;
        try {
            const response = await fetch('/api/skills/context');
            const data = await response.json();
            this.userContext = data.userContext || '';
            this.operatingManual = data.operatingManual || '';
        } catch (error) {
            console.error('Error fetching context:', error);
        } finally {
            this.loadingContext = false;
        }
    },

    async saveContext() {
        this.savingContext = true;
        try {
            const response = await fetch('/api/skills/context', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userContext: this.userContext,
                    operatingManual: this.operatingManual
                })
            });
            if (response.ok) {
                window.Alpine.store('global').showToast('Digital Twin profiles updated.', 'success');
            }
        } catch (error) {
            console.error('Error saving context:', error);
            window.Alpine.store('global').showToast('Failed to save context.', 'error');
        } finally {
            this.savingContext = false;
        }
    },

    // --- Prompt Genius (Expert Emulation) ---
    async generatePrompt() {
        if (!this.geniusInput.trim()) return;
        this.geniusLoading = true;
        this.geniusOutput = 'Consulting expert logic models...';
        try {
            const response = await fetch('/api/prompt-genius', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: this.geniusInput })
            });
            const data = await response.json();
            this.geniusOutput = data.result || 'No output received.';
        } catch (error) {
            console.error('Prompt Genius error:', error);
            this.geniusOutput = 'Error connecting to Prompt Genius API.';
            window.Alpine.store('global').showToast('Error connecting to Prompt Genius', 'error');
        } finally {
            this.geniusLoading = false;
        }
    }
});
