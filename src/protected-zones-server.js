/**
 * Server-side mirror of src/components/evolve/protected-zones.ts
 *
 * Intentionally duplicated rather than shared: the frontend gate and
 * the backend tool handler should each refuse independently, so a bug
 * or bypass in one layer doesn't remove the safety check entirely.
 * Keep this list in sync by hand when protected-zones.ts changes.
 */
const PROTECTED_ZONES = new Set([
    'console-top-bar',
    'evolve-drawer',
    'account-kill-switch',
    'throttle-controls',
]);

export function isProtectedZoneServer(zoneId) {
    return PROTECTED_ZONES.has(zoneId);
}
