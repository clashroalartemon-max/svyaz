/**
 * Документы в чате: метаданные файла хранятся в `messages.mime_type` в виде
 * `mime|encoded-name|size`. Отдельная колонка не нужна, а имя и размер
 * доступны до скачивания.
 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const DOC_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'zip',
  'rar',
  '7z',
  'txt',
  'md',
  'csv',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'rtf',
  'odt',
];

export interface FileMeta {
  mime: string;
  name: string;
  size: number;
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index + 1).toLowerCase();
}

export function isDocumentFile(name: string, mime: string): boolean {
  if (mime.includes('pdf') || mime.includes('word') || mime.includes('sheet')) return true;
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('text/')) return true;
  return DOC_EXTENSIONS.includes(fileExtension(name));
}

export function packFileMeta(mime: string, name: string, size: number): string {
  return `${mime || 'application/octet-stream'}|${encodeURIComponent(name)}|${size}`;
}

export function parseFileMeta(value: string | undefined): FileMeta {
  if (!value) return { mime: 'application/octet-stream', name: 'Файл', size: 0 };
  const parts = value.split('|');
  if (parts.length < 3) return { mime: value, name: 'Файл', size: 0 };
  const size = Number(parts[parts.length - 1]);
  const name = decodeURIComponent(parts[parts.length - 2]);
  const mime = parts.slice(0, -2).join('|') || 'application/octet-stream';
  return { mime, name, size: Number.isFinite(size) ? size : 0 };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function isTextFile(meta: FileMeta): boolean {
  return meta.mime.startsWith('text/') || ['txt', 'md', 'csv'].includes(fileExtension(meta.name));
}

export function isPdfFile(meta: FileMeta): boolean {
  return meta.mime.includes('pdf') || fileExtension(meta.name) === 'pdf';
}
