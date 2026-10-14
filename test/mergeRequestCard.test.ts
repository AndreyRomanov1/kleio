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

  it('puts trigger jobs into their stage with the stages of their child pipeline', () => {
    const card = buildCard(
      {
        iid: 1,
        title: 't',
        state: 'opened',
        draft: false,
        webUrl: 'u',
        author: { name: 'Ann', username: 'ann' },
        reviewers: [],
        sourceBranch: 'f',
        targetBranch: 'master',
        hasConflicts: false,
        userNotesCount: 0,
        pipeline: { id: 50, status: 'success', webUrl: 'p' },
      },
      { approvedBy: [], required: 0, left: 0 },
      [{ id: 1, name: 'unit', stage: 'Tests', status: 'success', webUrl: 'j1', allowFailure: false }],
      [
        { id: 3, name: 'to test', stage: 'Deploy', status: 'manual', webUrl: 'b3', allowFailure: false },
        {
          id: 2,
          name: 'to stage',
          stage: 'Deploy',
          status: 'success',
          webUrl: 'b2',
          allowFailure: false,
          downstream: { id: 60, status: 'success', webUrl: 'c60', projectId: 7 },
        },
      ],
      {
        60: [
          { id: 61, name: 'deploy', stage: 'Deploy', status: 'success', webUrl: 'j61', allowFailure: false },
        ],
      },
    );

    const [tests, deploy] = card.pipeline!.stages;
    expect([tests.name, deploy.name]).toEqual(['Tests', 'Deploy']);
    expect(deploy.jobs.map((j) => [j.name, j.bridge, !!j.child])).toEqual([
      ['to stage', true, true],
      ['to test', true, false],
    ]);
    expect(deploy.jobs[0].child?.stages).toEqual([
      {
        name: 'Deploy',
        jobs: [
          {
            id: 61,
            name: 'deploy',
            status: 'success',
            duration: undefined,
            allowFailure: false,
            projectId: 7,
          },
        ],
      },
    ]);
  });
});
