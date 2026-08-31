window.Components = window.Components || {};

window.Components.agentChat = () => ({
    activeAgent: 'tech',
    messages: [],
    inputMessage: '',
    loading: false,
    sessionId: null,
    proposedActions: [],
    selectedActionIds: [],
    evidenceRefs: [],
    warnings: [],
    applyingActions: false,
    pollTimer: null,

    async switchAgent(agent) {
        if (this.activeAgent === agent) return;
        // Save current draft before switching
        try {
            if (this.inputMessage) {
                localStorage.setItem(`solidstack_draft_${this.activeAgent}`, this.inputMessage);
            }
        } catch {}
        this.activeAgent = agent;
        this.messages = [];
        this.proposedActions = [];
        this.selectedActionIds = [];
        this.evidenceRefs = [];
        this.warnings = [];
        try {
            this.inputMessage = localStorage.getItem(`solidstack_draft_${this.activeAgent}`) || '';
        } catch {}
        await this.fetchConversations();
    },

    async fetchConversations() {
        try {
            const res = await fetch(`/api/agents/conversations?agent=${this.activeAgent}&limit=30`);
            if (res.ok) {
                const data = await res.json();
                this.messages = data.items || [];
                // If the last assistant message had proposed actions, extract them
                const lastAssistant = [...this.messages].reverse().find(m => m.role === 'assistant');
                if (lastAssistant && lastAssistant.metadata && lastAssistant.metadata.proposed_actions) {
                    this.proposedActions = lastAssistant.metadata.proposed_actions || [];
                    this.evidenceRefs = lastAssistant.metadata.evidence_refs || [];
                    this.warnings = lastAssistant.metadata.warnings || [];
                }
                const lastEntry = this.messages[this.messages.length - 1];
                if (lastEntry && lastEntry.session_id) {
                    this.sessionId = lastEntry.session_id;
                }
            }
        } catch (e) {
            console.error('Failed to fetch agent conversations:', e);
        }
    },

    async sendMessage() {
        const text = (this.inputMessage || '').trim();
        if (!text || this.loading) return;

        this.loading = true;
        const userMsg = {
            role: 'user',
            content: text,
            timestamp: new Date().toISOString(),
            session_id: this.sessionId
        };
        this.messages.push(userMsg);
        this.inputMessage = '';
        try {
            localStorage.setItem(`solidstack_draft_${this.activeAgent}`, '');
        } catch {}

        this.$nextTick(() => {
            this.scrollToBottom();
        });

        const maxRetries = 3;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch('/api/actions/agents/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        agent: this.activeAgent,
                        message: text,
                        session_id: this.sessionId
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    this.sessionId = data.session_id || this.sessionId;
                    this.proposedActions = data.proposed_actions || [];
                    this.selectedActionIds = this.proposedActions.map(a => a.id);
                    this.evidenceRefs = data.evidence_refs || [];
                    this.warnings = data.warnings || [];

                    this.messages.push({
                        role: 'assistant',
                        content: data.response || 'Action processed.',
                        timestamp: new Date().toISOString(),
                        session_id: this.sessionId,
                        metadata: {
                            proposed_actions: this.proposedActions,
                            evidence_refs: this.evidenceRefs,
                            warnings: this.warnings
                        }
                    });
                    lastError = null;
                    break;
                } else {
                    // If transient server restart (502 / 503 / 504), retry with backoff
                    if ([502, 503, 504, 520, 521, 522].includes(res.status) && attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, attempt * 1500));
                        continue;
                    }
                    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
                    lastError = err.error || 'Failed to get agent response';
                    break;
                }
            } catch (e) {
                // Network error (e.g. proxy restarting)
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, attempt * 1500));
                    continue;
                }
                lastError = `Network connection interrupted: ${e.message}`;
            }
        }

        if (lastError) {
            this.messages.push({
                role: 'assistant',
                content: `⚠️ ${lastError}`,
                timestamp: new Date().toISOString()
            });
        }

        this.loading = false;
        this.$nextTick(() => {
            this.scrollToBottom();
        });
    },

    async applyBatchActions() {
        if (!this.selectedActionIds.length || this.applyingActions) return;
        this.applyingActions = true;

        try {
            const res = await fetch('/api/actions/agents/batch-apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agent: this.activeAgent,
                    action_ids: this.selectedActionIds,
                    session_id: this.sessionId
                })
            });

            const data = await res.json();
            if (res.ok && data.status === 'ok') {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Applied ${data.applied_count || this.selectedActionIds.length} action(s) successfully!`, 'success');
                }
                this.proposedActions = [];
                this.selectedActionIds = [];
                await this.fetchConversations();
            } else {
                if (Alpine.store('global')?.showToast) {
                    Alpine.store('global').showToast(`Batch apply warning: ${data.message || data.error || 'Unknown'}`, 'error');
                }
            }
        } catch (e) {
            if (Alpine.store('global')?.showToast) {
                Alpine.store('global').showToast(`Failed to apply actions: ${e.message}`, 'error');
            }
        } finally {
            this.applyingActions = false;
        }
    },

    toggleAction(id) {
        if (this.selectedActionIds.includes(id)) {
            this.selectedActionIds = this.selectedActionIds.filter(x => x !== id);
        } else {
            this.selectedActionIds.push(id);
        }
    },

    scrollToBottom() {
        const el = document.getElementById('agent-chat-messages-container');
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    },

    formatMarkdown(content) {
        if (!content) return '';
        let escaped = String(content)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // Code blocks ```code```
        escaped = escaped.replace(/```([\s\S]*?)```/g, (match, p1) => {
            return `<pre class="my-2 p-3 bg-black/60 rounded-xl font-mono text-xs text-neon-cyan overflow-x-auto border border-space-border/60"><code>${p1.trim()}</code></pre>`;
        });

        // Inline `code`
        escaped = escaped.replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-black/40 text-neon-purple font-mono text-xs border border-space-border/40">$1</code>');

        // Bold **text**
        escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-white font-bold">$1</strong>');

        // Line breaks
        escaped = escaped.replace(/\n/g, '<br>');
        return escaped;
    },

    init() {
        try {
            this.inputMessage = localStorage.getItem(`solidstack_draft_${this.activeAgent}`) || '';
        } catch {}
        this.fetchConversations();
        this.pollTimer = setInterval(() => {
            if (!this.loading && !this.applyingActions) {
                this.fetchConversations();
            }
        }, 8000);
    },

    destroy() {
        if (this.pollTimer) clearInterval(this.pollTimer);
    }
});
