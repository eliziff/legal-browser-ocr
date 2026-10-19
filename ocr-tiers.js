export const ocrTiers = Object.freeze({
  quality: { label: 'Quality', model: 'standard', detectorSide: 1024 },
  balanced: { label: 'Balanced', model: 'standard', detectorSide: 896 },
  fast: { label: 'Fast', model: 'standard', detectorSide: 832 },
  turbo: { label: 'Turbo', model: 'standard', detectorSide: 768 },
  extreme: { label: 'Extreme · more errors', model: 'light', detectorSide: 768 },
});

export const ocrModels = Object.freeze({
  standard: { cpu: 'assets/indra-followup/student8ids/model.onnx', gpu: 'assets/indra-followup/gpu8h/model.onnx', codec: 'assets/indra-followup/student8ids/codec.json' },
  light: { cpu: 'assets/indra-followup/student10c64ids/model.onnx', gpu: 'assets/indra-followup/gpu64h/model.onnx', codec: 'assets/indra-followup/student10c64ids/codec.json' },
});

export function ocrTier(id = 'balanced') {
  if (!Object.hasOwn(ocrTiers, id)) throw new Error(`Unknown OCR tier: ${id}`);
  return ocrTiers[id];
}
