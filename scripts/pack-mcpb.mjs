#!/usr/bin/env node
/**
 * Packs one workspace package into a .mcpb bundle.
 *
 * npm workspaces hoist shared dependencies to the ROOT node_modules and symlink workspace
 * packages (e.g. @cloud-connectors/core) into each consumer's node_modules. Packing straight
 * from packages/<name> would therefore produce a bundle with missing or symlinked
 * dependencies. This script instead builds a throwaway staging directory with a *real*,
 * non-hoisted node_modules (via `npm pack` + `npm install`) and packs that.
 *
 * Bundles are per-platform. A .mcpb is a frozen node_modules, so anything platform-specific in
 * there (a native addon, a credential-store backend) is baked in at pack time - which is why a
 * Windows-packed bundle used to degrade to plaintext token storage on macOS. The target platform
 * therefore selects which dependencies are installed, is stamped into the staged manifest's
 * `compatibility.platforms`, and appears in the output filename.
 *
 * Usage:
 *   node scripts/pack-mcpb.mjs <package-dir-name> [--platform=darwin|win32]
 *   e.g. node scripts/pack-mcpb.mjs windows-live-connector --platform=darwin
 *
 * `--platform` defaults to the host platform. Cross-packing is allowed only when the target needs
 * no native code for that platform (enforced below), since npm cannot build another OS's addons.
 */

import { execFileSync } from 'node:child_process';
import {
    mkdtempSync,
    mkdirSync,
    cpSync,
    readFileSync,
    writeFileSync,
    readdirSync,
    existsSync,
    lstatSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

/** Node platform id -> the label used in bundle filenames. */
const PLATFORM_LABELS = { darwin: 'macos', win32: 'windows' };

function run(cmd, args, opts = {}) {
    console.log(`\n> ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`);
    execFileSync(cmd, args, { stdio: 'inherit', shell: isWindows, ...opts });
}

function fail(message) {
    console.error(`\npack-mcpb: ${message}`);
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    const targetName = args.find((a) => !a.startsWith('--'));
    if (!targetName) {
        fail('Usage: node scripts/pack-mcpb.mjs <package-dir-name> [--platform=darwin|win32]');
    }

    const platformArg = args.find((a) => a.startsWith('--platform='))?.split('=')[1];
    const targetPlatform = platformArg ?? process.platform;
    if (!PLATFORM_LABELS[targetPlatform]) {
        fail(`Unsupported --platform "${targetPlatform}" (expected one of: ${Object.keys(PLATFORM_LABELS).join(', ')})`);
    }
    const platformLabel = PLATFORM_LABELS[targetPlatform];
    console.log(`target platform: ${targetPlatform} (${platformLabel}); host: ${process.platform}`);

    // Cross-packing is only sound when the target needs no compiled code. A Windows bundle does
    // (dpapi.node for the token cache), and npm would install this host's binaries alongside it,
    // so the result would be a bundle that cannot load its own credential store.
    if (targetPlatform === 'win32' && process.platform !== 'win32') {
        fail(
            'Windows bundles must be packed on Windows: they ship native bindings, and npm would install ' +
                `${process.platform} binaries here. macOS bundles are pure JavaScript and can be packed anywhere.`,
        );
    }

    const targetDir = path.join(ROOT, 'packages', targetName);
    if (!existsSync(targetDir) || !existsSync(path.join(targetDir, 'package.json'))) {
        fail(`No such package: packages/${targetName} (missing directory or package.json)`);
    }

    const manifestPath = path.join(targetDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
        fail(`packages/${targetName}/manifest.json not found - required to pack a .mcpb bundle`);
    }

    // ---- 1. Build all packages (core, then the rest) -----------------------------------
    console.log('=== Step 1/6: build all packages ===');
    run('npm', ['run', 'build'], { cwd: ROOT });

    const distDir = path.join(targetDir, 'dist');
    if (!existsSync(path.join(distDir, 'index.js'))) {
        fail(`packages/${targetName}/dist/index.js not found after build`);
    }

    // ---- 2. npm pack packages/core into a tarball -------------------------------------
    console.log('\n=== Step 2/6: npm pack @cloud-connectors/core ===');
    const workRoot = mkdtempSync(path.join(tmpdir(), 'cloud-connectors-pack-'));
    run('npm', ['pack', './packages/core', '--pack-destination', workRoot], { cwd: ROOT });
    const coreTgzName = readdirSync(workRoot).find(
        (f) => f.startsWith('cloud-connectors-core-') && f.endsWith('.tgz'),
    );
    if (!coreTgzName) {
        fail('npm pack did not produce a @cloud-connectors/core tarball');
    }
    const coreTgzPath = path.join(workRoot, coreTgzName);
    console.log(`core tarball: ${coreTgzPath}`);

    // ---- 3. Staging dir: manifest.json, dist/, .mcpbignore, rewritten package.json ----
    console.log(`\n=== Step 3/6: stage packages/${targetName} ===`);
    const stagingDir = path.join(workRoot, 'staging');
    mkdirSync(stagingDir, { recursive: true });

    // Stamp the target platform into the staged manifest so Claude Desktop refuses to install a
    // macOS bundle on Windows (or vice versa) rather than installing one that silently misbehaves.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const declaredPlatforms = manifest.compatibility?.platforms;
    if (Array.isArray(declaredPlatforms) && !declaredPlatforms.includes(targetPlatform)) {
        fail(`packages/${targetName}/manifest.json declares platforms ${JSON.stringify(declaredPlatforms)}, which does not include "${targetPlatform}"`);
    }
    manifest.compatibility = { ...manifest.compatibility, platforms: [targetPlatform] };
    writeFileSync(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');

    cpSync(distDir, path.join(stagingDir, 'dist'), { recursive: true });

    // Deliberately NOT staging the package's .mcpbignore: the staging dir contains no
    // sources to exclude, and mcpb pack applies ignore patterns to the ENTIRE tree —
    // a blanket `src/` pattern once stripped runtime code out of node_modules
    // (encoding-japanese's main lives in src/, crashing the installed extension).

    const stagedCoreTgzName = 'cloud-connectors-core.tgz';
    cpSync(coreTgzPath, path.join(stagingDir, stagedCoreTgzName));

    const pkg = JSON.parse(readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
    if (!pkg.dependencies || !pkg.dependencies['@cloud-connectors/core']) {
        fail(`packages/${targetName}/package.json does not depend on @cloud-connectors/core`);
    }

    const stagedPkg = { ...pkg };
    stagedPkg.dependencies = {
        ...pkg.dependencies,
        '@cloud-connectors/core': `file:./${stagedCoreTgzName}`,
    };

    // Drop dependencies this platform's code path never imports. The motivating case is
    // @azure/msal-node-extensions on macOS: it exists only for the Windows DPAPI token cache, but
    // pulls in keytar - an archived, unmaintained native addon whose compiled binding is tied to
    // one CPU architecture and one Node ABI. Shipping it in a macOS bundle adds a binary that
    // cannot reliably load, so the connector uses the `security` CLI there instead and this
    // removes the dead weight (see packages/core/src/keychain.ts).
    const omitted = pkg.mcpb?.omitDependencies?.[targetPlatform] ?? [];
    for (const dep of omitted) {
        if (!stagedPkg.dependencies[dep]) {
            fail(`package.json mcpb.omitDependencies lists "${dep}" for ${targetPlatform}, but it is not a dependency`);
        }
        delete stagedPkg.dependencies[dep];
        console.log(`omitting dependency for ${targetPlatform}: ${dep}`);
    }

    delete stagedPkg.devDependencies;
    delete stagedPkg.scripts;
    delete stagedPkg.mcpb;
    writeFileSync(path.join(stagingDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`, 'utf-8');

    // ---- 4. npm install --omit=dev in staging: real, non-hoisted node_modules ---------
    console.log('\n=== Step 4/6: npm install --omit=dev in staging ===');
    // --ignore-scripts: nothing that ends up in a bundle needs a lifecycle script, and refusing to
    // run them means a compromised transitive package cannot execute code on the packing machine.
    // If a future dependency genuinely needs one, the smoke test below will catch it.
    run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--fund=false'], { cwd: stagingDir });

    // Vulnerability gate on exactly the tree that ships. The root workspace being clean does not
    // prove this is: staging resolves fresh, so anything not pinned could float upward.
    console.log('\n--- npm audit (runtime deps that will ship) ---');
    auditStaging(stagingDir);

    const stagedCoreDir = path.join(stagingDir, 'node_modules', '@cloud-connectors', 'core');
    if (!existsSync(path.join(stagedCoreDir, 'package.json'))) {
        fail('staging node_modules/@cloud-connectors/core was not installed');
    }
    if (lstatSync(stagedCoreDir).isSymbolicLink()) {
        fail('staging node_modules/@cloud-connectors/core is a symlink, not a real copy');
    }

    // The tarball has now been extracted into node_modules by npm install; remove the
    // now-redundant copy sitting at the staging root so it doesn't bloat the bundle.
    rmSync(path.join(stagingDir, stagedCoreTgzName), { force: true });

    // ---- 4a. Native-binding policy for the target platform ----------------------------
    checkNativeBindings(stagingDir, targetPlatform);

    // ---- 4b. Boot the staged server: catches missing/broken node_modules before pack ---
    console.log('\n=== Step 4b: smoke-test the staged server ===');
    await smokeTestStagedServer(stagingDir);

    // ---- 5. Pack with the mcpb CLI -----------------------------------------------------
    console.log('\n=== Step 5/6: mcpb pack ===');
    const bundleDir = path.join(ROOT, 'dist-bundle');
    mkdirSync(bundleDir, { recursive: true });
    const outputPath = path.join(bundleDir, `${targetName}-${pkg.version}-${platformLabel}.mcpb`);
    run('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', stagingDir, outputPath], { cwd: ROOT });

    if (!existsSync(outputPath)) {
        fail(`mcpb pack did not produce ${outputPath}`);
    }

    // ---- 6. Sanity-check the produced bundle ------------------------------------------
    console.log('\n=== Step 6/6: sanity-check the bundle ===');
    sanityCheckBundle(outputPath, targetPlatform);

    console.log(`\nOK: ${path.relative(ROOT, outputPath)}`);

    rmSync(workRoot, { recursive: true, force: true });
}

/**
 * Boots the staged server from its own node_modules, sends initialize + tools/list over
 * stdio, and asserts a serverInfo response and a non-empty tool list come back. This is
 * what catches broken/missing runtime dependencies that a file-listing check cannot.
 */
async function smokeTestStagedServer(stagingDir) {
    const { spawn } = await import('node:child_process');
    // process.execPath, not 'node': with shell:false on Windows, a bare 'node' is not
    // PATH-resolved and the spawn fails silently (error event, empty output).
    const child = spawn(process.execPath, [path.join(stagingDir, 'dist', 'index.js')], {
        cwd: stagingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });
    child.on('error', (err) => fail(`staged server failed to spawn: ${err.message}`));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-smoke', version: '0' } } })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);

    // Wait for the actual responses rather than a fixed sleep: the first boot right after
    // npm install can take many seconds (antivirus on-access scanning of thousands of
    // fresh files), which a short fixed window misdiagnoses as a dead server.
    const DEADLINE_MS = 60000;
    let toolCount = 0;
    let sawInit = false;
    const parseSoFar = () => {
        for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
            try {
                const msg = JSON.parse(line);
                if (msg.id === 1 && msg.result?.serverInfo) sawInit = true;
                if (msg.id === 2 && Array.isArray(msg.result?.tools)) toolCount = msg.result.tools.length;
            } catch {
                fail(`staged server wrote non-JSON to stdout: ${line.slice(0, 200)}`);
            }
        }
    };
    const exited = new Promise((resolve) => child.on('close', resolve));
    const start = Date.now();
    while (Date.now() - start < DEADLINE_MS) {
        parseSoFar();
        if (sawInit && toolCount > 0) break;
        if (child.exitCode !== null) break; // died early - no point waiting out the deadline
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    child.stdin.end();
    child.kill();
    await exited;
    parseSoFar();
    if (!sawInit || toolCount === 0) {
        fail(
            `staged server smoke test failed (initialize ok: ${sawInit}, tools: ${toolCount}).\nstderr:\n${stderr.slice(0, 3000)}`,
        );
    }
    console.log(`staged server boots: initialize ok, ${toolCount} tools listed`);
}

/**
 * Runs `npm audit` against the staged (runtime-only) tree and fails the pack on anything
 * high or critical. Moderate and low findings are printed but do not block - the point is a hard
 * floor on what may be shipped, not a clean-desk policy that gets bypassed with --force.
 */
function auditStaging(stagingDir) {
    let report;
    try {
        report = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
            cwd: stagingDir,
            encoding: 'utf-8',
            shell: isWindows,
            maxBuffer: 32 * 1024 * 1024,
        });
    } catch (err) {
        // npm audit exits non-zero when it finds anything; the JSON report is still on stdout.
        report = err.stdout;
        if (!report) {
            console.warn('warning: npm audit could not run (offline?); skipping the vulnerability gate');
            return;
        }
    }

    let vulnerabilities;
    try {
        ({ vulnerabilities } = JSON.parse(report).metadata ?? {});
    } catch {
        console.warn('warning: npm audit produced unparseable output; skipping the vulnerability gate');
        return;
    }
    if (!vulnerabilities) {
        console.warn('warning: npm audit report had no metadata; skipping the vulnerability gate');
        return;
    }

    const { critical = 0, high = 0, moderate = 0, low = 0 } = vulnerabilities;
    console.log(`audit: ${critical} critical, ${high} high, ${moderate} moderate, ${low} low`);
    if (critical + high > 0) {
        fail(
            `staged dependency tree has ${critical} critical and ${high} high-severity advisories. ` +
                'Run `npm audit` at the repo root and upgrade (or pin via the "overrides" field) before packing.',
        );
    }
}

/**
 * Enforces what native code may ship for the target platform.
 *
 * macOS: none at all. Every macOS code path is pure JavaScript by design (the Keychain is reached
 * through /usr/bin/security), so a `.node` file in the bundle means a dependency slipped a
 * compiled addon in - which would be built for this machine's exact Node ABI and architecture and
 * would fail to load under a different Claude Desktop runtime, taking its feature with it.
 *
 * Windows: the DPAPI binding is required, since it is what encrypts the token cache there.
 */
function checkNativeBindings(stagingDir, targetPlatform) {
    const modulesDir = path.join(stagingDir, 'node_modules');
    const nativeFiles = findFiles(modulesDir, (name) => name.endsWith('.node')).map((p) =>
        path.relative(stagingDir, p),
    );

    if (targetPlatform === 'darwin') {
        if (nativeFiles.length > 0) {
            fail(
                'macOS bundles must contain no native addons, but the staged tree has:\n  - ' +
                    `${nativeFiles.join('\n  - ')}\n` +
                    'Add the offending package to "mcpb.omitDependencies.darwin" in the connector package.json, ' +
                    'or replace it with a pure-JS equivalent.',
            );
        }
        console.log('native-binding policy (darwin): clean - no .node files in the bundle');
        return;
    }

    if (targetPlatform === 'win32') {
        const dpapi = nativeFiles.filter((p) => p.endsWith('dpapi.node'));
        if (dpapi.length === 0) {
            fail(
                'Windows bundles must ship @azure/msal-node-extensions/bin/<arch>/dpapi.node - without it the ' +
                    'connector cannot DPAPI-encrypt the token cache and will refuse to store credentials.',
            );
        }
        console.log(`native-binding policy (win32): DPAPI present (${dpapi.join(', ')})`);
    }
}

/** Recursively finds files under `dir` whose basename matches `matchName`. Returns [] if `dir` doesn't exist. */
function findFiles(dir, matchName) {
    if (!existsSync(dir)) return [];
    const results = [];
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (matchName(entry.name)) {
                results.push(full);
            }
        }
    }
    return results;
}

/** Lists a .mcpb (zip) file's entries via the `unzip` CLI and asserts expected structure. */
function sanityCheckBundle(mcpbPath, targetPlatform) {
    const listing = execFileSync('unzip', ['-Z1', mcpbPath], { encoding: 'utf-8' });
    const entries = listing.split(/\r?\n/).filter(Boolean);

    const has = (p) => entries.includes(p);
    const hasPrefix = (p) => entries.some((e) => e.startsWith(p));

    const problems = [];
    if (!has('manifest.json')) problems.push('manifest.json missing at bundle root');
    if (!has('dist/index.js')) problems.push('dist/index.js missing');
    if (!hasPrefix('node_modules/@cloud-connectors/core/')) problems.push('node_modules/@cloud-connectors/core missing');
    if (!hasPrefix('node_modules/@modelcontextprotocol/')) problems.push('node_modules/@modelcontextprotocol missing');
    if (hasPrefix('src/')) problems.push('src/ directory should not be present in the bundle');
    // Only police OUR files for stray TypeScript sources - third-party packages under
    // node_modules may legitimately ship .ts files.
    if (entries.some((e) => !e.startsWith('node_modules/') && e.endsWith('.ts') && !e.endsWith('.d.ts'))) {
        problems.push('bundle contains .ts source file(s) outside node_modules');
    }
    // Re-check the native-binding policy on the actual zip, not just the staging directory:
    // this is the artifact that ships, and it is cheap to be certain about.
    const nativeEntries = entries.filter((e) => e.endsWith('.node'));
    if (targetPlatform === 'darwin' && nativeEntries.length > 0) {
        problems.push(`macOS bundle contains native addon(s): ${nativeEntries.join(', ')}`);
    }
    if (targetPlatform === 'win32' && !nativeEntries.some((e) => e.endsWith('dpapi.node'))) {
        problems.push('Windows bundle is missing dpapi.node (token cache could not be DPAPI-encrypted)');
    }
    // A packed-in dotenv/credential file would ship someone's secrets to every installer.
    const secretish = entries.filter((e) => /(^|\/)\.env(\.|$)|(^|\/)\.npmrc$/.test(e) && !e.startsWith('node_modules/'));
    if (secretish.length > 0) {
        problems.push(`bundle contains credential-bearing file(s): ${secretish.join(', ')}`);
    }

    if (problems.length > 0) {
        fail(`bundle sanity check failed:\n  - ${problems.join('\n  - ')}`);
    }

    console.log(`bundle entries: ${entries.length}`);
    console.log(
        'sanity checks passed: manifest.json at root, dist/index.js, @cloud-connectors/core present, ' +
            `@modelcontextprotocol present, no src/ or .ts files, native-binding policy ok for ${targetPlatform}, no .env/.npmrc`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
