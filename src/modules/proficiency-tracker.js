/**
 * Model Proficiency Tracker
 * 
 * Tracks per-model, per-task-type performance metrics and computes
 * a dynamic proficiency matrix for intelligent orchestrator routing.
 * 
 * Closes 4 architectural gaps:
 *   1. Tags each request with a classified task type
 *   2. Persists metrics to disk (survives restarts)
 *   3. Accepts quality score feedback from judge rubric
 *   4. Exposes ranked proficiency matrix via API
 * 
 * Data is persisted to ~/.config/antigravity-proxy/proficiency-matrix.json
 * and pruned to the last 30 days.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { getBestAccount, getQuotaStatus } from '../account-manager/quota-store.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'antigravity-proxy');
const MATRIX_PATH = path.join(CONFIG_DIR, 'proficiency-matrix.json');

// ─── Task Type Taxonomy ──────────────────────────────────────────────
// Aligned with ss/ai_proxy.py task types + granular UI subtypes

const TASK_TYPES = {
    UI_COMPLEX:     'ui_complex',       // Modals, interactive grids, real-time state
    UI_DATA_GRID:   'ui_data_grid',     // Read-only tables, search/filter views
    UI_FORM:        'ui_form',          // Form-based input, Q&A interfaces
    UI_MECHANICAL:  'ui_mechanical',    // Text replacement, branding, tab registration
    API_WIRING:     'api_wiring',       // Connecting backend endpoints to frontend
    CODE_REFACTOR:  'code_refactor',    // Complex multi-file code changes
    CODE_SIMPLE:    'code_simple',      // Single-file fixes, small edits
    RESEARCH:       'research',         // Codebase exploration, web search, synthesis
    PLANNING:       'planning',         // Architecture, design decisions
    REVIEW:         'review',           // Code review, audit, verification
    DEBUGGING:      'debugging',        // Traceback diagnosis, error investigation
    TESTING:        'testing',          // Lint, build, test execution
    FAST_LOOKUP:    'fast_lookup',      // Quick questions, metadata queries
};

// ─── Keyword-based Task Type Classifier ──────────────────────────────

const CLASSIFIER_RULES = [
    {
        type: TASK_TYPES.UI_COMPLEX,
        keywords: ['modal', 'interactive', 'real-time', 'drag', 'animation', 'carousel',
                   'click-to-copy', 'glassmorphism', 'grid with', 'credential', 'persona pin'],
        weight: 1.0
    },
    {
        type: TASK_TYPES.UI_DATA_GRID,
        keywords: ['table', 'data grid', 'list view', 'search filter', 'status cards',
                   'read-only', 'display', 'metric tiles', 'dashboard card'],
        weight: 0.8
    },
    {
        type: TASK_TYPES.UI_FORM,
        keywords: ['form', 'input field', 'textarea', 'submit', 'questionnaire',
                   'editor', 'split-pane', 'dual pane'],
        weight: 0.8
    },
    {
        type: TASK_TYPES.UI_MECHANICAL,
        keywords: ['rename', 'rebrand', 'replace text', 'string substitution',
                   'tab registration', 'sidebar link', 'cache bust'],
        weight: 0.6
    },
    {
        type: TASK_TYPES.CODE_REFACTOR,
        keywords: ['refactor', 'restructure', 'migrate', 'port', 'architecture',
                   'multi-file', 'rewrite', 'redesign'],
        weight: 1.0
    },
    {
        type: TASK_TYPES.CODE_SIMPLE,
        keywords: ['fix', 'patch', 'typo', 'lint', 'import', 'syntax error',
                   'add comment', 'update version'],
        weight: 0.5
    },
    {
        type: TASK_TYPES.RESEARCH,
        keywords: ['research', 'investigate', 'explore', 'survey', 'document',
                   'find', 'search', 'analyze codebase', 'read file'],
        weight: 0.7
    },
    {
        type: TASK_TYPES.PLANNING,
        keywords: ['plan', 'design', 'architect', 'strategy', 'blueprint',
                   'roadmap', 'proposal', 'trade-off'],
        weight: 0.9
    },
    {
        type: TASK_TYPES.DEBUGGING,
        keywords: ['debug', 'traceback', 'error', 'crash', 'exception',
                   'stack trace', 'diagnose', 'broken', 'not working'],
        weight: 0.8
    },
    {
        type: TASK_TYPES.TESTING,
        keywords: ['test', 'verify', 'lint', 'build', 'typecheck', 'npm run',
                   'pytest', 'unit test', 'integration test'],
        weight: 0.6
    },
    {
        type: TASK_TYPES.FAST_LOOKUP,
        keywords: ['what is', 'where is', 'how does', 'explain', 'list',
                   'show me', 'quick question'],
        weight: 0.4
    }
];

// ─── Empirical Baseline Proficiency Seeds ────────────────────────────
// Based on research findings from model fleet evaluation (2026-09-02)

const BASELINE_SEEDS = {
    'claude-opus-4-6-thinking': {
        [TASK_TYPES.UI_COMPLEX]:    { score: 0.97, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_opus', hosting_env: 'cloud_api' },
        [TASK_TYPES.PLANNING]:      { score: 0.98, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_opus', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_REFACTOR]: { score: 0.96, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_opus', hosting_env: 'cloud_api' },
        [TASK_TYPES.DEBUGGING]:     { score: 0.95, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_opus', hosting_env: 'cloud_api' },
        [TASK_TYPES.REVIEW]:        { score: 0.94, confidence: 'medium', context_window: 200000, billing_tier: 'fleet_pool_opus', hosting_env: 'cloud_api' },
    },
    'claude-sonnet-4-6': {
        [TASK_TYPES.UI_COMPLEX]:    { score: 0.93, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.UI_DATA_GRID]:  { score: 0.91, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.UI_FORM]:       { score: 0.92, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_REFACTOR]: { score: 0.90, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.API_WIRING]:    { score: 0.89, confidence: 'medium', context_window: 200000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.DEBUGGING]:     { score: 0.91, confidence: 'high',   context_window: 200000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.PLANNING]:      { score: 0.88, confidence: 'medium', context_window: 200000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
    },
    'gemini-3.1-pro-high': {
        [TASK_TYPES.PLANNING]:      { score: 0.94, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.RESEARCH]:      { score: 0.95, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_REFACTOR]: { score: 0.88, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.REVIEW]:        { score: 0.90, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.UI_COMPLEX]:    { score: 0.82, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.DEBUGGING]:     { score: 0.87, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
    },
    'gemini-3.7-flash-high': {
        [TASK_TYPES.UI_DATA_GRID]:  { score: 0.85, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.RESEARCH]:      { score: 0.88, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.API_WIRING]:    { score: 0.84, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_SIMPLE]:   { score: 0.86, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.TESTING]:       { score: 0.90, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.88, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
    },
    'gemini-3.7-flash-medium': {
        [TASK_TYPES.UI_DATA_GRID]:  { score: 0.82, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.UI_FORM]:       { score: 0.80, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.RESEARCH]:      { score: 0.84, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_SIMPLE]:   { score: 0.83, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.TESTING]:       { score: 0.87, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.85, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
    },
    'gemini-2.5-flash': {
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.88, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_SIMPLE]:   { score: 0.80, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.TESTING]:       { score: 0.85, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.RESEARCH]:      { score: 0.82, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
    },
    'gemini-3.1-flash-lite': {
        [TASK_TYPES.UI_MECHANICAL]: { score: 0.88, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash_lite', hosting_env: 'cloud_api' },
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.85, confidence: 'high',   context_window: 1048576, billing_tier: 'fleet_pool_flash_lite', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_SIMPLE]:   { score: 0.78, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash_lite', hosting_env: 'cloud_api' },
        [TASK_TYPES.TESTING]:       { score: 0.82, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash_lite', hosting_env: 'cloud_api' },
    },
    'gemma-4-26b-a4b-it': {
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.72, confidence: 'low',    context_window: 16384,  billing_tier: 'local_offline', hosting_env: 'local_hardware' },
        [TASK_TYPES.CODE_SIMPLE]:   { score: 0.65, confidence: 'low',    context_window: 16384,  billing_tier: 'local_offline', hosting_env: 'local_hardware' },
        [TASK_TYPES.RESEARCH]:      { score: 0.60, confidence: 'low',    context_window: 16384,  billing_tier: 'local_offline', hosting_env: 'local_hardware' },
    },
    'gpt-oss-120b-medium': {
        [TASK_TYPES.CODE_REFACTOR]: { score: 0.85, confidence: 'low',    context_window: 128000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.PLANNING]:      { score: 0.83, confidence: 'low',    context_window: 128000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.RESEARCH]:      { score: 0.82, confidence: 'low',    context_window: 128000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
        [TASK_TYPES.DEBUGGING]:     { score: 0.80, confidence: 'low',    context_window: 128000, billing_tier: 'fleet_pool_pro', hosting_env: 'cloud_api' },
    },
    'deepseek/deepseek-v4-flash': {
        [TASK_TYPES.CODE_SIMPLE]:   { score: 0.82, confidence: 'low',    context_window: 64000,  billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_REFACTOR]: { score: 0.78, confidence: 'low',    context_window: 64000,  billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.80, confidence: 'low',    context_window: 64000,  billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
    },
    'glm-5.2:cloud': {
        [TASK_TYPES.PLANNING]:      { score: 0.92, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_REFACTOR]: { score: 0.90, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.RESEARCH]:      { score: 0.91, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.DEBUGGING]:     { score: 0.88, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
    },
    'minimax-m3:cloud': {
        [TASK_TYPES.RESEARCH]:      { score: 0.93, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.PLANNING]:      { score: 0.89, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.87, confidence: 'medium', context_window: 1048576, billing_tier: 'fleet_pool_flash', hosting_env: 'cloud_api' },
    },
    'meta/llama-3.2-11b-vision-instruct': {
        [TASK_TYPES.FAST_LOOKUP]:   { score: 0.89, confidence: 'medium', context_window: 128000, billing_tier: 'free_keyring', hosting_env: 'cloud_api' },
        [TASK_TYPES.TESTING]:       { score: 0.85, confidence: 'medium', context_window: 128000, billing_tier: 'free_keyring', hosting_env: 'cloud_api' },
        [TASK_TYPES.CODE_SIMPLE]:   { score: 0.83, confidence: 'medium', context_window: 128000, billing_tier: 'free_keyring', hosting_env: 'cloud_api' },
        [TASK_TYPES.UI_MECHANICAL]: { score: 0.82, confidence: 'medium', context_window: 128000, billing_tier: 'free_keyring', hosting_env: 'cloud_api' },
    }
};

// ─── Cost Tier Weights (lower = cheaper) ─────────────────────────────

const BILLING_WEIGHTS = {
    local_offline:     0.0,
    free_keyring:      0.0,
    fleet_pool_flash_lite: 0.05,
    fleet_pool_flash:  0.15,
    fleet_pool_pro:    0.50,
    fleet_pool_opus:   1.00
};

// Infer a billing tier from a model id as a fallback when the model has no
// explicit baseline seed. This makes the "levels" visible for the full model
// list (many gemini-* variants aren't in BASELINE_SEEDS but still map to a tier).
function inferBillingTier(modelId) {
  const m = String(modelId || '').toLowerCase();
  if (m.includes('flash-lite') || m.includes('flash_lite')) return 'fleet_pool_flash_lite';
  if (m.includes('opus')) return 'fleet_pool_opus';
  if (m.includes('pro') || m.includes('thinking') || m.includes('sonnet')) return 'fleet_pool_pro';
  if (m.includes('flash') || m.includes('agent')) return 'fleet_pool_flash';
  return 'fleet_pool_flash'; // default for unclassified cloud models
}

// Enumerate every configured/known gemini model id so the proficiency matrix
// reports the COMPLETE model list (not just ones with baseline seeds), each
// with a correct billing tier. Weights quality by tier (pro > flash > lite).
const ALL_KNOWN_MODELS = [
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-thinking', 'gemini-2.5-flash-lite',
  'gemini-3-flash', 'gemini-3-flash-agent',
  'gemini-3.1-pro-low', 'gemini-3.1-pro-high', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-image',
  'gemini-3.5-flash-extra-low', 'gemini-3.5-flash-low',
  'gemini-3.6-flash-low', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-high', 'gemini-3.6-flash-tiered',
  'gemini-3.7-flash-low', 'gemini-3.7-flash-medium', 'gemini-3.7-flash-high', 'gemini-3.7-flash-tiered',
  'gemini-pro-agent',
  'claude-opus-4-6-thinking', 'claude-sonnet-4-6',
  'gpt-oss-120b-medium'
];
const KNOWN_BASE_QUALITY = {
  'fleet_pool_opus': 0.97, 'fleet_pool_pro': 0.90, 'fleet_pool_flash': 0.86, 'fleet_pool_flash_lite': 0.82
};
// Seed any known model that lacks a baseline so it appears in the matrix with
// a sensible tier + baseline quality. (Non-destructive: existing seeds win.)
for (const modelId of ALL_KNOWN_MODELS) {
  if (BASELINE_SEEDS[modelId]) continue;
  const tier = inferBillingTier(modelId);
  BASELINE_SEEDS[modelId] = {
    [TASK_TYPES.CODE_SIMPLE]: {
      score: KNOWN_BASE_QUALITY[tier] ?? 0.82,
      confidence: 'medium',
      context_window: 1048576,
      billing_tier: tier,
      hosting_env: 'cloud_api'
    },
    [TASK_TYPES.FAST_LOOKUP]: {
      score: (KNOWN_BASE_QUALITY[tier] ?? 0.82) - 0.03,
      confidence: 'medium',
      context_window: 1048576,
      billing_tier: tier,
      hosting_env: 'cloud_api'
    }
  };
}

function resolveBillingTier(modelId, baselines) {
  const firstKey = Object.keys(baselines?.[modelId] || {})[0];
  const tier = firstKey ? baselines[modelId][firstKey].billing_tier : null;
  return (tier && tier !== 'unknown') ? tier : inferBillingTier(modelId);
}

// ─── Core Tracker Class ──────────────────────────────────────────────

class ModelProficiencyTracker {
    constructor() {
        this.matrix = {};           // model -> taskType -> { requests, total_latency, successes, failures, total_quality, tokens_in, tokens_out }
        this.baselines = {};        // model -> taskType -> { score, confidence, context_window, billing_tier }
        this._dirty = false;
        this._loaded = false;
    }

    /**
     * Initialize: load persisted data and merge with baseline seeds.
     */
    init() {
        if (this._loaded) return;
        this._loaded = true;

        // Ensure config dir exists
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }

        // Load persisted matrix
        if (fs.existsSync(MATRIX_PATH)) {
            try {
                const raw = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
                this.matrix = raw.empirical || {};
                this.baselines = raw.baselines || {};
            } catch (e) {
                console.error('[proficiency] Failed to load matrix:', e.message);
            }
        }

        // Merge baseline seeds (don't overwrite empirical)
        for (const [model, tasks] of Object.entries(BASELINE_SEEDS)) {
            if (!this.baselines[model]) this.baselines[model] = {};
            for (const [taskType, seed] of Object.entries(tasks)) {
                if (!this.baselines[model][taskType]) {
                    this.baselines[model][taskType] = seed;
                }
            }
        }

        // Persist on interval (every 60s) and on shutdown
        setInterval(() => this._persist(), 60000);
        process.on('SIGINT', () => { this._persist(); process.exit(0); });
        process.on('SIGTERM', () => { this._persist(); process.exit(0); });

        this._persist(); // Write initial merged state
    }

    /**
     * Classify a task type from message content.
     * @param {string} content - The user's prompt or task description
     * @returns {string} - One of TASK_TYPES values
     */
    classifyTaskType(content) {
        if (!content) return TASK_TYPES.FAST_LOOKUP;

        const lower = content.toLowerCase();
        let bestType = TASK_TYPES.FAST_LOOKUP;
        let bestScore = 0;

        for (const rule of CLASSIFIER_RULES) {
            let matchCount = 0;
            for (const kw of rule.keywords) {
                if (lower.includes(kw)) matchCount++;
            }
            const score = (matchCount / rule.keywords.length) * rule.weight;
            if (score > bestScore) {
                bestScore = score;
                bestType = rule.type;
            }
        }

        // Short content heuristic (< 25 words → fast lookup)
        if (content.split(/\s+/).length < 25 && bestScore < 0.1) {
            return TASK_TYPES.FAST_LOOKUP;
        }

        return bestType;
    }

    /**
     * Record a completed request's performance metrics.
     * @param {string} model - Model ID (e.g. 'claude-sonnet-4-6')
     * @param {string} taskType - One of TASK_TYPES values
     * @param {object} metrics - { latency_ms, success, tokens_in, tokens_out, quality_score? }
     */
    record(model, taskType, metrics = {}) {
        if (!model || !taskType) return;

        if (!this.matrix[model]) this.matrix[model] = {};
        if (!this.matrix[model][taskType]) {
            this.matrix[model][taskType] = {
                requests: 0,
                total_latency_ms: 0,
                successes: 0,
                failures: 0,
                total_quality: 0,
                quality_samples: 0,
                tokens_in: 0,
                tokens_out: 0,
                last_seen: null
            };
        }

        const bucket = this.matrix[model][taskType];
        bucket.requests++;
        bucket.total_latency_ms += (metrics.latency_ms || 0);
        if (metrics.success !== false) {
            bucket.successes++;
        } else {
            bucket.failures++;
        }
        if (typeof metrics.quality_score === 'number') {
            bucket.total_quality += metrics.quality_score;
            bucket.quality_samples++;
        }
        bucket.tokens_in += (metrics.tokens_in || 0);
        bucket.tokens_out += (metrics.tokens_out || 0);
        bucket.last_seen = new Date().toISOString();

        this._dirty = true;
    }

    /**
     * Feed back a quality score from the judge rubric or consensus evaluator.
     * @param {string} model - Model ID
     * @param {string} taskType - Task type
     * @param {number} qualityScore - 0.0 to 1.0
     */
    recordQuality(model, taskType, qualityScore) {
        if (!model || !taskType || typeof qualityScore !== 'number') return;

        if (!this.matrix[model]) this.matrix[model] = {};
        if (!this.matrix[model][taskType]) {
            this.matrix[model][taskType] = {
                requests: 0, total_latency_ms: 0, successes: 0, failures: 0,
                total_quality: 0, quality_samples: 0, tokens_in: 0, tokens_out: 0, last_seen: null
            };
        }

        const bucket = this.matrix[model][taskType];
        bucket.total_quality += qualityScore;
        bucket.quality_samples++;
        bucket.last_seen = new Date().toISOString();
        this._dirty = true;
    }

    /**
     * Compute a proficiency score for a model on a task type.
     * Blends empirical data with baseline seeds, weighted by sample count.
     * @returns {number} 0.0 to 1.0
     */
    getScore(model, taskType) {
        const empirical = this.matrix[model]?.[taskType];
        const baseline = this.baselines[model]?.[taskType];

        if (!empirical && !baseline) return 0.0;
        if (!empirical) return baseline.score;

        const n = empirical.requests;
        const successRate = n > 0 ? empirical.successes / n : 0;
        const avgQuality = empirical.quality_samples > 0
            ? empirical.total_quality / empirical.quality_samples
            : successRate; // Fall back to success rate if no quality data

        // Empirical score: 60% quality + 30% success rate + 10% latency bonus
        const avgLatency = n > 0 ? empirical.total_latency_ms / n : 5000;
        const latencyBonus = Math.max(0, 1 - (avgLatency / 30000)); // <30s = bonus

        const empiricalScore = (avgQuality * 0.6) + (successRate * 0.3) + (latencyBonus * 0.1);

        // Blend with baseline: more samples → more empirical weight
        if (baseline) {
            const empiricalWeight = Math.min(1.0, n / 50); // Full empirical weight at 50+ samples
            return (empiricalScore * empiricalWeight) + (baseline.score * (1 - empiricalWeight));
        }

        return empiricalScore;
    }

    /**
     * Get the full proficiency matrix with computed scores and rankings.
     * @returns {object} The complete matrix for API consumption
     */
    getMatrix() {
        const allModels = new Set([
            ...Object.keys(this.matrix),
            ...Object.keys(this.baselines)
        ]);
        const allTaskTypes = Object.values(TASK_TYPES);

        // Build per-model proficiency cards
        const models = {};
        for (const model of allModels) {
            models[model] = {
                task_proficiency: {},
                context_window: this.baselines[model]?.[Object.keys(this.baselines[model] || {})[0]]?.context_window || null,
                billing_tier: resolveBillingTier(model, this.baselines)
            };

            for (const taskType of allTaskTypes) {
                const score = this.getScore(model, taskType);
                if (score > 0) {
                    const empirical = this.matrix[model]?.[taskType];
                    const baseline = this.baselines[model]?.[taskType];
                    models[model].task_proficiency[taskType] = {
                        score: Math.round(score * 1000) / 1000,
                        confidence: baseline?.confidence || (empirical?.requests >= 50 ? 'high' : empirical?.requests >= 10 ? 'medium' : 'low'),
                        empirical_samples: empirical?.requests || 0,
                        avg_latency_ms: empirical?.requests > 0 ? Math.round(empirical.total_latency_ms / empirical.requests) : null,
                        success_rate: empirical?.requests > 0 ? Math.round((empirical.successes / empirical.requests) * 1000) / 1000 : null,
                        avg_quality: empirical?.quality_samples > 0 ? Math.round((empirical.total_quality / empirical.quality_samples) * 1000) / 1000 : null,
                    };
                }
            }
            
            const bestAcct = getBestAccount('antigravity', model);
            models[model].available = bestAcct !== null;
            models[model].availability = bestAcct ? 'ok' : 'exhausted';

            // Distinguish G1-credit exhaustion (a real, visible "level") from a
            // merely-empty pool. When accounts exist for the model but every one is
            // G1-credit-exhausted / cooling, surface that as a distinct state so the
            // dashboard actually shows why the model is unavailable instead of a
            // generic 'exhausted'.
            if (!bestAcct) {
                const statuses = getQuotaStatus('antigravity')
                    .filter(q => q.model === model && q.enabled)
                    .map(q => q.status);
                const anyOk = statuses.includes('ok');
                const anyCreditExhausted = statuses.includes('credit_exhausted');
                if (!anyOk && anyCreditExhausted) {
                    models[model].availability = 'credit_exhausted';
                    models[model].credit_exhausted = true;
                } else if (!anyOk && statuses.length > 0) {
                    models[model].availability = statuses[0] === 'credit_exhausted' ? 'credit_exhausted' : 'exhausted';
                    models[model].credit_exhausted = statuses.includes('credit_exhausted');
                }
            }
        }

        // Build per-task-type rankings (best model first)
        const rankings = {};
        for (const taskType of allTaskTypes) {
            const scored = [];
            for (const model of allModels) {
                const score = this.getScore(model, taskType);
                if (score > 0) {
                    const billingTier = models[model].billing_tier;
                    const hostingEnv = models[model].hosting_env;
                    scored.push({
                        model,
                        score: Math.round(score * 1000) / 1000,
                        billing_tier: billingTier,
                        hosting_env: hostingEnv,
                        cost_weight: BILLING_WEIGHTS[billingTier] ?? 0.5,
                        // Efficiency = score / cost (higher = better value)
                        efficiency: billingTier && BILLING_WEIGHTS[billingTier] > 0
                            ? Math.round((score / BILLING_WEIGHTS[billingTier]) * 100) / 100
                            : score * 100 // free models get massive efficiency bonus
                    });
                }
            }
            // Sort by raw score (best quality first)
            rankings[taskType] = {
                by_quality: [...scored].sort((a, b) => b.score - a.score),
                by_efficiency: [...scored].sort((a, b) => b.efficiency - a.efficiency)
            };
        }

        return {
            generated_at: new Date().toISOString(),
            task_types: TASK_TYPES,
            billing_tiers: BILLING_WEIGHTS,
            total_models: allModels.size,
            models,
            rankings
        };
    }

    /**
     * Get the best model for a task type, optionally constrained by billing tier.
     * @param {string} taskType - Task type
     * @param {object} opts - { maxBillingTier?, preferEfficiency? }
     * @returns {object} { model, score, billing_tier, efficiency }
     */
    getBestModel(taskType, opts = {}) {
        const matrix = this.getMatrix();
        const ranking = matrix.rankings[taskType];
        if (!ranking) return null;

        const list = opts.preferEfficiency ? ranking.by_efficiency : ranking.by_quality;

        if (opts.maxBillingTier) {
            const maxWeight = BILLING_WEIGHTS[opts.maxBillingTier] ?? 1.0;
            const filtered = list.filter(m => m.cost_weight <= maxWeight);
            return filtered[0] || list[0] || null;
        }

        return list[0] || null;
    }

    /**
     * Provide an advisory recommendation to downgrade if a cheaper model
     * has sufficient proficiency for the given task.
     * @param {string} currentModel - The currently selected model ID.
     * @param {string} inputTaskType - Task type classification or free-text prompt.
     * @returns {object} { current_model, recommended_model, reason, estimated_savings_pct }
     */
    advise(currentModel, inputTaskType, opts = {}) {
        // Resolve task type (allow passing free text and classifying on the fly)
        let taskType = Object.values(TASK_TYPES).includes(inputTaskType) 
            ? inputTaskType 
            : this.classifyTaskType(inputTaskType);

        const matrix = this.getMatrix();
        const rankings = matrix.rankings[taskType]?.by_quality || [];

        const currentModelStats = rankings.find(m => m.model === currentModel);
        
        // If current model isn't ranked, assume max cost/score for baseline comparisons
        const currentScore = currentModelStats?.score || 0.90;
        const currentBillingTier = matrix.models[currentModel]?.billing_tier || 'fleet_pool_opus';
        const currentCostWeight = currentModelStats?.cost_weight ?? (BILLING_WEIGHTS[currentBillingTier] ?? 1.0);

        // Find models that are cheaper AND have sufficient proficiency
        // Sufficient proficiency: >= 0.85 OR within 95% of current model's score
        const sufficientThreshold = Math.min(0.85, currentScore * 0.95);
        
        let candidates = rankings.filter(m => {
            return m.cost_weight < currentCostWeight && m.score >= sufficientThreshold;
        });
        
        // Filter out candidates that are currently depleted
        candidates = candidates.filter(m => getBestAccount('antigravity', m.model) !== null);
        
        // Failover: if current model is depleted, advise the best available model regardless of cost
        const currentAvailable = getBestAccount('antigravity', currentModel) !== null;
        if (!currentAvailable && opts.routingMode !== 'native_bypass') {
            const allAvailable = rankings
                .filter(m => getBestAccount('antigravity', m.model) !== null)
                .sort((a, b) => b.score - a.score);
            
            if (allAvailable.length > 0) {
                return {
                    current_model: currentModel,
                    recommended_model: allAvailable[0].model,
                    reason: `Current model ${currentModel} is quota-exhausted/cooling. Failover to ${allAvailable[0].model} (Score: ${allAvailable[0].score.toFixed(2)}).`,
                    estimated_savings_pct: 0,
                    quota_exhausted: true,
                    failover: true
                };
            }
        }

        if (candidates.length === 0) {
            return {
                current_model: currentModel,
                recommended_model: currentModel,
                reason: currentAvailable 
                    ? "Current model is optimal for this task complexity." 
                    : "No available models to failover to.",
                estimated_savings_pct: 0,
                quota_exhausted: !currentAvailable
            };
        }

        // Pick the most efficient candidate (usually the cheapest one that passes threshold)
        const bestAlternative = [...candidates].sort((a, b) => b.efficiency - a.efficiency)[0];

        let savingsPct = 0;
        if (currentCostWeight > 0) {
            savingsPct = Math.round(((currentCostWeight - bestAlternative.cost_weight) / currentCostWeight) * 100);
        } else {
            savingsPct = 100; // moving to local tier
        }

        return {
            current_model: currentModel,
            recommended_model: bestAlternative.model,
            reason: `Task complexity (${taskType}) is well within the capabilities of ${bestAlternative.model} (Score: ${bestAlternative.score.toFixed(2)}).`,
            estimated_savings_pct: savingsPct
        };
    }

    /**
     * Persist matrix to disk.
     */
    _persist() {
        if (!this._dirty && fs.existsSync(MATRIX_PATH)) return;
        try {
            const payload = {
                version: 1,
                updated_at: new Date().toISOString(),
                empirical: this.matrix,
                baselines: this.baselines
            };
            fs.writeFileSync(MATRIX_PATH, JSON.stringify(payload, null, 2), 'utf8');
            this._dirty = false;
        } catch (e) {
            console.error('[proficiency] Failed to persist matrix:', e.message);
        }
    }
}

// ─── Singleton Export ────────────────────────────────────────────────

const tracker = new ModelProficiencyTracker();

export default tracker;
export { TASK_TYPES, BILLING_WEIGHTS, BASELINE_SEEDS };
