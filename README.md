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
