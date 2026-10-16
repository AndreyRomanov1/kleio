# Changelog

## 0.22.0

- Outdated discussions are in the code of the version of the merge request they were made on: the card opens
  them there, and next comment goes on to them after the comments of the current version.
- Next and previous comment go through the diff of the active tab, however it was opened; in the changes
  since the last review they stay in that diff.
- 0.21.1 is reverted: the comments made before the current version are no longer moved to the left by guess.

## 0.21.0

- The changes since the last review show the comments of the earlier version on its side, next to how they
  were dealt with; they can be answered and resolved there.
- The changes since the last review stay available after a reload of the window.

## 0.20.0

- Select commits in the log by dragging with the left button held: with `Ctrl` the range is added to the
  selection, with `Shift` it starts from the anchor; at the edge the list scrolls along.
- A growing selection no longer pulls the log back to its first selected commit.

## 0.19.2

- Diffs of revisions survive a reload of the window for real: revisions are a read-only file system now, as
  the `git:` scheme of the built-in Git extension; the editor restores only tabs of file systems.
- `kleio.navigation.history` is off by default: it takes over a command of the editor.

## 0.19.1

- After a reload of the window the diff tab stays, and the review comes back with its comments in the code;
  F7 and the file list work on in the restored diff. A review ends with "End review" only.

## 0.19.0

- Go Back / Go Forward through one history of files and of the files of review diffs (`kleio.navigation.history`):
  the editor's own history lost a diff once Kleio showed the next file in its place.
- The file list of a diff is numbered and opens at the current file.
- `Ctrl+Enter` in a review comment publishes it, or saves a draft (`kleio.review.ctrlEnter`).
- Opening the next file of a diff no longer fails with editor previews on.
- A review comment is sent once: a second `Ctrl+Enter` or click while it was on its way sent it again.
- Edit your review comments and drafts, delete your comments.

## 0.18.1

- A merged merge request is marked in the log on its merge commit only, not also on the head of its
  branch right below it.

## 0.18.0

- Log filters by authors, dates and paths, and by changed text (`git log -S`, `-G` with `.*`); "only
  commits by this author" and "only commits changing this file" in the menus.
- Commit, stage, unstage and roll back single lines of a hunk.
- Stacked branches: rebase moves the branches stacked on the rebased commits along (`--update-refs`, also
  in interactive rebase), except branches checked out in worktrees; push checks the rewritten lower branches
  of the stack. `kleio.rebase.updateRefs`.
- GitHub pull request card: checks with logs and retry, reviewers, threads and comments, approve, merge
  with the methods the repository allows or auto-merge, update branch, the changes in the diff viewer.
- The hosting of another remote: a choice in the log when the repository has several remotes.

## 0.17.0

- Several repositories in one window: one current repository for the log, the commit view, the status bar
  and the commands. It follows the file in the editor and can be switched in the commit view, the log or
  the branch widget.

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
