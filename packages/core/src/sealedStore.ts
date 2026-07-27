import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isKeychainSupported, keychainDelete, keychainGet, keychainSet } from './keychain.js';

/**
 * A small string-valued secret store. Implementations must never leave the value readable on
 * disk without OS-backed protection.
 */
export interface SealedStore {
    /**
     * Verifies that the backing key material is reachable, creating it if needed. Throws if it is
     * not - call this up front so an unusable store is reported at startup rather than on the
     * first read that happens to need a key.
     */
    ensureReady(): Promise<void>;
    /** Returns the stored value, or undefined if nothing is stored (or it is no longer decryptable). */
    read(): Promise<string | undefined>;
    /** Stores (replacing) the value. */
    write(value: string): Promise<void>;
    /** Removes the value and any key material backing it. */
    clear(): Promise<void>;
}

export interface SealedStoreOptions {
    /** Keychain service name, e.g. the connector name. No whitespace. */
    service: string;
    /** Keychain account name identifying which secret of that service this is. No whitespace. */
    account: string;
    /** Path of the sealed (encrypted) payload file. */
    filePath: string;
}

/** File header: format magic + version. Bumping the trailing byte invalidates old files by design. */
const MAGIC = Buffer.from('CCSEAL\x00\x01', 'latin1'); // 8 bytes
const IV_LENGTH = 12; // GCM standard nonce length
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // AES-256
const HEADER_LENGTH = MAGIC.length + IV_LENGTH + TAG_LENGTH;

/**
 * Creates a store that keeps a 32-byte AES-256-GCM data key in the macOS Keychain and the
 * (arbitrarily large) payload as an authenticated-encrypted file on disk.
 *
 * Why envelope encryption rather than putting the payload straight into the Keychain: writing
 * through `security -i` is the only way to keep a secret out of the process command line, and
 * that interface caps a command at roughly 2 KB - far short of an MSAL token cache. A 44-char
 * base64 data key fits with room to spare, and the payload inherits the Keychain's protection
 * because it is useless without that key.
 *
 * Throws if the Keychain is not usable on this platform; callers decide what to do about that
 * (this module deliberately offers no plaintext fallback).
 */
export function createKeychainSealedStore(options: SealedStoreOptions): SealedStore {
    if (!isKeychainSupported()) {
        throw new Error('macOS Keychain is not available on this platform');
    }
    const { service, account, filePath } = options;

    /**
     * Returns the data key, generating and storing one on first use. After generating, the key is
     * read back rather than trusted locally: if two connector processes race to initialize, both
     * then converge on whichever key the Keychain actually kept.
     */
    async function getDataKey(): Promise<Buffer> {
        const existing = await keychainGet(service, account);
        if (existing) {
            const key = Buffer.from(existing, 'base64');
            if (key.length === KEY_LENGTH) {
                return key;
            }
            // Wrong length means the item is not one of ours (or is corrupt); replacing it would
            // destroy someone else's secret, so refuse rather than guess.
            throw new Error(
                `Keychain item ${service}/${account} does not hold a ${KEY_LENGTH}-byte key; ` +
                    'delete it in Keychain Access if it is stale, then retry.',
            );
        }

        await keychainSet(service, account, randomBytes(KEY_LENGTH).toString('base64'));
        const stored = await keychainGet(service, account);
        if (!stored) {
            throw new Error(`Keychain item ${service}/${account} could not be read back after being written`);
        }
        return Buffer.from(stored, 'base64');
    }

    return {
        async ensureReady(): Promise<void> {
            await getDataKey();
        },

        async read(): Promise<string | undefined> {
            let sealed: Buffer;
            try {
                sealed = await readFile(filePath);
            } catch (err) {
                if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
                throw err;
            }

            if (sealed.length < HEADER_LENGTH || !sealed.subarray(0, MAGIC.length).equals(MAGIC)) {
                await quarantine(filePath, 'unrecognized file format');
                return undefined;
            }

            const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV_LENGTH);
            const tag = sealed.subarray(MAGIC.length + IV_LENGTH, HEADER_LENGTH);
            const ciphertext = sealed.subarray(HEADER_LENGTH);

            try {
                const decipher = createDecipheriv('aes-256-gcm', await getDataKey(), iv);
                decipher.setAuthTag(tag);
                decipher.setAAD(MAGIC);
                return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
            } catch {
                // Wrong key or tampered file. Degrading to "nothing stored" (re-authenticate)
                // is the only safe move - never fall back to reading it some other way.
                await quarantine(filePath, 'could not be decrypted or failed its integrity check');
                return undefined;
            }
        },

        async write(value: string): Promise<void> {
            const key = await getDataKey();
            const iv = randomBytes(IV_LENGTH);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            cipher.setAAD(MAGIC);
            const ciphertext = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
            const sealed = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);

            const dir = path.dirname(filePath);
            await mkdir(dir, { recursive: true, mode: 0o700 });
            // mkdir's mode is masked by umask and ignored for a directory that already exists,
            // so set it explicitly - the ciphertext is safe, but the directory listing is not
            // something other local users need.
            await chmod(dir, 0o700).catch(() => {});
            // Write-then-rename so a crash mid-write cannot truncate an existing good cache.
            const tempPath = `${filePath}.${process.pid}.tmp`;
            await writeFile(tempPath, sealed, { mode: 0o600 });
            await chmod(tempPath, 0o600);
            await rename(tempPath, filePath);
        },

        async clear(): Promise<void> {
            await rm(filePath, { force: true });
            await keychainDelete(service, account);
        },
    };
}

/**
 * Moves an unreadable payload aside instead of deleting it, so a bad upgrade or a key mix-up is
 * diagnosable after the fact, and logs why. Best-effort: a failure here must not break the caller.
 */
async function quarantine(filePath: string, reason: string): Promise<void> {
    const quarantinePath = `${filePath}.unreadable`;
    try {
        await rename(filePath, quarantinePath);
        console.error(
            `[sealed-store] ${filePath} ${reason}; moved to ${quarantinePath} and treating the store as empty`,
        );
    } catch {
        console.error(`[sealed-store] ${filePath} ${reason}; treating the store as empty`);
    }
}
