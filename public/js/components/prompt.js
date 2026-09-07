/**
 * Prompt Component
 * Handles the 'Prompt Genius' split-pane view for rough-to-expert prompt compilation
 */
window.Components = window.Components || {};

window.Components.prompt = () => ({
    roughPrompt: '',
    expertPrompt: '',
    isCompiling: false,

    init() {
        console.log('Prompt component initialized');
    },

    clearAll() {
        this.roughPrompt = '';
        this.expertPrompt = '';
        this.isCompiling = false;
    },

    async copyExpert() {
        if (!this.expertPrompt) return;
        try {
            await navigator.clipboard.writeText(this.expertPrompt);
            if (this.$store && this.$store.global && typeof this.$store.global.showToast === 'function') {
                this.$store.global.showToast('Copied to clipboard', 'success');
            }
        } catch (err) {
            console.error('Failed to copy', err);
            if (this.$store && this.$store.global && typeof this.$store.global.showToast === 'function') {
                this.$store.global.showToast('Failed to copy', 'error');
            }
        }
    },

    async compilePrompt() {
        if (!this.roughPrompt.trim()) return;
        
        this.isCompiling = true;
        this.expertPrompt = '';

        try {
            // Attempt to use the proxy v1 API directly if available to compile the prompt
            const password = this.$store && this.$store.global ? this.$store.global.webuiPassword : '';
            const systemPrompt = `You are an expert Prompt Engineer. The user will provide a rough prompt idea. Your job is to compile it into a detailed, structured, expert-level prompt that clearly defines the role, context, task, constraints, and expected output format. Output ONLY the compiled prompt without conversational filler.`;
            
            const response = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${password}`
                },
                body: JSON.stringify({
                    model: 'auto',
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: this.roughPrompt }
                    ]
                })
            });

            if (!response.ok) {
                throw new Error(`API returned ${response.status}`);
            }

            const data = await response.json();
            
            if (data.choices && data.choices.length > 0 && data.choices[0].message) {
                this.expertPrompt = data.choices[0].message.content;
            } else {
                throw new Error('Unexpected API response format');
            }

        } catch (err) {
            console.error('Compilation failed:', err);
            
            if (this.$store && this.$store.global && typeof this.$store.global.showToast === 'function') {
                this.$store.global.showToast('Compilation failed: ' + err.message + ' - using fallback', 'warning');
            }
            
            // Fallback mock if the API call fails or is unavailable
            this.expertPrompt = `# Role\nYou are an expert assistant.\n\n# Context\nThe user needs help based on the following rough idea: "${this.roughPrompt}"\n\n# Task\nPlease fulfill the user's request efficiently.\n\n# Guidelines\n- Be concise\n- Ensure accuracy`;
            
        } finally {
            this.isCompiling = false;
        }
    }
});
