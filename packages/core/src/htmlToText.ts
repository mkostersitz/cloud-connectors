/** Minimal HTML -> plain text: drops script/style, strips tags, decodes common entities, collapses whitespace. */
export function htmlToText(html: string): string {
    const NAMED_ENTITIES: Record<string, string> = {
        nbsp: ' ',
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        '#39': "'",
    };

    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '');

    text = text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const code = parseInt(entity.slice(2), 16);
            return Number.isNaN(code) ? match : String.fromCodePoint(code);
        }
        if (entity.startsWith('#')) {
            const code = parseInt(entity.slice(1), 10);
            return Number.isNaN(code) ? match : String.fromCodePoint(code);
        }
        return NAMED_ENTITIES[entity] ?? match;
    });

    return text
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n\s*\n+/g, '\n\n')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .trim();
}
