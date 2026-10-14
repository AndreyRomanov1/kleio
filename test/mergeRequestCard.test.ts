import { describe, expect, it } from 'vitest';
import { buildCard } from '../src/extension/hosting/mergeRequestCard';

describe('buildCard', () => {
  it('groups jobs by stage and marks reviewers who approved', () => {
    const card = buildCard(
      {
        iid: 9,
        title: 't',
        state: 'opened',
        draft: false,
        webUrl: 'u',
        author: { name: 'Ann', username: 'ann' },
        reviewers: [
          { name: 'Bob', username: 'bob' },
          { name: 'Eve', username: 'eve' },
        ],
        sourceBranch: 'feature',
        targetBranch: 'master',
        hasConflicts: false,
        mergeStatus: 'not_approved',
        userNotesCount: 2,
        pipeline: { id: 50, status: 'failed', webUrl: 'p' },
      },
      {
        approvedBy: [
          { name: 'Bob', username: 'bob' },
          { name: 'Lead', username: 'lead' },
        ],
        required: 2,
        left: 0,
      },
      [
        {
          id: 1,
          name: 'build',
          stage: 'Build',
          status: 'success',
          duration: 10,
          webUrl: 'j1',
          allowFailure: false,
        },
        { id: 2, name: 'unit', stage: 'Tests', status: 'failed', webUrl: 'j2', allowFailure: false },
        { id: 3, name: 'format', stage: 'Tests', status: 'success', webUrl: 'j3', allowFailure: true },
      ],
    );

    expect(card.reviewers).toEqual([
      { name: 'Bob', approved: true },
      { name: 'Eve', approved: false },
    ]);
    expect(card.approvedBy).toEqual(['Lead']);
    expect(card.pipeline?.stages.map((s) => [s.name, s.jobs.map((j) => j.name)])).toEqual([
      ['Build', ['build']],
      ['Tests', ['unit', 'format']],
    ]);
  });
});
