export const DEFAULT_TIER = 'balanced';
export const OCR_DPI = 144;
export const ocrTiers = Object.freeze({
  quality: { label: 'Quality', model: 'standard', detectorSide: 1024 },
  balanced: { label: 'Balanced', model: 'standard', detectorSide: 896 },
  fast: { label: 'Fast', model: 'standard', detectorSide: 832 },
  turbo: { label: 'Turbo', model: 'standard', detectorSide: 768 },
  extreme: { label: 'Extreme · more errors', model: 'light', detectorSide: 768 },
});

export const nativeModels = Object.freeze({
  standard: { cpu: 'assets/indra-followup/student8cropids/model.onnx', gpu: 'assets/indra-followup/gpu8croph/model.onnx', codec: 'assets/indra-followup/student8cropids/codec.json' },
  light: { cpu: 'assets/indra-followup/student10c64cropids/model.onnx', gpu: 'assets/indra-followup/gpu64croph/model.onnx', codec: 'assets/indra-followup/student10c64cropids/codec.json' },
});

// Browser command replay takes an external mask; native engines retain width inputs.
export const ocrModels = Object.freeze(Object.fromEntries(Object.entries(nativeModels).map(([name, pack]) =>
  [name, { ...pack, gpu: pack.gpu.replace('/model.onnx', '-capture/model.onnx') }])));

export function ocrTier(id = DEFAULT_TIER) {
  if (!Object.hasOwn(ocrTiers, id)) throw new Error(`Unknown OCR tier: ${id}`);
  return ocrTiers[id];
}
