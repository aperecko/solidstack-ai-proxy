window.Components = window.Components || {};

window.Components.philosophyDomain = () => ({
    selectedDomain: null,

    universalSlots: {
        0: { label: "Root API Gateway", metaphor: "L7 WebSocket/REST Router", verb: "Route" },
        3: { label: "Local Silicon Engine", metaphor: "Raw Tensor/Compute Layer", verb: "Compute" },
        8: { label: "Vector & File Vault", metaphor: "Persistent State Storage", verb: "Store" },
        9: { label: "Grounded Evaluator", metaphor: "Zero-Trust AST Prover", verb: "Verify" }
    },
    domains: [
        {
            id: 'legal',
            name: 'Law & Jurisprudence',
            icon: '⚖️',
            category: 'Professions',
            tagline: 'Oral Arguments, Precedent Trajectory & Constitutional Invariants',
            pfp: {
                present: 'The Courtroom Trial: Live cross-examination, evidence submission, and oral debate.',
                future: 'Litigation Strategy: Phased filings, precedent search, and appellate court deliberation.',
                past: 'Constitutional Grounding: Settled doctrine, case law repositories, and binding precedents.'
            },
            slots: {
                1: { label: 'Oral Arguments (ABBA)', metaphor: 'Live Courtroom Bar', verb: 'Argue' },
                2: { label: 'Legal Instruments (SSmcp)', metaphor: 'Subpoenas & Motions', verb: 'File' },
                4: { label: 'Phased Litigation Schedule', metaphor: 'Trial Trajectory', verb: 'Schedule' },
                5: { label: 'Precedent Discovery Radar', metaphor: 'Case Law Investigation', verb: 'Discover' },
                6: { label: 'Appellate Judicial Bench', metaphor: 'Tribal Court Council', verb: 'Adjudicate' },
                7: { label: 'Constitutional Invariants', metaphor: 'Sovereign Charter', verb: 'Anchor' },
            }
        },
        {
            id: 'medical',
            name: 'Medicine & Surgery',
            icon: '🩺',
            category: 'Professions',
            tagline: 'Bedside Operating Theatre, Prognosis Horizon & Genetic Baseline',
            pfp: {
                present: 'The Operating Theatre: Real-time surgical incision, diagnostic scopes, and vital stability.',
                future: 'Care Trajectory: Post-op recovery roadmap, clinical trial research, and ethics board review.',
                past: 'Biological History: Patient genetic identity, longitudinal EHR charts, and clinical baselines.'
            },
            slots: {
                1: { label: 'Surgical Theatre (ABBA)', metaphor: 'Live Operating Table', verb: 'Operate' },
                2: { label: 'Surgical Tools (SSmcp)', metaphor: 'Scalpels, Scopes & Sensors', verb: 'Actuate' },
                4: { label: 'Post-Op Recovery Plan', metaphor: 'Care Trajectory', verb: 'Treat' },
                5: { label: 'Clinical Literature Radar', metaphor: 'Medical Research Crawl', verb: 'Investigate' },
                6: { label: 'M&M Clinical Ethics Board', metaphor: 'Tribal Specialist Panel', verb: 'Consult' },
                7: { label: 'Patient Genetic Chart', metaphor: 'Biological Invariants', verb: 'Ground' },
            }
        },
        {
            id: 'music',
            name: 'Music & Studio Production',
            icon: '🎷',
            category: 'Arts',
            tagline: 'Live Jam Session, Composition Arrangement & The Master Tapes',
            pfp: {
                present: 'The Live Jam: Real-time soloing, instrument tactile feel, and dynamic improvisation.',
                future: 'Arrangement Horizon: Harmonic progression, sonic frequency research, and band review.',
                past: 'Master Tapes: Signature sound, discography archive, and acoustic room acoustics.'
            },
            slots: {
                1: { label: 'The Live Jam (ABBA)', metaphor: 'Real-time Soloing', verb: 'Play' },
                2: { label: 'Instrument Rig (SSmcp)', metaphor: 'Guitars, Synths & Pedals', verb: 'Perform' },
                4: { label: 'Arrangement Score', metaphor: 'Composition Trajectory', verb: 'Compose' },
                5: { label: 'Sonic Discovery Radar', metaphor: 'Sample & Tone Research', verb: 'Audition' },
                6: { label: 'Ensemble Tribal Council', metaphor: 'Band Harmony Review', verb: 'Harmonize' },
                7: { label: 'Artist Signature Invariant', metaphor: 'Acoustic Tone Identity', verb: 'Ground' },
            }
        },
        {
            id: 'architecture',
            name: 'Architecture & Building',
            icon: '🏛️',
            category: 'Professions',
            tagline: 'Active Job Site, Blueprint Trajectory & As-Built Structural Ledger',
            pfp: {
                present: 'The Job Site: Direct physical masonry, crane operations, and live structural load balance.',
                future: 'Blueprint Horizon: Phased construction scheduling, materials research, and permit review.',
                past: 'Structural Grounding: Soil mechanics, heritage site archives, and stamped engineering proofs.'
            },
            slots: {
                1: { label: 'The Building Floor (ABBA)', metaphor: 'Live Masonry Work', verb: 'Build' },
                2: { label: 'Power Tools & Cranes', metaphor: 'Physical Actuators', verb: 'Construct' },
                4: { label: 'Phased Construction Plan', metaphor: 'Blueprint Trajectory', verb: 'Erect' },
                5: { label: 'Materials Science Radar', metaphor: 'Building Code Search', verb: 'Inspect' },
                6: { label: 'Architectural Review Board', metaphor: 'Tribal Permitting Council', verb: 'Review' },
                7: { label: 'Site Geology Invariants', metaphor: 'Bedrock Baseline', verb: 'Anchor' },
            }
        }
    ],

    isStructural(slotNum) {
        return [0, 3, 8, 9].includes(parseInt(slotNum));
    },
    getSlotData(slotNum) {
        if (this.isStructural(slotNum)) {
            return this.universalSlots[slotNum];
        }
        return this.selectedDomain.slots[slotNum] || {
            label: `Subsystem ${slotNum}`,
            metaphor: "Operational Node",
            verb: "Execute"
        };
    },
    getTierColor(num) {
        const n = parseInt(num);
        if (this.isStructural(n)) return "bg-space-900 border-space-border text-gray-400";
        if (n >= 1 && n <= 3) return "bg-amber-500/5 border-amber-500/30 text-amber-300";
        if (n >= 4 && n <= 6) return "bg-sky-500/5 border-sky-500/30 text-sky-300";
        return "bg-purple-500/5 border-purple-500/30 text-purple-300";
    },
    getTierLabel(num) {
        const n = parseInt(num);
        if (this.isStructural(n)) return "UNIVERSAL STRUCTURAL";
        if (n >= 1 && n <= 2) return "PRESENT: INTERACTION";
        if (n >= 4 && n <= 6) return "FUTURE: INTENTION";
        return "PAST: IDENTITY";
    },
    getTechnicalInvariant(idx) {
        switch (Number(idx)) {
            case 0: return "Root REST & WebSocket Router (19870)";
            case 1: return "ABBA PTY Master & Interactive Shell (19871)";
            case 2: return "SSmcp Tool Bus & Hardware Actuators (19872)";
            case 3: return "Local Silicon & LiteLLM Fallback (19873)";
            case 4: return "OpenClaw Autonomous Runner & Cron (19875)";
            case 5: return "The Computer / External Radar (19876)";
            case 6: return "Tribal Council Consensus Engine (19876/9)";
            case 7: return "Operator Invariants & Personal Context (19874)";
            case 8: return "Vector Memory & Transcript Vault (19874)";
            case 9: return "Grounded Evaluation & Audit Proofs (19878)";
            default: return "System Subsystem";
        }
    },
    init() {
        this.selectedDomain = this.domains[0];
    }
});
