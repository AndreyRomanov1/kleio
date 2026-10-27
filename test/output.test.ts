import { describe, expect, it, vi } from 'vitest';
import { hideCredentials } from '../src/extension/output';

vi.mock('vscode', () => ({}));

describe('hideCredentials', () => {
  it('hides user names and tokens in URLs and leaves the rest', () => {
    expect(hideCredentials('git remote add m https://oauth2:glpat-x1@git.example.com/g/p.git')).toBe(
      'git remote add m https://***@git.example.com/g/p.git',
    );
    expect(hideCredentials('fatal: unable to access http://u@h/p and ssh://git@h:22/p')).toBe(
      'fatal: unable to access http://***@h/p and ssh://***@h:22/p',
    );
    expect(hideCredentials('git push origin refs/heads/a:refs/heads/a')).toBe(
      'git push origin refs/heads/a:refs/heads/a',
    );
  });
});
