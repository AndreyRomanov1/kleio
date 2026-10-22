// A fake GitLab for the integration tests: one merge request (!1) of the test repository, its discussions and
// drafts. It keeps what Kleio sends, and GET /__requests returns the recorded requests for assertions.
import { createServer } from 'node:http';

export async function startFakeGitLab({ baseSha, headSha, earlierSha }) {
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
    {
      // A comment of the earlier version, before line 5 was changed: GitLab keeps it on that version.
      id: 'earlier',
      individual_note: false,
      notes: [
        {
          id: 2,
          body: 'Поменяй пятую строку',
          author: { name: 'Kleio Test', username: 'kleio' },
          created_at: '2026-01-01T12:00:00Z',
          resolvable: true,
          resolved: false,
          position: {
            base_sha: baseSha,
            start_sha: baseSha,
            head_sha: earlierSha,
            old_path: 'a.txt',
            new_path: 'a.txt',
            old_line: null,
            new_line: 5,
          },
        },
      ],
    },
  ];
  let drafts = [];
  // POST /__head makes a new version of the merge request, as a push does.
  let head = headSha;
  let nextId = 100;

  const routes = {
    [`GET /api/v4/user`]: () => ({ name: 'Kleio Test', username: 'kleio' }),
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
      diff_refs: { base_sha: baseSha, start_sha: baseSha, head_sha: head },
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
            author: { name: 'Kleio Test', username: 'kleio' },
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
    if (req.url === '/__head') {
      head = body.headSha;
      res.end('{}');
      return;
    }
    if (req.url === '/__requests') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(requests));
      return;
    }
    requests.push({ method: req.method, url: req.url, body });
    const note = new RegExp(`^${project}/merge_requests/1/discussions/([^/]+)/notes/(\\d+)$`).exec(req.url);
    if (note && (req.method === 'PUT' || req.method === 'DELETE')) {
      const discussion = discussions.find((d) => d.id === note[1]);
      const index = discussion?.notes.findIndex((n) => n.id === Number(note[2])) ?? -1;
      if (index >= 0 && req.method === 'PUT') discussion.notes[index].body = body.body;
      if (index >= 0 && req.method === 'DELETE') discussion.notes.splice(index, 1);
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
      return;
    }
    const route = routes[`${req.method} ${req.url}`];
    res.setHeader('Content-Type', 'application/json');
    // Lists Kleio asks for in the background (pipelines, merge requests by iids) are simply empty.
    res.end(JSON.stringify(route ? route(body) : []));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
