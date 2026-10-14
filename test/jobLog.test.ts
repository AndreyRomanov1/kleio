import { describe, expect, it } from 'vitest';

import { cleanLog } from '../src/extension/hosting/jobLogText';

describe('cleanLog', () => {
  it('removes colours and collapsible section markers of GitLab job logs', () => {
    const raw =
      'section_start:1700000000:build_script\r\x1b[0K\x1b[32;1m$ make test\x1b[0;m\nok\nsection_end:1700000001:build_script\r\x1b[0K\x1b[31;1mERROR\x1b[0;m\n';
    expect(cleanLog(raw)).toBe('$ make test\nok\nERROR\n');
  });
});
