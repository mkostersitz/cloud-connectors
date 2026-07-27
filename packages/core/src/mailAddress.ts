/**
 * Recipient and header validation for the mail-sending tools.
 *
 * Both connectors compose messages from strings the model supplies. Anything that reaches an
 * RFC 5322 header or an SMTP command must therefore be proven free of CR/LF first: a bare newline
 * in a subject or recipient is header injection (extra Bcc:, a forged From:, a second message
 * body), and in the SMTP envelope it is command injection. Validating at the tool boundary means
 * neither connector depends on a downstream library choosing to sanitize.
 */

/** Control characters that terminate or split a header line / SMTP command. */
const HEADER_UNSAFE = /[\r\n\u0000\u2028\u2029]/;

/**
 * Pragmatic addr-spec check: a local part without whitespace, quotes, or address-list
 * metacharacters, and a dotted domain of LDH labels. Deliberately stricter than RFC 5322 (no
 * quoted local parts, no address literals, no comments) - those are legitimate but vanishingly
 * rare in personal mail, and every one of them is an extra parser to get wrong.
 */
const ADDR_SPEC = /^[^\s<>@,;:\\"()[\]\u0000-\u001f\u007f]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Matches the `Display Name <addr@example.com>` form, capturing the two parts. */
const NAME_ADDR = /^(.*?)<([^<>]*)>$/;

const MAX_ADDRESS_LENGTH = 320; // RFC 3696 practical maximum: 64-char local part + '@' + 255-char domain
const MAX_HEADER_LENGTH = 998; // RFC 5322 line-length limit

/**
 * Rejects any value that could break out of the header (or SMTP command) it is about to be
 * placed in. Returns the value unchanged so it can be used inline.
 */
export function assertHeaderSafe(value: string, field: string): string {
    if (HEADER_UNSAFE.test(value)) {
        throw new Error(`${field} must not contain line breaks or control characters.`);
    }
    if (value.length > MAX_HEADER_LENGTH) {
        throw new Error(`${field} is ${value.length} characters, over the ${MAX_HEADER_LENGTH}-character header limit.`);
    }
    return value;
}

/**
 * Validates one recipient, accepting either a bare `user@example.com` or a
 * `Display Name <user@example.com>`, and returns it in normalized form. Throws with a message
 * naming the offending input - these are user-facing tool errors, not internal assertions.
 */
export function normalizeEmailAddress(input: string, field = 'Recipient'): string {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        throw new Error(`${field} must not be empty.`);
    }
    assertHeaderSafe(trimmed, field);
    if (trimmed.length > MAX_ADDRESS_LENGTH) {
        throw new Error(`${field} "${trimmed.slice(0, 40)}..." is too long to be an email address.`);
    }

    const named = NAME_ADDR.exec(trimmed);
    const addrSpec = (named ? named[2] : trimmed).trim();
    if (!ADDR_SPEC.test(addrSpec)) {
        throw new Error(`${field} "${trimmed}" is not a valid email address.`);
    }

    if (!named) {
        return addrSpec;
    }

    const displayName = named[1].trim().replace(/^"(.*)"$/s, '$1');
    if (displayName.length === 0) {
        return addrSpec;
    }
    // Quote the display name so that commas, colons, and other address-list separators inside it
    // cannot be read as the start of another recipient.
    return `"${displayName.replace(/(["\\])/g, '\\$1')}" <${addrSpec}>`;
}

/**
 * Strips any display name from an already-normalized address, yielding the bare addr-spec.
 * The SMTP envelope (MAIL FROM / RCPT TO) takes addr-specs only - display names belong in the
 * message headers, not in the protocol commands.
 */
export function addrSpecOnly(normalized: string): string {
    const named = NAME_ADDR.exec(normalized);
    return named ? named[2].trim() : normalized;
}

/**
 * Validates a recipient list, rejecting an empty list when `required`. Returns the normalized
 * addresses; duplicates are preserved (deduplicating silently would hide a caller mistake).
 */
export function normalizeRecipients(
    addresses: readonly string[] | undefined,
    field: string,
    { required = false }: { required?: boolean } = {},
): string[] {
    const list = addresses ?? [];
    if (list.length === 0) {
        if (required) {
            throw new Error(`At least one ${field} address is required.`);
        }
        return [];
    }
    return list.map((address) => normalizeEmailAddress(address, `${field} address`));
}
