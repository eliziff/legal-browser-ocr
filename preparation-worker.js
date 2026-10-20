import { LineRecognizer, recognizerProfile } from './recognizer.js';

let recognizer, collectTiming;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      recognizer = new LineRecognizer({}, {}, recognizerProfile('indra'), {});
      collectTiming = data.timing;
      self.postMessage({ type: 'ready' });
      return;
    }
    const timing = collectTiming ? { crop_pack_seconds: 0 } : undefined;
    const prepared = recognizer.preparePage(data.bitmap, data.lines, data.scale, timing);
    self.postMessage({ id: data.id, prepared, timing }, prepared.map(line => line.gray.buffer));
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
  finally { data.bitmap?.close(); }
};
