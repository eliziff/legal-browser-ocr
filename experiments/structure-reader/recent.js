// Blobs remain browser-managed; only the active PDF becomes an ArrayBuffer.
let database;
function open() {
  return database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('legal-ocr-recent-pdfs', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('documents', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function run(store, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error || request.error);
  });
}
export async function recentDocuments() {
  const records = await run('documents', 'readonly', store => store.getAll());
  for (const record of records) {
    try { record.page = Number(localStorage.getItem(`legal-ocr-page:${record.id}`)) || record.page; } catch { /* Reading still works when navigation storage is unavailable. */ }
  }
  return records;
}
export const rememberDocument = record => run('documents', 'readwrite', store => store.put(record));
export async function forgetDocument(id) {
  await run('documents', 'readwrite', store => store.delete(id));
  try { localStorage.removeItem(`legal-ocr-page:${id}`); } catch { /* The PDF has been removed. */ }
}
export async function activeDocument() { try { return localStorage.getItem('legal-ocr-active'); } catch { return null; } }
export async function rememberActive(id) { localStorage.setItem('legal-ocr-active', id || ''); }
// Tiny synchronous writes survive an immediate reload and never rewrite a PDF Blob.
export async function rememberPage(id, page) { localStorage.setItem(`legal-ocr-page:${id}`, String(page)); }
