export function recognitionWorkers(parallelism) {
  const available=Math.max(1,Math.floor(Number(parallelism)||1));
  return available>2?available-1:1;
}

export function documentWorkers(workerPoolSize,segmentation) {
  return segmentation==='tesseract'?Math.max(1,workerPoolSize):1;
}

/** Shared production defaults for the browser app and embedding hosts. */
export function runtimeDefaults(backend, parallelism = globalThis.navigator?.hardwareConcurrency || 2) {
  const gpu = backend === 'webgpu';
  const workerPoolSize = gpu ? 1 : Math.min(6, Math.max(1, Math.floor(parallelism / 2)));
  const pageBatch = gpu ? 4 : 1;
  return { workerPoolSize, layoutWorkerCount: Math.min(4, Math.max(1, Math.floor(parallelism / 3))),
    batchSize: 16, bucketSize: 24, sortedBatches: gpu, pageBatch,
    prepareWorker: false, layoutBackend: 'wasm', widthMultiple: gpu ? 256 : 8, workerThreads: 1,
    captureMode: gpu, captureEnabled: gpu, gpuPrep: gpu, gpuDirect: false,
    gpuArgMax: gpu ? 128 : 0, gpuCacheShapes: 8, scanPages: true,
    pageConcurrency: documentWorkers(workerPoolSize * pageBatch * (gpu ? 2 : 1), 'tesseract'),
    sessionOptions: { graphOptimizationLevel: 'all' } };
}

export async function processingBackend() {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (adapter && !(adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter) && adapter.features.has('shader-f16')) return 'webgpu';
  } catch { /* CPU inference remains available without a supported GPU. */ }
  return 'wasm';
}

export function takeRecognitionBatch(queue,size) {
  if(!queue.length)return [];
  let tasks;
  if(queue[0].batch){
    const ready=queue.find(task=>task.batch&&queue.filter(other=>other.batch?.group===task.batch.group).length===task.batch.group.expected);
    if(!ready)return [];
    tasks=queue.filter(task=>task.batch?.group===ready.batch.group).sort((a,b)=>a.batch.index-b.batch.index);
  }else{
    tasks=[queue[0]];
    while(tasks.length<size&&queue[tasks.length]?.scale===tasks[0].scale&&!queue[tasks.length].batch)tasks.push(queue[tasks.length]);
  }
  for(const task of tasks)queue.splice(queue.indexOf(task),1);
  return tasks;
}
