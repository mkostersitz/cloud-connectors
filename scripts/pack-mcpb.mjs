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
 * Usage:
 *   node scripts/pack-mcpb.mjs <package-dir-name>
 *   e.g. node scripts/pack-mcpb.mjs windows-live-connector
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

function run(cmd, args, opts = {}) {
    console.log(`\n> ${cmd} ${args.join(' ')}${opts.cwd ? `  (cwd: ${opts.cwd})` : ''}`);
    execFileSync(cmd, args, { stdio: 'inherit', shell: isWindows, ...opts });
}

function fail(message) {
    console.error(`\npack-mcpb: ${message}`);
    process.exit(1);
}

async function main() {
    const targetName = process.argv[2];
    if (!targetName) {
        fail('Usage: node scripts/pack-mcpb.mjs <package-dir-name>  (e.g. windows-live-connector)');
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

    cpSync(manifestPath, path.join(stagingDir, 'manifest.json'));
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
    delete stagedPkg.devDependencies;
    delete stagedPkg.scripts;
    writeFileSync(path.join(stagingDir, 'package.json'), `${JSON.stringify(stagedPkg, null, 2)}\n`, 'utf-8');

    // ---- 4. npm install --omit=dev in staging: real, non-hoisted node_modules ---------
    console.log('\n=== Step 4/6: npm install --omit=dev in staging ===');
    run('npm', ['install', '--omit=dev'], { cwd: stagingDir });

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

    // Windows-native-binding check: @azure/msal-node-extensions ships per-platform native
    // bindings (DPAPI support on Windows) fetched at install time - confirm they made it
    // into the staging install, since a bundle without them silently falls back to a
    // plaintext token cache.
    const mnePkgDir = path.join(stagingDir, 'node_modules', '@azure', 'msal-node-extensions');
    if (existsSync(mnePkgDir)) {
        const dpapiHits = findFiles(path.join(mnePkgDir, 'bin'), (name) => name === 'dpapi.node');
        if (isWindows) {
            if (dpapiHits.length === 0) {
                fail('staging node_modules/@azure/msal-node-extensions/bin has no dpapi.node - DPAPI support would be missing from the bundle');
            } else {
                console.log(`DPAPI native binding present: ${dpapiHits.map((p) => path.relative(stagingDir, p)).join(', ')}`);
            }
        }
    } else {
        console.log('note: @azure/msal-node-extensions not present in staging (not a dependency of this package)');
    }

    // ---- 4b. Boot the staged server: catches missing/broken node_modules before pack ---
    console.log('\n=== Step 4b: smoke-test the staged server ===');
    await smokeTestStagedServer(stagingDir);

    // ---- 5. Pack with the mcpb CLI -----------------------------------------------------
    console.log('\n=== Step 5/6: mcpb pack ===');
    const bundleDir = path.join(ROOT, 'dist-bundle');
    mkdirSync(bundleDir, { recursive: true });
    const outputPath = path.join(bundleDir, `${targetName}-${pkg.version}.mcpb`);
    run('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', stagingDir, outputPath], { cwd: ROOT });

    if (!existsSync(outputPath)) {
        fail(`mcpb pack did not produce ${outputPath}`);
    }

    // ---- 6. Sanity-check the produced bundle ------------------------------------------
    console.log('\n=== Step 6/6: sanity-check the bundle ===');
    sanityCheckBundle(outputPath);

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
function sanityCheckBundle(mcpbPath) {
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

    if (problems.length > 0) {
        fail(`bundle sanity check failed:\n  - ${problems.join('\n  - ')}`);
    }

    console.log(`bundle entries: ${entries.length}`);
    console.log('sanity checks passed: manifest.json at root, dist/index.js, @cloud-connectors/core present, @modelcontextprotocol present, no src/ or .ts files');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
