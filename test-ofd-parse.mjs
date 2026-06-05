import { parseOfdDocument } from 'ofd-tools';
import { readFileSync } from 'fs';

const buffer = readFileSync('public/test.ofd');
console.log('File size:', buffer.length, 'bytes');

const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

try {
  const result = await new Promise((resolve, reject) => {
    parseOfdDocument({
      ofd: arrayBuffer,
      success(data) {
        console.log('Parse SUCCESS!');
        const d = data[0];
        console.log('Doc type:', d?.document?.type);
        console.log('Page count:', d?.pages?.length);
        if (d?.pages) {
          for (const page of d.pages) {
            const keys = Object.keys(page);
            console.log('  Page:', JSON.stringify(keys));
          }
        }
        resolve(data);
      },
      fail(err) {
        console.error('Parse FAILED:', err);
        reject(err);
      }
    });
  });
  console.log('Got result with', result.length, 'documents');
} catch (e) {
  console.error('Error:', e.message || e);
}
