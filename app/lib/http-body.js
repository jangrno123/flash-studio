'use strict';
// Reject large requests with HTTP 413 while leaving the response socket writable.
function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true; chunks.length = 0;
        reject(Object.assign(new Error('요청이 너무 큽니다'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('요청 전송이 중단됐습니다'), { status: 400 })));
  });
}
module.exports = { readBody };
