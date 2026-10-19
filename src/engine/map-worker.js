// Worker thread: renders region files to PNG so the app stays responsive.
const { parentPort } = require('worker_threads');
const { renderRegion, encodePng } = require('./map-render');

parentPort.on('message', ({ jobId, file }) => {
  try {
    const { rgba, chunks } = renderRegion(file);
    const png = encodePng(rgba, 512, 512);
    parentPort.postMessage({ jobId, png, chunks: Buffer.from(chunks) });
  } catch (err) {
    parentPort.postMessage({ jobId, error: err.message });
  }
});
