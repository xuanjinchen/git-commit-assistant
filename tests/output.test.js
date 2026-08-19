import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test from 'node:test';

import { writeOutput } from '../src/output.js';

function failingWritable(code) {
  return new Writable({
    write(_chunk, _encoding, callback) {
      const error = new Error(`stream failed with ${code}`);
      error.code = code;
      callback(error);
    },
  });
}

test('writes complete output through a normal stream', async () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  assert.equal(await writeOutput(stream, 'complete\n'), 'written');
  assert.equal(output, 'complete\n');
});

test('treats EPIPE as a quiet closed consumer without an unhandled error', async () => {
  assert.equal(await writeOutput(failingWritable('EPIPE'), 'ignored\n'), 'closed');
});

test('rejects output failures other than EPIPE', async () => {
  await assert.rejects(() => writeOutput(failingWritable('EIO'), 'failed\n'), { code: 'EIO' });
});
