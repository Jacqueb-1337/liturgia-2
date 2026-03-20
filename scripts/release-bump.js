#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function bumpVersion(version, type) {
  const parts = version.split('.').map(Number);
  if (type === 'major') {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  } else if (type === 'minor') {
    parts[1]++;
    parts[2] = 0;
  } else if (type === 'patch') {
    parts[2]++;
  }
  return parts.join('.');
}

function getChangelogEntries() {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    return [];
  }
  
  const content = fs.readFileSync(changelogPath, 'utf8');
  const lines = content.split('\n');
  const entries = [];
  
  let inFirstSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      if (!inFirstSection) {
        inFirstSection = true;
        continue;
      } else {
        break;
      }
    }
    if (inFirstSection && lines[i].trim().startsWith('- ')) {
      entries.push(lines[i].trim());
    }
  }
  
  return entries;
}

function updateChangelog(version, entries) {
  const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  const date = new Date().toISOString().split('T')[0];
  
  let content = '';
  if (fs.existsSync(changelogPath)) {
    content = fs.readFileSync(changelogPath, 'utf8');
  } else {
    content = '# Changelog\n\n';
  }
  
  const newEntry = `## ${version} - ${date}\n\n${entries.map(e => e).join('\n')}\n\n`;
  
  const lines = content.split('\n');
  const headerEndIndex = lines.findIndex((line, i) => i > 0 && line.startsWith('## '));
  
  if (headerEndIndex === -1) {
    content += newEntry;
  } else {
    lines.splice(headerEndIndex, 0, newEntry);
    content = lines.join('\n');
  }
  
  fs.writeFileSync(changelogPath, content);
  console.log(`✓ Updated CHANGELOG.md`);
}

function generateCommitMessage(entries) {
  if (entries.length === 0) return 'release: version bump';
  
  const types = new Set();
  const descriptions = [];
  
  entries.forEach(entry => {
    const match = entry.match(/^- (feat|fix|refactor|docs|chore|perf|test|style):\s*(.+)$/);
    if (match) {
      types.add(match[1]);
      descriptions.push(match[2]);
    }
  });
  
  if (types.size === 0) return 'release: version bump';
  
  const primaryType = Array.from(types)[0];
  const summary = descriptions[0] || 'updates';
  
  return `${primaryType}: ${summary}`;
}

async function main() {
  console.log('\n📦 Liturgia Release Script\n');
  
  const packagePath = path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const currentVersion = pkg.version;
  
  console.log(`Current version: ${currentVersion}\n`);
  
  const bumpType = await question('Bump type (major/minor/patch): ');
  if (!['major', 'minor', 'patch'].includes(bumpType)) {
    console.error('Invalid bump type. Must be major, minor, or patch.');
    rl.close();
    process.exit(1);
  }
  
  const newVersion = bumpVersion(currentVersion, bumpType);
  console.log(`\nNew version will be: ${newVersion}\n`);
  
  console.log('Enter release notes (one per line, format: "type: description")');
  console.log('Example: feat: add Bible XML export');
  console.log('Example: fix: resolve crash on startup');
  console.log('Press Enter on empty line when done.\n');
  
  const entries = [];
  while (true) {
    const entry = await question('  - ');
    if (!entry.trim()) break;
    
    if (!entry.match(/^(feat|fix|refactor|docs|chore|perf|test|style):\s*.+$/)) {
      console.log('    ⚠️  Entry should start with type: (feat:, fix:, etc.)');
      continue;
    }
    
    entries.push(`- ${entry}`);
  }
  
  if (entries.length === 0) {
    console.log('\n⚠️  No release notes entered. Continue anyway? (y/N)');
    const confirm = await question('> ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('Aborted.');
      rl.close();
      process.exit(0);
    }
  }
  
  console.log('\n📝 Release Summary:');
  console.log(`   Version: ${currentVersion} → ${newVersion}`);
  console.log(`   Changes:`);
  entries.forEach(e => console.log(`     ${e}`));
  
  const proceed = await question('\nProceed with release? (y/N): ');
  if (proceed.toLowerCase() !== 'y') {
    console.log('Aborted.');
    rl.close();
    process.exit(0);
  }
  
  console.log('\n🔨 Building release...\n');
  
  pkg.version = newVersion;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✓ Updated package.json to ${newVersion}`);
  
  updateChangelog(newVersion, entries);
  
  try {
    execSync('git add package.json CHANGELOG.md', { stdio: 'inherit' });
    
    const commitMsg = generateCommitMessage(entries);
    execSync(`git commit -m "${commitMsg}"`, { stdio: 'inherit' });
    console.log(`✓ Created commit: "${commitMsg}"`);
    
    const tag = `v${newVersion}`;
    execSync(`git tag ${tag}`, { stdio: 'inherit' });
    console.log(`✓ Created tag: ${tag}`);
    
    const push = await question('\nPush to remote? (Y/n): ');
    if (push.toLowerCase() !== 'n') {
      const branch = execSync('git branch --show-current').toString().trim();
      execSync(`git push origin ${branch}`, { stdio: 'inherit' });
      execSync(`git push origin ${tag}`, { stdio: 'inherit' });
      console.log(`\n✓ Pushed to origin/${branch} and tag ${tag}`);
      console.log(`\n🚀 CI build will start shortly for ${tag}`);
    }
    
    console.log('\n✅ Release complete!\n');
  } catch (error) {
    console.error('\n❌ Error during release:', error.message);
    process.exit(1);
  }
  
  rl.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  rl.close();
  process.exit(1);
});
