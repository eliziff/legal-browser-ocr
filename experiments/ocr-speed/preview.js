// Keep OCR pixels intact; only the displayed page preview is downsampled.
export async function setThumbnail(image, source) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 640 / source.width);
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .72));
  canvas.width = canvas.height = 1;
  if (!blob) throw new Error('Page preview encoding failed');
  const url = URL.createObjectURL(blob);
  image.onload = image.onerror = () => URL.revokeObjectURL(url);
  image.src = url;
}
