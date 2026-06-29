"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.daysBetween = daysBetween;
exports.computePhase = computePhase;
exports.enrichBuild = enrichBuild;
exports.avg = avg;
exports.monthStart = monthStart;
exports.monthEnd = monthEnd;
function daysBetween(from, to) {
    if (!from || !to)
        return null;
    const diff = new Date(to).getTime() - new Date(from).getTime();
    return Math.round(diff / (1000 * 60 * 60 * 24));
}
function computePhase(build) {
    if (build.outcome_decided)
        return 'decided';
    if (build.into_testing)
        return 'testing';
    if (build.into_proofread)
        return 'proofread';
    if (build.phase1_start)
        return 'building';
    return 'pending';
}
function enrichBuild(build) {
    const today = new Date().toISOString().split('T')[0];
    return {
        ...build,
        phase: computePhase(build),
        build_days: daysBetween(build.phase1_start, build.phase1_end),
        proof_days: daysBetween(build.into_proofread, build.proof_end),
        test_days: daysBetween(build.into_testing, build.outcome_decided),
        total_days: build.phase1_start
            ? daysBetween(build.phase1_start, build.outcome_decided ?? today)
            : null,
    };
}
function avg(nums) {
    const valid = nums.filter((n) => n !== null);
    if (valid.length === 0)
        return null;
    return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
}
function monthStart(monthStr) {
    return `${monthStr}-01`;
}
function monthEnd(monthStr) {
    const [year, month] = monthStr.split('-').map(Number);
    const last = new Date(year, month, 0).getDate();
    return `${monthStr}-${String(last).padStart(2, '0')}`;
}
