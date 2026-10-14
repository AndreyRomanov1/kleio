// A fake GitLab for the integration tests: one merge request (!1) of the test repository, its discussions and
// drafts. It keeps what Grove sends, and GET /__requests returns the recorded requests for assertions.
import { createServer } from 'node:http';

export async function startFakeGitLab({ baseSha, headSha }) {
  const project = '/api/v4/projects/group%2Fproject';
  const requests = [];
  const discussions = [
    {
      id: 'existing',
      individual_note: false,
      notes: [
        {
          id: 1,
          body: 'Почему так?',
          author: { name: 'Reviewer', username: 'reviewer' },
          created_at: '2026-01-02T10:00:00Z',
          resolvable: true,
          resolved: false,
          position: {
            base_sha: baseSha,
            start_sha: baseSha,
            head_sha: headSha,
            old_path: 'a.txt',
            new_path: 'a.txt',
            old_line: null,
            new_line: 25,
          },
        },
      ],
    },
  ];
  let drafts = [];
  let nextId = 100;

  const routes = {
    [`GET ${project}/merge_requests/1`]: () => ({
      iid: 1,
      title: 'Second',
      state: 'opened',
      draft: false,
      web_url: 'http://gitlab.test/group/project/-/merge_requests/1',
      author: { name: 'Other Dev', username: 'other' },
      reviewers: [],
      source_branch: 'feature',
      target_branch: 'main',
      has_conflicts: false,
      detailed_merge_status: 'mergeable',
      user_notes_count: 1,
      head_pipeline: null,
      diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: headSha },
    }),
    [`GET ${project}/merge_requests/1/approvals`]: () => ({
      approved_by: [],
      approvals_required: 0,
      approvals_left: 0,
    }),
    [`GET ${project}/merge_requests/1/discussions?per_page=100&page=1`]: () => discussions,
    [`GET ${project}/merge_requests/1/draft_notes`]: () => drafts,
    [`POST ${project}/merge_requests/1/discussions`]: (body) => {
      const id = `d${nextId++}`;
      discussions.push({
        id,
        individual_note: false,
        notes: [
          {
            id: nextId++,
            body: body.body,
            author: { name: 'Grove Test', username: 'grove' },
            created_at: '2026-01-03T10:00:00Z',
            resolvable: !!body.position,
            resolved: false,
            position: body.position ?? null,
          },
        ],
      });
      return { id };
    },
    [`POST ${project}/merge_requests/1/draft_notes`]: (body) => {
      const draft = {
        id: nextId++,
        note: body.note,
        discussion_id: body.in_reply_to_discussion_id ?? null,
        position: body.position ?? null,
      };
      drafts.push(draft);
      return draft;
    },
    [`POST ${project}/merge_requests/1/draft_notes/bulk_publish`]: () => {
      for (const draft of drafts)
        routes[`POST ${project}/merge_requests/1/discussions`]({
          body: draft.note,
          position: draft.position,
        });
      drafts = [];
      return {};
    },
  };

  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    if (req.url === '/__requests') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(requests));
      return;
    }
    requests.push({ method: req.method, url: req.url, body });
    const route = routes[`${req.method} ${req.url}`];
    res.setHeader('Content-Type', 'application/json');
    // Lists Grove asks for in the background (pipelines, merge requests by iids) are simply empty.
    res.end(JSON.stringify(route ? route(body) : []));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
