# Grove

Git log, diff and history for VS Code / VSCodium in the spirit of JetBrains IDEs: the whole history of the
code is one click away.

The UI is in Russian for now.

## What works

- **Log with a commit graph** for every branch, remote and worktree, with virtual scrolling (tested on a
  10 000-commit repository). Text filter by subject, author or hash.
- **Branch panel**: HEAD, favorites, local and remote branches as a tree, worktrees, stashes, tags.
  Ahead/behind counters, branches checked out in other worktrees are marked.
- **Focus**: limit the log to a set of branches straight from the branch panel, or with "Только текущая"
  (current branch, its upstream and master/main).
- **Commit details**: message, author, parents, changed files as a tree or a list.
  Select several commits to see their combined changes.
- **One diff viewer for any set of changes** built on the native diff editor, so highlighting, language
  servers and key bindings work as usual. `F7` / `Shift+F7` go through changes and continue into the next
  file; arrows in the editor title switch files; `F4` opens the current version of the file for editing.
  When a revision matches the file on disk, the right side _is_ the file on disk and can be edited in place.
- **Branch actions**: checkout (a remote branch whose local copy diverged — e.g. after a rebase on the
  server — can replace the local branch, with a check whether any local commit would be lost), new branch,
  new tag, delete, fetch, compare with the current branch. **Commit actions**: checkout, new branch/tag,
  revert, compare with the working tree.
- **Merge, rebase and updates**: merge a branch into the current one, rebase the current one onto a branch,
  cherry-pick, reset. Uncommitted changes are stashed for the time of the operation and brought back. A stop
  for conflicts shows a bar in the log with Continue / Skip / Abort. **Update Project** fetches every remote
  and brings the current branch up to its upstream (fast-forward, or rebase/merge per `grove.update.method`);
  any other branch without own commits can be updated without checking it out.
- **Interactive rebase** as in Rider: a table of the commits from the chosen one up to HEAD with pick, reword,
  edit, squash, fixup and drop, reordered by dragging or `Alt+↑/↓`; messages are edited right in the dialog,
  a squash adds its message to the commit it goes into. The plan is turned into a todo list with the new
  messages prepared up front, so git never opens an editor. From the log: reword, fixup into the previous
  commit, drop, and squash or drop of several selected commits. Merges in the range are not rebuilt.
- **Conflicts** as in Rider: when a merge, rebase or cherry-pick stops, a window lists the conflicted files
  with the real names of both sides ("main (rebase base)" / "PROJ-1234: a1b2c3d message"), takes one side
  for the selected files, or opens the built-in three-way merge editor (ours left, theirs right, result
  below). A file saved without conflict markers is marked resolved; when none are left, the operation can
  go on. A double click on a conflicted file in the commit view opens the merge too.
- **Push dialog** as in Rider: outgoing commits of the current branch and of other branches ahead of their
  upstream, their files and diffs, the remote branch name for a new branch. A diverged branch is pushed only
  with force-with-lease against the remote state seen in the dialog, and never into
  `grove.push.protectedBranches` (`master`, `main` by default). Links the server prints (e.g. "create merge
  request") are offered to open.
- The log lives in the bottom panel (movable anywhere), in an editor tab, or in a separate window.

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
