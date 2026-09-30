export class TesseractLayout {
  constructor({ workerPath = './tesseract-layout-worker.js', corePath = './dist/layout-core.mjs', wasmPath = './dist/layout-core.wasm', sourceResolution = 200, trim = false, psm = 3, binaryThreshold = 0 } = {}) {
    this.worker = new Worker(workerPath);
    this.corePath = new URL(corePath, location.href).href;
    this.wasmPath = new URL(wasmPath, location.href).href;
    this.sourceResolution = sourceResolution;
    this.trim = trim;
    this.psm = psm;
    this.binaryThreshold = binaryThreshold;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.worker.onmessage = ({ data }) => {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.lines.map(line=>({x0:line.x0+pending.x,y0:line.y0+pending.y,x1:line.x1+pending.x,y1:line.y1+pending.y})));
    };
    this.worker.onerror = error => {
      for (const pending of this.pending.values()) pending.reject(new Error(error.message || 'layout worker failed'));
      this.pending.clear();
    };
  }

  async findLines(canvas) {
    if (this.closed) throw new DOMException('Layout worker terminated', 'AbortError');
    let { width, height } = canvas;
    let x=0,y=0,cropWidth=width,cropHeight=height;
    if(this.trim){
      const divisor=8,sampleWidth=Math.ceil(width/divisor),sampleHeight=Math.ceil(height/divisor),sample=typeof OffscreenCanvas==='function'?new OffscreenCanvas(sampleWidth,sampleHeight):document.createElement('canvas');sample.width=sampleWidth;sample.height=sampleHeight;const sampleContext=sample.getContext('2d',{willReadFrequently:true});sampleContext.drawImage(canvas,0,0,sampleWidth,sampleHeight);const preview=sampleContext.getImageData(0,0,sampleWidth,sampleHeight).data;
      let left=sampleWidth,top=sampleHeight,right=0,bottom=0;
      for(let yy=0;yy<sampleHeight;yy++)for(let xx=0;xx<sampleWidth;xx++){const offset=(yy*sampleWidth+xx)*4;if(preview[offset]+preview[offset+1]+preview[offset+2]<720){left=Math.min(left,xx);right=Math.max(right,xx);top=Math.min(top,yy);bottom=Math.max(bottom,yy)}}
      if(right>left&&bottom>top){const margin=48;x=Math.max(0,left*divisor-margin);y=Math.max(0,top*divisor-margin);const cropRight=Math.min(width,(right+1)*divisor+margin),cropBottom=Math.min(height,(bottom+1)*divisor+margin);cropWidth=cropRight-x;cropHeight=cropBottom-y;
        if(cropWidth*cropHeight>=width*height*.95){x=0;y=0;cropWidth=width;cropHeight=height}
      }
    }
    const bitmap = typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function'
      ? await createImageBitmap(canvas, x, y, cropWidth, cropHeight) : undefined;
    if (this.closed) { bitmap?.close(); throw new DOMException('Layout worker terminated', 'AbortError'); }
    const pixels = bitmap ? undefined : canvas.getContext('2d').getImageData(x,y,cropWidth,cropHeight).data.buffer;
    width=cropWidth;height=cropHeight;
    const id = ++this.nextId;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, x, y }));
    try {
      this.worker.postMessage({ id, bitmap, pixels, width, height, corePath: this.corePath, wasmPath: this.wasmPath, sourceResolution: this.sourceResolution, psm: this.psm, binaryThreshold: this.binaryThreshold }, [bitmap ?? pixels]);
    } catch (error) {
      bitmap?.close(); this.pending.get(id).reject(error); this.pending.delete(id);
    }
    return result;
  }

  terminate() {
    this.closed = true;
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new DOMException('Layout worker terminated', 'AbortError'));
    this.pending.clear();
  }
}
