# Changelog

## 0.16.1

- The package lacked the translations: command and view titles showed as `%…%`, and Kleio stayed in English
  with `kleio.language` set. CI now checks that the package has them.

## 0.16.0

- Review: only the changes since your last review, also after a rebase (interdiff through `git merge-tree`).
- GitHub API: pull request states and checks of commits in the log, merged pull requests down the whole
  history; access from the editor's GitHub account or a token.
- Undo via reflog: the latest states of HEAD, returned with `git reset --keep`.
- Branch widget in the status bar with ↑↓ and the common actions.
- Rename a branch, set its upstream; push and delete tags; cherry-pick several commits at once.
- Compare branches as lists of commits missing on either side.
- Folder history; save commits as a patch, apply a patch.
- Stash only the checked files.
- Review comments on several lines.
- `kleio.blame.ignoreWhitespaceAndMoves`: blame ignores reformatting and moved lines.

## 0.15.0

- English interface; Russian is a translation. `kleio.language` picks the language without a language
  pack. A new language is two translated files; `npm run check:l10n` checks them.
- Dates follow the language of the interface.

## 0.14.0

- Uncommitted changes that come back from the autostash of a merge or rebase with conflicts are reported
  and opened in the conflicts window; it was reported as done.
- **Stage** in the commit view: the checkboxes show and change the git index, the commit takes what is
  staged (`kleio.commit.stagingArea`).
- Update Project asks once whether to merge or rebase a diverged branch (`kleio.update.method` is `ask`).
- Reword in interactive rebase runs the `commit-msg` hook.
- `git.path` is respected; Kleio declares that it does not run in untrusted or virtual workspaces; it
  activates in a subfolder of a repository and finds repositories one level down.
- `kleio.hosting.backgroundRefresh` turns off the periodic `git ls-remote`.
- The log of a huge repository is loaded 10 000 commits at a time as it is scrolled.
- Releases on GitHub with the `.vsix` attached.

## 0.13.0

- The project is named Kleio (it was developed as Grove): commands and settings are `kleio.*` now.

## 0.12.0

- Merged merge requests down the whole history: loaded page by page from the GitLab API as the log is
  scrolled down (the server's merge request refs are gone some time after the merge).

## 0.11.0

- Checkout into a new worktree next to the main folder, with listed untracked files copied over.

## 0.10.0

- Commit parts of a file by hunks; rollback of hunks.
- Conflicts are resolved through "Complete merge" of the merge editor.
- Interactive rebase: several commits squashed at once; pick restores the original message.

## 0.9.0

- Conflicts window and the built-in three-way merge editor.

## 0.8.0

- Interactive rebase dialog; reword, fixup, drop and squash from the log.

## 0.7.0

- Merge, rebase, cherry-pick and reset from the log; Update Project; push dialog with force-with-lease;
  smart checkout.

## 0.6.0

- Approve, merge and rebase merge requests, run manual jobs from the merge request card.

## 0.5.0

- Review of GitLab merge requests in the diff viewer: threads, drafts, resolve, a local journal of comments.

## 0.4.0

- GitLab API: merge request status, pipelines, merge request card, job logs.

## 0.3.0

- GitLab and GitHub without a token: links, merge request numbers, creating merge requests on push,
  autolinks.

## 0.2.0

- Commit view: changes with checkboxes, amend, rollback, stashes.

## 0.1.0

- File and fragment history, blame annotations, the main author above declarations.

## 0.0.1

- Commit log with a graph, branch panel, focus, one diff viewer for any set of changes.
