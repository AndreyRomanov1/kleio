# Changelog

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
