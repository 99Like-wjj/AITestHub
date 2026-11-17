type PdfSearchItem = { str: string; hasEOL?: boolean } | { type: string };

/** Font fragments are contiguous; PDF.js already supplies explicit word spaces. */
export function pdfSearchPageText(items: readonly PdfSearchItem[]): string {
  return items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
    .join('');
}

/** CJK font changes can introduce layout spaces around otherwise contiguous text. */
export function normalizePdfSearchText(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .replace(/(\p{Script=Han}) +/gu, '$1')
    .replace(/ +(?=\p{Script=Han})/gu, '')
    .trim()
    .toLocaleLowerCase();
}
