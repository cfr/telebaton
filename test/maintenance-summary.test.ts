import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maintenanceCampaignSummary, maintenanceReportSummary } from '../src/maintenance-summary.ts';

test('campaign preview contains its overview, range and chunk names without the scope document', () => {
    const document = '# R01 — Maintainability\n\n## Summary\nReview ownership and duplication.\n\n' +
        '## Instructions\nFULL_CONTRACT_DETAILS\n\n### R01.01 — Core\nFULL_CORE_SCOPE\n';
    const preview = maintenanceCampaignSummary(document, [{ id: 'R01.01', title: '— Core' }, { id: 'R01.02', title: '— Tests' }]);
    assert.match(preview, /Review ownership and duplication/);
    assert.match(preview, /2 chunks · range R01.01-R01.02/);
    assert.match(preview, /- R01.01 — Core\n- R01.02 — Tests/);
    assert.doesNotMatch(preview, /FULL_CONTRACT_DETAILS|FULL_CORE_SCOPE/);
});

test('review preview extracts stable finding titles and counts investigations without their descriptions', () => {
    const preview = maintenanceReportSummary('## Summary\nSimplify shared bookkeeping.\n\n' +
        '## Coverage\nCOVERAGE_DETAILS\n## Findings\n' +
        '### R01.01-kimi-001 — Remove duplicate updates\nLONG_EVIDENCE\n#### Tests\nLONG_TEST_PLAN\n' +
        '### R01.01-kimi-002 — Clarify ownership\nLONG_DESIGN\n' +
        '## Investigations\n### R01.01-kimi-I01 — Check fixture ownership\nLONG_INVESTIGATION\n' +
        '## Examined without changes\nOTHER_AREAS');
    assert.match(preview, /2 findings · 1 investigation/);
    assert.match(preview, /Simplify shared bookkeeping/);
    assert.match(preview, /- R01.01-kimi-001 — Remove duplicate updates/);
    assert.match(preview, /- R01.01-kimi-002 — Clarify ownership/);
    assert.doesNotMatch(preview, /LONG_|COVERAGE_DETAILS|OTHER_AREAS|Check fixture ownership/);
});

test('existing list and table reports retain finding names but omit nested evidence', () => {
    for (const findings of [
        '- **R01.01-glm-001 — Reuse the parser**\n  - Evidence: DETAILED_EVIDENCE\n  - Risk: DETAILED_RISK\n',
        '| ID | Title | Evidence |\n| --- | --- | --- |\n| R01.01-glm-001 | Reuse the parser | DETAILED_EVIDENCE |\n',
    ]) {
        const preview = maintenanceReportSummary(`## Findings\n${findings}\n## Investigations\nNone.`);
        assert.match(preview, /1 finding · 0 investigations/);
        assert.match(preview, /R01.01-glm-001 — Reuse the parser/);
        assert.doesNotMatch(preview, /DETAILED_/);
    }
});

test('no-findings reports and unrecognized layouts never invent findings or claim a false clean review', () => {
    for (const text of ['No worthwhile changes found.', '- None.']) {
        const preview = maintenanceReportSummary(`## Findings\n${text}\n## Investigations\nNone.`);
        assert.match(preview, /0 findings · 0 investigations/);
        assert.match(preview, /No actionable findings/);
    }
    const unknown = maintenanceReportSummary('## Findings\nComplicated layout with unstructured findings and FULL_DETAIL\n## Investigations\nNone.');
    assert.match(unknown, /findings in full report/);
    assert.doesNotMatch(unknown, /0 findings|No actionable findings|FULL_DETAIL/);
});
