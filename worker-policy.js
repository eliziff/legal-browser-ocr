export function recognitionWorkers(parallelism) {
  const available=Math.max(1,Math.floor(Number(parallelism)||1));
  return available>2?available-1:1;
}

export function documentWorkers(workerPoolSize,segmentation) {
  return segmentation==='tesseract'?Math.max(1,workerPoolSize):1;
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
