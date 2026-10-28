/**
 * Text layer of a PDF, with positions. The only place that knows pdfjs: everything after works on
 * `TextFragment[]`, so the receipt tests need no PDF.
 */

import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextFragment } from "./text-grid.ts";

/**
 * Later pages are shifted down, so that sorting by decreasing `y` gives the reading order of the
 * whole document. pdfjs may detach the buffer it gets: it receives a copy.
 */
export const readPdfText = async (data: Uint8Array): Promise<TextFragment[]> => {
    const task = getDocument({ data: new Uint8Array(data), verbosity: VerbosityLevel.ERRORS });
    const document = await task.promise;
    try {
        const items: TextFragment[] = [];
        let offset = 0;
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number);
            try {
                const content = await page.getTextContent();
                for (const item of content.items) {
                    if (!("str" in item)) continue;
                    const [, , , , x, y] = item.transform as number[];
                    if (x === undefined || y === undefined) continue;
                    items.push({ str: item.str, x, y: y - offset, width: item.width });
                }
                const [, , , height = 0] = page.getViewport({ scale: 1 }).viewBox;
                offset += height;
            } finally {
                page.cleanup();
            }
        }
        return items;
    } finally {
        await task.destroy();
    }
};
