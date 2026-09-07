window.Components = window.Components || {};

window.Components.philosophyDomain = () => ({
    activeSection: 'all',
    selectedSlot: null,

    operatingLaws: [
        {
            num: "01",
            title: "Document Reality, Not Intention",
            badge: "Source of Truth",
            desc: "SolidStack documents and monitors what actually exists on the ground right now—live ports, active daemons, real health metrics. We eliminate documentation debt and wishful thinking by treating live operational facts as the only source of truth."
        },
        {
            num: "02",
            title: "Always Answer: 'Where do I go to fix this?'",
            badge: "Actionable Clarity",
            desc: "No opaque error codes or generic alerts. Every failure maps with laser precision to the responsible layer, node, or service with concrete, executable remediation pathways and clear ownership boundaries."
        },
        {
            num: "03",
            title: "Prevent Redundant Workloads",
            badge: "Unified Topology",
            desc: "One system per responsibility. No parallel duplicate tools doing the same job. The system routes every task to existing system capabilities instead of rebuilding or fragmenting infrastructure."
        },
        {
            num: "04",
            title: "Stay Grounded Under Failure",
            badge: "Calm Recovery",
            desc: "Fewer alerts, clearer boundaries. Calm recovery over noisy alarms. The system is designed to support human nervous system regulation: if a design choice increases anxiety, noise, or panic, it is considered an architectural regression."
        }
    ],

    duality: {
        boring: {
            title: "The Protective Boring Foundation",
            subtitle: "Driven to Absolute Zero Variance",
            points: [
                "Infrastructure, databases, validation schemas, credential isolation, and state plumbing run silently and transparently.",
                "Zero-trust credential isolation via 1Password so secrets are never hardcoded or exposed.",
                "Deterministic ports, daemon process managers, and automated health checks eliminate instability.",
                "The human mind never expends glucose worrying about server uptime or random crashes."
            ]
        },
        wild: {
            title: "The Generative Wild Catalyst",
            subtitle: "Driven to Maximal Creative Flow",
            points: [
                "Multi-agent swarms, autonomous coding loops, and rapid prototyping operate with maximum fluidity.",
                "Dynamic prompt elaboration, deep research synthesis, and speculative code transformations.",
                "Closed-loop co-presence (ABBA: Attune, Execute, Verify, Report) keeps humans in flow without blind friction.",
                "Amplifies human creative capacity, momentum, and strategic focus."
            ]
        }
    },

    structuralLayers: [
        {
            level: "Layer 1",
            name: "The Governance Layer: Tribal Council",
            speed: "Macro Deliberation (Seconds to minutes)",
            role: "Multi-Model Consensus & Safety",
            desc: "High-stakes architectural and infrastructure mutations are cross-examined by diverse frontier AI models (Claude 3.7, Gemini 2.5, DeepSeek) before execution. No single model is treated as omniscient."
        },
        {
            level: "Layer 2",
            name: "The Temporal Coordinate Layer: The Fates",
            speed: "Orchestration Tensors (Continuous)",
            role: "LORAX State Balancing Engine",
            desc: "Separates execution into SPIN (Kinetic Present / Now), CAST (Quantum Trajectory / Future), LORE (Bedrock Invariants / Past), and MIND (Dialectical Supervisor balancing speed with safety)."
        },
        {
            level: "Layer 3",
            name: "The Tactical Infrastructure Layer: MoE & Tool Bus",
            speed: "Microsecond Execution",
            role: "Local Compute & System Actuators",
            desc: "Direct system execution via SSmcp tool bus, LiteLLM fallback routers, Metal-accelerated local models (Metal MoE / Ollama), and deterministic system services."
        }
    ],

    subsystems: [
        { slot: 0, port: "19870", name: "Root API Gateway & Registry", role: "Central L7 HTTP/WebSocket router, service registry, state bus", verb: "Route", tier: "STRUCTURAL", badge: "core" },
        { slot: 1, port: "19871", name: "ABBA Interactive Shell & PTY Host", role: "Live kinetic execution, terminal frames, closed-loop co-presence", verb: "Attune", tier: "PRESENT (SPIN)", badge: "interactive" },
        { slot: 2, port: "19872", name: "SSmcp System Tool Bus & Actuators", role: "Zero-touch system actions, script runner, OS & daemon management", verb: "Actuate", tier: "PRESENT (SPIN)", badge: "tools" },
        { slot: 3, port: "19873", name: "Local Silicon Compute & Fallback", role: "Metal MoE & Ollama offline zero-cloud compute and quota-aware proxy", verb: "Compute", tier: "STRUCTURAL", badge: "silicon" },
        { slot: 4, port: "19874", name: "Vector Memory & Lore Vault", role: "ChromaDB state, session transcripts, 1Password zero-trust credentials", verb: "Store", tier: "PAST (LORE)", badge: "vault" },
        { slot: 5, port: "19875", name: "OpenClaw Autonomous Runner & Cron", role: "Background workers, autonomous scheduled tasks, overnight mutation loops", verb: "Execute", tier: "FUTURE (CAST)", badge: "autonomous" },
        { slot: 6, port: "19876", name: "Research Radar & Harvester", role: "Perplexity research synthesis, upstream GitHub repo harvesters, web crawl", verb: "Discover", tier: "FUTURE (CAST)", badge: "radar" },
        { slot: 7, port: "19877", name: "Tribal Council Consensus Bench", role: "Multi-model governance, cross-model verification gates, architectural consensus", verb: "Adjudicate", tier: "GOVERNANCE", badge: "tribal" },
        { slot: 8, port: "19878", name: "Grounded Evaluator & AST Prover", role: "Zero-trust type checks, static analysis, automated smoke probe test runners", verb: "Verify", tier: "STRUCTURAL", badge: "proof" },
        { slot: 9, port: "19879", name: "Lorax Self-Improvement Deck", role: "Deficit tracking, telemetry analysis, self-healing code mutations", verb: "Evolve", tier: "EVOLUTION", badge: "evolution" }
    ],

    scopeBoundaries: {
        is: [
            "A sovereign, human-centered control plane",
            "A single source of truth for 'what actually exists'",
            "A registry of services, dependencies, and live health",
            "An autonomous guide to responsibility and repair",
            "A local-first engine with hybrid cloud fallbacks",
            "A calm, low-cognitive-burden operational room"
        ],
        isNot: [
            "A noisy notification spam dashboard",
            "A place for bloated, unanchored business logic",
            "A disposable novelty or metaphor toy",
            "A duplication of tools that already work",
            "A vendor-locked cloud black box"
        ]
    },

    getTierColor(tier) {
        if (tier.includes('STRUCTURAL')) return "border-space-border/60 bg-space-900/60 text-gray-300";
        if (tier.includes('PRESENT')) return "border-amber-500/30 bg-amber-500/5 text-amber-300";
        if (tier.includes('FUTURE')) return "border-sky-500/30 bg-sky-500/5 text-sky-300";
        if (tier.includes('PAST')) return "border-purple-500/30 bg-purple-500/5 text-purple-300";
        if (tier.includes('GOVERNANCE')) return "border-emerald-500/30 bg-emerald-500/5 text-emerald-300";
        return "border-fuchsia-500/30 bg-fuchsia-500/5 text-fuchsia-300";
    },

    init() {
        // Ready
    }
});
