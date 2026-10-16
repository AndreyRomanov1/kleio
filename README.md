# Kleio

_Kleio (Clio) is the muse of history._

Git for VS Code and VSCodium the way JetBrains IDEs do it: a commit graph you can work from, one diff
viewer for any set of changes, history and blame a click away, interactive rebase and conflicts in proper
windows, GitLab merge requests and review inside the editor.

Built for a day where code is mostly written by agents and colleagues, and your job is to read it: every
change opens in the native diff editor with the language server working, and the file on the right side
stays editable.

[Русская версия](README.ru.md) · The interface is in Russian for now; English is planned.

![Commit log](docs/images/log.png)

## Features

**Log and diffs**

- **Commit graph** for every branch, remote and worktree, virtual scrolling for repositories with tens of
  thousands of commits, filter by text, author or hash, speed search by typing; select
  commits by dragging with the left button held, `Ctrl` adds a range. **Filters** by authors,
  dates and paths, and by changed text: the commits where a piece of code appeared or disappeared
  (`git log -S`, or `-G` with a regular expression).
- **Branch panel**: HEAD, favorites, local and remote branches as a tree, tags, stashes, ahead/behind
  counters; **focus** limits the log to chosen branches.
- **One diff viewer for any set of changes** on the native diff editor: `F7` / `Shift+F7` go through
  changes and on into the next file, `F4` opens the file for editing. When a revision matches the file on
  disk, the right side _is_ that file.
- **History and blame**: history of a file, of a folder or of selected lines with the diff beside it,
  blame annotations linked to the log, the main author above declarations.
- **Compare branches** as lists of commits missing on either side, or as one diff.
- **Branch widget** in the status bar: the current branch with ↑↓, a click for branches and the common
  actions.
- **Several repositories** in one window: the log, the commit view and the status bar follow the
  repository of the file in the editor; switch it by hand in any of them.

**Changing history**

- **Commit view**: changes with checkboxes, **parts of a file by hunks or single lines**, amend, recent messages, rollback
  of files or hunks, stashes (all changes or only the checked files). By default it works as in Rider: checked files and hunks are committed as
  they are on disk, through a temporary index, and what you staged yourself stays as it is. With
  **Stage** checked, the checkboxes show and change the git index, and the commit takes what is staged,
  as `git commit` does.

  ![Commit parts of a file](docs/images/commit.png)

- **Branches**: checkout (smart checkout through a stash; replacing a local branch that diverged after a
  rebase on the server, with a check that nothing is lost), checkout into a new worktree, merge, rebase,
  cherry-pick (one commit or several), revert, reset, rename, upstream, tags. A stopped operation shows a
  bar with Continue / Skip / Abort.
- **Undo via reflog**: the latest states of the branch — before a rebase, a reset, an update — and back to
  any of them with `git reset --keep`.
- **Patches**: save commits as a patch, apply a patch as commits or as changes.
- **Update Project** fetches every remote and brings the current branch up to its upstream — merge or
  rebase, asked the first time; another branch without own commits is updated without checking it out.
  Uncommitted changes are stashed for the time of an operation; if they come back with conflicts, Kleio
  says so and opens the conflicts.
- **Push dialog**: outgoing commits of every branch with their diffs; a diverged branch goes only with
  force-with-lease against what the dialog showed, never into protected branches.

  ![Push](docs/images/push.png)

- **Interactive rebase**: pick, reword, edit, squash, fixup, drop; select several commits and squash them
  into one; reorder by dragging or `Alt+↑/↓`; messages are edited right in the dialog. Git never opens an
  editor.
- **Stacked branches**: a rebase moves the branches stacked on the rebased commits along with them
  (`--update-refs`), the dialog shows which ones, and push checks the rewritten lower branches together
  with the current one.

  ![Interactive rebase](docs/images/rebase.png)

- **Conflicts**: a list of conflicted files with the real names of both sides, take one side, or merge in
  the built-in three-way merge editor; "Complete merge" marks the file resolved and offers to go on.

  ![Merge](docs/images/merge.png)

**GitLab and GitHub**

- Without a token: links to commits, branches and files, merge request numbers in the log, creating a
  merge request on push, links to your tracker from commit messages and branch names.
- With the API: merge request status and pipelines in the log, merged merge requests down the whole
  history, a merge request card with jobs and child pipelines, job logs in the editor, retry and manual
  jobs, approve, merge, rebase on the server.
- GitHub: pull request states and the checks of commits in the log, merged pull requests down the whole
  history, a pull request card with checks and their logs, reviewers, threads and comments; approve,
  merge (merge commit, squash or rebase, auto-merge while checks run), update the branch on the server,
  the changes of a pull request in the diff viewer. Comments in the code stay on GitHub for now. Access
  comes from the editor's GitHub account or a personal access token.
- A repository with several remotes, e.g. a GitLab mirror and GitHub, shows the hosting of the remote you
  choose in the log.
- **Review in the diff viewer** (GitLab): threads in the code, comments published at once or as drafts, resolve,
  next/previous comment. Every comment is written to a local journal before it is sent, so nothing typed
  is lost. When a merge request has changed since your last review, Kleio offers to show only what
  changed — after a rebase too: the old changes are moved onto the new base first. The comments of the
  version you reviewed stand on its side, next to how they were dealt with.

## Install

Download `kleio-<version>.vsix` from [Releases](https://github.com/AndreyRomanov1/kleio/releases) and
install it: `codium --install-extension kleio-<version>.vsix` (or `code …`), or Extensions → `…` →
Install from VSIX. Kleio works in trusted local folders only: git runs the hooks and config of a
repository.

GitLab access is taken from the [GitLab Workflow](https://open-vsx.org/extension/GitLab/gitlab-workflow)
extension when it is signed in, or from a personal access token (command «Подключить GitLab…», scope
`api`), kept in the editor's secret storage.

## Settings

| Setting                                | Default                               | What it does                                                                                 |
| -------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `kleio.autolinks`                      | `[]`                                  | Rules turning text into links: `{"pattern": "\\bPROJ-\\d+\\b", "url": "https://tracker/$0"}` |
| `kleio.hosting.instances`              | `{}`                                  | Hosting type of your own servers, e.g. `{"git.example.com": "gitlab"}`                       |
| `kleio.update.method`                  | `ask`                                 | How Update Project brings a branch with own commits up to date: `merge` or `rebase`          |
| `kleio.commit.stagingArea`             | `false`                               | The commit view works with the git index (the **Stage** checkbox)                            |
| `kleio.hosting.backgroundRefresh`      | `true`                                | Ask the server for merge request refs every few minutes; turn off if SSH asks for a password |
| `kleio.push.protectedBranches`         | `["master", "main"]`                  | Branches never force-pushed; `*` works, e.g. `release/*`                                     |
| `kleio.worktree.path`                  | `${repoParent}/${repoName}-${branch}` | Folder of a new worktree                                                                     |
| `kleio.worktree.copyFiles`             | `[]`                                  | Untracked files copied into a new worktree, e.g. local settings with secrets                 |
| `kleio.codeLens.authors`               | `true`                                | The main author and the number of others above classes and methods                           |
| `kleio.history.showDiffOnSelect`       | `true`                                | Show the diff of the selected commit in a history tab                                        |
| `kleio.language`                       | `auto`                                | Language of Kleio: the editor's, or `en`, `ru` without a language pack                       |
| `kleio.statusBar.branch`               | `true`                                | The current branch with ↑↓ in the status bar                                                 |
| `kleio.blame.ignoreWhitespaceAndMoves` | `false`                               | Blame ignores whitespace changes and moved lines                                             |
| `kleio.rebase.updateRefs`              | `true`                                | A rebase moves the stacked branches along (`--update-refs`, git 2.38+)                       |
| `kleio.review.ctrlEnter`               | `publish`                             | `Ctrl+Enter` in a review comment: `publish` it or save a `draft`                             |
| `kleio.navigation.history`             | `false`                               | Go Back / Go Forward through files and review diffs in one history                           |

## Key bindings

`F7` / `Shift+F7` in Kleio diffs go through changes and continue into the next file. Keymap extensions (e.g.
IntelliJ IDEA Keybindings) bind the same keys in diff editors, and between two extensions VS Code picks one
unpredictably. User key bindings always win, so add these to `keybindings.json` if F7 stays within one file:

```json
[
  {
    "key": "f7",
    "command": "kleio.diff.nextChange",
    "when": "kleio.inChangeSet && textCompareEditorVisible"
  },
  {
    "key": "shift+f7",
    "command": "kleio.diff.previousChange",
    "when": "kleio.inChangeSet && textCompareEditorVisible"
  },
  { "key": "ctrl+alt+left", "command": "kleio.navigate.back", "when": "config.kleio.navigation.history" },
  { "key": "ctrl+alt+right", "command": "kleio.navigate.forward", "when": "config.kleio.navigation.history" },
  { "key": "ctrl+enter", "command": "workbench.action.submitComment", "when": "commentEditorFocused" }
]
```

With `kleio.navigation.history` on, **Go Back / Go Forward** (`Ctrl+Alt+-` / `Ctrl+Shift+-`, `Alt+←/→` on
Windows) go through one history of files and of the files of review diffs: the editor's own history loses a diff once Kleio shows the next file in its
place. The last two lines above put them on `Ctrl+Alt+←/→`, as the IntelliJ keymap has them, and make
`Ctrl+Enter` send a review comment there (that keymap takes it for Go to Declaration). `Ctrl+Enter` publishes
the comment, or saves a draft with `kleio.review.ctrlEnter` set to `draft`; `Enter` starts a new line.

In the merge editor `Ctrl+Enter` completes the merge and marks the file resolved.

## Development

Requires Node.js 20+ and git.

```sh
npm install
npm run build              # extension and webviews into dist/
npm run watch              # rebuild on change; F5 in VS Code starts an Extension Development Host
npm test                   # unit tests, against real git repositories in a temp folder
npm run test:integration   # tests inside a real editor; KLEIO_CODE=/path/to/codium
npm run preview -- <repo>  # the UI in a browser against a real repository; nothing is committed or pushed
                           # KLEIO_PREVIEW_LANG=ru for another language
npm run package            # kleio.vsix
```

On Linux the integration tests run the editor under `xvfb-run` in a throwaway profile.

```
src/shared/     types and logic shared by the extension and the webviews
src/extension/  extension host: git, change sets and the diff navigator, actions, hosting, review
src/webview/    log, commit, push, rebase and conflicts UIs (Svelte 5)
scripts/        build, integration test runner, browser preview, fake GitLab for tests
test/           unit tests (vitest) and integration tests
```

## Languages

Kleio speaks English and Russian. It follows the display language of the editor; `kleio.language` picks
another one without installing a language pack (commands and settings still follow the editor).

To add a language, translate two files and name them with the language code, e.g. for German:

- `l10n/bundle.l10n.de.json` — messages of the interface: copy `bundle.l10n.ru.json` and translate the
  values; the keys are the English originals, `{0}` are placeholders;
- `package.nls.de.json` — commands and settings: copy `package.nls.json` and translate the values.

`npm run check:l10n` (also run by CI) lists messages missing from a translation or no longer used.

## License

[MIT](LICENSE)
