#!/usr/bin/env node
/*
  Simple release helper - local script to bump version, create changelog entry,
  commit, push, tag, build and create release via `gh`.

  USAGE: node scripts/release-bump.js

  This script is meant to be run locally. It is added to .gitignore by default so
  it won't be committed. It requires `git` and `gh` CLI to be authenticated.
*/

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

function readJSON(p){ return JSON.parse(fs.readFileSync(p,'utf8')); }
function writeJSON(p,obj){ fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }

function semverBump(version, kind){
  const parts = version.split('.').map(n=>parseInt(n,10)||0);
  if (kind === 'major') { parts[0]++; parts[1]=0; parts[2]=0; }
  if (kind === 'minor') { parts[1]++; parts[2]=0; }
  if (kind === 'patch') { parts[2]++; }
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

async function prompt(q){
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans.trim()); }));
}

(async () => {
  try {
    const p = path.resolve(__dirname, '..', 'package.json');
    const pkg = readJSON(p);
    console.log('Current version:', pkg.version);

    let kind = (await prompt('Bump type (major/minor/patch): ')).toLowerCase();
    if (!['major','minor','patch'].includes(kind)) { console.log('Invalid bump type'); process.exit(1); }
    const newVer = semverBump(pkg.version, kind);
    console.log('New version will be:', newVer);

    const commitMsg = await prompt('Commit message: ');
    if (!commitMsg) { console.log('Aborting: commit message required'); process.exit(1); }

    // Update package.json
    pkg.version = newVer;
    writeJSON(p, pkg);

    // Prepend changelog entry
    const changelogPath = path.resolve(__dirname, '..', 'CHANGELOG.md');
    let changelog = '';
    try { changelog = fs.readFileSync(changelogPath, 'utf8'); } catch (e) { changelog = '# Changelog\n\n'; }
    const header = `## ${newVer} - ${new Date().toISOString().split('T')[0]}\n\n- ${commitMsg}\n\n`;
    changelog = changelog.replace(/^# Changelog\n\n/, `# Changelog\n\n${header}`);
    fs.writeFileSync(changelogPath, changelog, 'utf8');

    // Git commit, tag, push
    execSync(`git add package.json CHANGELOG.md`, { stdio: 'inherit' });
    execSync(`git commit -m "${commitMsg}"`, { stdio: 'inherit' });
    execSync(`git push origin main`, { stdio: 'inherit' });
    execSync(`git tag -a v${newVer} -m "Release v${newVer}"`, { stdio: 'inherit' });
    execSync(`git push origin v${newVer}`, { stdio: 'inherit' });

<<<<<<< HEAD
    // Ensure icon exists (so Windows taskbar and installer use it)
    try {
      console.log('Generating icon...');
      execSync('npm run make-icon', { stdio: 'inherit' });
    } catch (e) { console.warn('make-icon failed or not available:', e.message || e); }

=======
>>>>>>> origin/main
    // Build
    execSync('npm run build', { stdio: 'inherit' });

    // Find artifacts
    const dist = path.resolve(__dirname, '..', 'dist');
    const files = fs.readdirSync(dist);
    const exe = files.find(f=>f.toLowerCase().endsWith('.exe'));
    if (!exe) {
      console.error('No .exe found in dist/ to upload');
      process.exit(1);
    }
    // Prefer a blockmap that contains the exe base name, otherwise fallback to first .blockmap
    const exeBase = exe.replace(/\.exe$/i,'').toLowerCase();
    let blockmap = files.find(f => f.toLowerCase().endsWith('.blockmap') && f.toLowerCase().includes(exeBase));
    if (!blockmap) blockmap = files.find(f => f.toLowerCase().endsWith('.blockmap')) || null;

    // Create release with gh — quote paths to handle spaces
    const notes = commitMsg.replace(/\"/g,'\\\"');
    const exePath = `"${path.join(dist,exe)}"`;
    const blockmapPath = blockmap ? `"${path.join(dist,blockmap)}"` : '';
    execSync(`gh release create v${newVer} ${exePath} ${blockmapPath} --title "v${newVer}" --notes "${notes}"`, { stdio: 'inherit' });

    console.log('Release v' + newVer + ' created successfully');
  } catch (e) {
    console.error('Release script failed:', e);
    process.exit(1);
  }
})();
