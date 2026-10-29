# Changelog

## 0.29.0

- A click on a branch in the branch panel shows what the branch changes in the details pane — its commits and
  the tree of its files, as with Changes of the branch — and the log goes to its tip. A branch without changes
  of its own, e.g. the default branch, shows its last commit, as before.
- Opening a file from the details no longer expands all folders again: a log tab hidden behind the diff
  measured zero width, the details moved under the log and back and were created anew. Collapsed folders
  are now kept by the log, and a hidden tab keeps its layout.
- The commits of a branch are read in one git run.

## 0.28.0

- **Changes of the branch** in the context menu of a branch (and of a commit with one) shows the branch in the
  details pane: its commits, selected in the log, and the tree of its files since it left the target of its
  merge request or the default branch. The diff of a file opens from there with the arrows through all
  files; **Changes of the branch in the diff** opens the diff right away, as before.
- The file tree of the details has **Expand all** and **Collapse all**; `Alt+click` (and `Alt+→/←`) opens or
  closes a folder with all folders inside; the arrow keys, Home and End work as in the trees of VS Code.
- A collapsed folder shows how many files it has and colored dots of the kinds of changes inside, so a
  collapsed tree tells which folders a merge request touched and how much.
- Folders collapsed in one commit stay collapsed when another commit is selected.

## 0.27.0

Stability before a wider audience: a review of the whole extension against what git does.

- Commit messages keep lines starting with `#` (e.g. `#42`): commits, amend and reword now use the cleanup
  git uses for a message from a file, not the one of its editor.
- A merge, cherry-pick or revert can be committed from the commit view: it shows the operation with
  Continue / Abort, fills in the message git prepared (`MERGE_MSG`, `SQUASH_MSG`, or `commit.template`)
  and commits the files whole, as git requires. Before, the commit failed with "cannot do a partial commit
  during a merge".
- Rolling back a new file that is in the index moves it to the trash instead of deleting it for good.
- Undo via reflog lists the states of the current branch: checkouts of other branches are no longer offered
  as states to return the branch to.
- Revert stops for conflicts as an operation, with the conflicts window, instead of an error.
- Smart checkout never brings back an older stash when git had nothing to stash.
- Hunks and lines are staged, committed and rolled back whatever `diff.noprefix` or `color.diff` the user
  has, and at the end of a file without a line break.
- Diffs show the contents of Git LFS files, not their pointers: files are read through their filters.
- Passwords of HTTPS remotes, passphrases of SSH keys and new host keys are asked in the editor, as the
  built-in Git does; a credential helper or ssh-agent saves asking again.
- Fetch, push and Update Project have a cancel button instead of a two-minute timeout that cut long pushes.
- Update Project follows `pull.rebase`, `branch.<name>.rebase` and `pull.ff=only` of the git config, unless
  `kleio.update.method` says otherwise.
- **Kleio: Show Git Command Log**: every failed git command with what git said, all of them at the Debug
  level; user names and tokens in URLs are hidden.
- Kleio checks git at the start and says when it is missing or older than 2.31; reword works on git older
  than 2.36.
- The log leaves out git notes and refs prefetched by `git maintenance`; a folder removed from the workspace
  leaves the list of repositories; a branch that tracks a local branch is updated and pushed correctly.
- README: requirements, getting started, access to remotes, limitations, troubleshooting.

## 0.26.0

- Remotes are managed from the branch panel, as Rider's Manage Remotes: "+" at the Remote section adds one
  (and fetches it), the context menu of a remote fetches it, changes its URL, renames it, makes the log
  show its hosting or removes it after a confirmation that says what goes. "Kleio: Manage Remotes…" lists
  them in the command palette. Renaming and removing the hosting remote carry Kleio's choice along.

## 0.25.0

- The push dialog sends any branch to any remote under any name, as Rider's does: the remote and the branch
  name on the server can be changed for every branch, not only a new one, and the commits to push, the
  commits the server has and the need of force are worked out again for the new destination. A push
  elsewhere than the upstream leaves the upstream as it is, as `git push <remote> <branch>` does.

## 0.24.0

- A push no longer moves the review under you: while a diff of the merge request is open, the review stays
  on its version, as a GitLab page does until it is reloaded. Above the diff a line offers the newer version —
  "What changed v2 → v3", "Go to v3", "Finish v2", "Send drafts" — and the status bar keeps it at hand.
  Without an open diff, or when the merge request is opened from the card or the log, the review is on the
  latest version.
- While on the earlier version, comments GitLab moved onto the newer one are shown at their lines of this
  version when those lines did not change; the others are counted above the diff. Nothing changes in GitLab.
- The tab of a review diff names its version: `MR !12 v2`, `!12 v1 → v2`.

## 0.23.0

- No starting or ending a review: the merge request of the current branch has its comments in the code by
  itself (its upstream is the head of the merge request, so local commits do not break it), and new
  comments and versions come in when the window gets focus again. "End review" is gone from the menus.
- The card shows the versions of a merge request, one per push, with those you looked at marked; any two
  compare, a single one opens as GitLab showed it, and "New since vN" shows what changed since the version
  you looked at last. A version counts as looked at once its diff is shown, not when comments load.
- "Changes of the branch" in the branch menu: from where it left the target of its merge request (the lower
  branch of a stack) or the default branch; "Show changes" of a commit or of several selected ones.

## 0.22.1

- After a push the open review moves on to the new version of the merge request, as GitLab reviews the
  latest one: on refresh, after a comment is sent or when the card opens a comment. The file shown stays
  shown, and what changed since the version reviewed so far is offered. Comments GitLab moved onto the new
  version are in the code again, and the card opens them there.

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
