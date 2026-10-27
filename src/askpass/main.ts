import * as http from 'node:http';

/**
 * The program git and ssh run for a user name, a password or a passphrase (GIT_ASKPASS, SSH_ASKPASS): it asks
 * Kleio over its socket, which shows the question in the editor, and prints the answer. A failure means
 * "no answer", and git or ssh stop with their own error.
 */
const prompt = process.argv[2] ?? '';
const {
  KLEIO_ASKPASS_HANDLE: handle,
  KLEIO_ASKPASS_TOKEN: token,
  KLEIO_ASKPASS_SILENT: silent,
} = process.env;
if (!handle || silent === '1') process.exit(1);

const request = http.request({ socketPath: handle, path: '/', method: 'POST' }, (response) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => {
    const { answer } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { answer?: string };
    if (response.statusCode !== 200 || typeof answer !== 'string') process.exit(1);
    process.stdout.write(answer + '\n', () => process.exit(0));
  });
});
request.on('error', () => process.exit(1));
request.end(JSON.stringify({ token, prompt }));
