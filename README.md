# Grove

Git log, diff and history for VS Code / VSCodium in the spirit of JetBrains IDEs: the whole history of the
code is one click away.

The UI is in Russian for now.

## What works

**Log and diffs**

- **Log with a commit graph** for every branch, remote and worktree, with virtual scrolling (tested on a
  10 000-commit repository). Text filter by subject, author or hash; speed search by typing.
- **Branch panel**: HEAD, favorites, local and remote branches as a tree, tags, stashes. Ahead/behind
  counters; a branch checked out in another worktree is marked and opens there.
- **Focus**: limit the log to a set of branches straight from the branch panel, or with "Только текущая"
  (current branch, its upstream and master/main).
- **Commit details**: message with links (tickets by `grove.autolinks`), author, parents, changed files as a
  tree or a list. Select several commits to see their combined changes.
- **One diff viewer for any set of changes** built on the native diff editor, so highlighting, language
  servers and key bindings work as usual. `F7` / `Shift+F7` go through changes and continue into the next
  file; arrows in the editor title switch files; `F4` opens the current version of the file for editing.
  When a revision matches the file on disk, the right side _is_ the file on disk and can be edited in place.
  Renames are shown as such.
- **History and blame**: history of a file or of selected lines in a tab, with the diff of the selected
  commit beside it; blame annotations with links into the log; the main author above declarations.
- The log lives in the bottom panel (movable anywhere), in an editor tab, or in a separate window.

**Changing history**

- **Commit view** as in Rider: changes with checkboxes, **parts of a file by hunks**, amend, recent messages,
  rollback, stashes. Parts are committed through a temporary index, so the staged changes of the user stay
  as they are.
- **Branch actions**: checkout (smart checkout through a stash when local changes are in the way; a remote
  branch whose local copy diverged after a rebase on the server can replace it, with a check whether any
  local commit would be lost), new branch or tag, checkout into a new worktree next to the main folder (`grove.worktree.path`,
  with files from `grove.worktree.copyFiles` copied over), delete (with its worktree), compare with the current one.
- **Merge, rebase and updates**: merge a branch into the current one, rebase the current one onto a branch,
  check out a branch and rebase it onto the current one, cherry-pick, revert, reset. Uncommitted changes are
  stashed for the time of the operation and brought back. A stop shows a bar in the log with Continue /
  Skip / Abort. **Update Project** fetches every remote and brings the current branch up to its upstream
  (fast-forward, or rebase/merge per `grove.update.method`); any other branch without own commits can be
  updated without checking it out.
- **Interactive rebase** as in Rider: a table of the commits from the chosen one up to HEAD with pick, reword,
  edit, squash, fixup and drop, reordered by dragging or `Alt+↑/↓`; messages are edited right in the dialog,
  a squash adds its message to the commit it goes into. The plan is turned into a todo list with the new
  messages prepared up front, so git never opens an editor. From the log: reword, fixup into the previous
  commit, drop, and squash or drop of several selected commits. Merges in the range are not rebuilt.
- **Conflicts** as in Rider: when a merge, rebase or cherry-pick stops, a window lists the conflicted files
  with the real names of both sides, takes one side for the selected files, or opens the built-in three-way
  merge editor; "Complete merge" there (✓ in the title, `Ctrl+Enter`) marks the file resolved. A file whose
  markers were removed by hand in a plain editor is marked resolved on save. When none are left, the
  operation can go on.
- **Push dialog** as in Rider: outgoing commits of the current branch and of other branches ahead of their
  upstream, their files and diffs, the remote branch name for a new branch. A diverged branch is pushed only
  with force-with-lease against the remote state seen in the dialog, and never into
  `grove.push.protectedBranches` (`master`, `main` by default). Links the server prints (e.g. "create merge
  request") are offered to open.

**GitLab** (GitHub links only, for now)

- Without an API token: links to commits, branches and files, merge request numbers in the log (from
  `refs/merge-requests`), creating a merge request on push.
- With the API (the session of the GitLab Workflow extension or a personal token): merge request status and
  pipelines in the log; a merge request card with jobs (child pipelines too), job logs in the editor, retry,
  manual jobs, approve, merge (now or when the pipeline succeeds), rebase on the server.
- **Review in the diff viewer**: threads of the merge request in the code, comments published at once or
  as drafts, resolve, next/previous comment; every comment is written to a local journal first, so nothing
  typed is lost.

## Key bindings

`F7` / `Shift+F7` in Grove diffs go through changes and continue into the next file. Keymap extensions (e.g.
IntelliJ IDEA Keybindings) bind the same keys in diff editors, and between two extensions VS Code picks one
unpredictably. User key bindings always win, so add these to `keybindings.json` if F7 stays within one file:

```json
[
  {
    "key": "f7",
    "command": "grove.diff.nextChange",
    "when": "grove.inChangeSet && textCompareEditorVisible"
  },
  {
    "key": "shift+f7",
    "command": "grove.diff.previousChange",
    "when": "grove.inChangeSet && textCompareEditorVisible"
  }
]
```

## Development

```sh
npm install
npm run build              # extension and webview into dist/
npm run watch              # rebuild on change; F5 in VS Code starts an Extension Development Host
npm test                   # unit tests
npm run test:integration   # tests inside a real editor; set GROVE_CODE to the editor binary
npm run preview -- <repo>  # the log UI in a browser against a real repository, http://localhost:5173
npm run package            # grove.vsix
```

On Linux the integration tests start the editor under `xvfb-run` in a throwaway profile.

## Layout

```
src/shared/     types and logic shared by the extension and the webview (model, protocol, graph layout)
src/extension/  extension host: git, change sets and the diff navigator, actions, log webview hosts
src/webview/    log UI (Svelte 5)
scripts/        build, integration test runner, browser preview
test/           unit tests (vitest) and integration tests
```

## License

MIT
