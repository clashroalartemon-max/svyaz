import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  isDocumentFile,
  isPdfFile,
  isTextFile,
  packFileMeta,
  parseFileMeta,
} from './documents';

describe('метаданные документа', () => {
  it('упаковывает и читает имя, mime и размер', () => {
    const packed = packFileMeta('application/pdf', 'Приказ № 5.pdf', 12345);
    expect(parseFileMeta(packed)).toEqual({
      mime: 'application/pdf',
      name: 'Приказ № 5.pdf',
      size: 12345,
    });
  });

  it('переживает пустой mime и спецсимволы в имени', () => {
    const packed = packFileMeta('', 'отчёт 2026 (итог).docx', 900);
    const parsed = parseFileMeta(packed);
    expect(parsed.mime).toBe('application/octet-stream');
    expect(parsed.name).toBe('отчёт 2026 (итог).docx');
  });

  it('распознаёт документы по расширению и mime', () => {
    expect(isDocumentFile('a.pdf', '')).toBe(true);
    expect(isDocumentFile('a.zip', 'application/zip')).toBe(true);
    expect(isDocumentFile('a.txt', 'text/plain')).toBe(true);
    expect(isDocumentFile('a.jpg', 'image/jpeg')).toBe(false);
  });

  it('определяет PDF и текст для превью', () => {
    expect(isPdfFile(parseFileMeta(packFileMeta('application/pdf', 'a.pdf', 10)))).toBe(true);
    expect(isTextFile(parseFileMeta(packFileMeta('text/plain', 'a.txt', 10)))).toBe(true);
  });

  it('форматирует размер', () => {
    expect(formatBytes(512)).toBe('512 Б');
    expect(formatBytes(2048)).toBe('2 КБ');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 МБ');
  });
});
