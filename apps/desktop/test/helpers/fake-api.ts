import { deriveSections, proposeFrames, type PageText, type Project } from '@mcprep/core';
import type { Api, OpenedDocument, SaveOutcome } from '../../src/shared/api.js';

/**
 * The window's bridge to the main process, replaced by an object in memory: the store is tested without a window.
 * `pdf` and `texts` are read when a call is made (the tests build them in `beforeAll`).
 */
export function fakeApi(
  source: { pdf: () => Uint8Array; texts: () => PageText[]; fresh: () => Project },
  overrides: Partial<Api> = {},
): Api & { saved: Project[] } {
  const saved: Project[] = [];
  const api: Api = {
    chooseAndOpenPdf: () => Promise.resolve(null),
    chooseAndOpenProject: () => Promise.resolve(null),
    openPath: () => Promise.resolve({ ok: false, message: 'no' }),
    pathForFile: () => '',
    recent: () => Promise.resolve([{ path: 'x.mcprep.json', title: 'X', openedAt: '2026-10-03T12:00:00Z' }]),
    readPdf: () => Promise.resolve(source.pdf()),
    pageText: (page) => Promise.resolve(source.texts()[page] as PageText),
    propose: () => Promise.resolve(proposeFrames(source.texts())),
    deriveSections: () => Promise.resolve({ ok: true, result: deriveSections(source.texts()) }),
    cancelAudit: () => Promise.resolve(),
    onProgress: () => () => undefined,
    saveProject: (project, expected) => {
      saved.push(project);
      const written: Project = { ...project, revision: expected + 1, updatedAt: '2026-10-03T13:00:00Z', modifiedBy: 'desktop' };
      return Promise.resolve<SaveOutcome>({ ok: true, project: written });
    },
    reloadProject: () => Promise.resolve(source.fresh()),
    exportBundle: () =>
      Promise.resolve({
        ok: true,
        path: 'C:/out/sheet.mcbundle',
        bytes: 100,
        frames: 3,
        outlineEntries: 0,
        issues: [],
        check: { wouldImport: true, features: [], frames: 3, outlineEntries: 0, warnings: 0, repairs: 0, steps: [] },
      }),
    exportBookSummary: () => Promise.resolve({ ok: true, path: 'C:/out/sheet.book.json', bytes: 10, sections: 0, exercises: 0 }),
    copyToFolder: () => Promise.resolve('D:/tablet/sheet.mcbundle'),
    reveal: () => Promise.resolve(),
    onDiskChange: () => () => undefined,
    onMenu: () => () => undefined,
    setDirty: () => undefined,
    ready: () => undefined,
    ...overrides,
  };
  return Object.assign(api, { saved });
}

/** A document as the main process hands it over: `pages` pages of A4. */
export function openedDocument(project: Project, pages = 3, pdfOutline: OpenedDocument['pdfOutline'] = [{ title: 'Differentiation', page: 0, depth: 0 }]): OpenedDocument {
  return {
    projectPath: 'C:/work/sheet.mcprep.json',
    pdfPath: 'C:/work/sheet.pdf',
    project,
    pageSizes: Array.from({ length: pages }, () => ({ width: 595, height: 842, rotation: 0 })),
    pdfOutline,
  };
}
