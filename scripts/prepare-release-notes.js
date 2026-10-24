#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { getVersionNotes, meaningfulReleaseNotes, normalizeVersion } = require('../lib/releaseChangelog');

const tag = process.argv[2];
const output = process.argv[3];
if (!/^v?\d+\.\d+\.\d+$/.test(tag || '') || !output) {
  console.error('Usage: node scripts/prepare-release-notes.js vX.Y.Z <output-file>');
  process.exit(2);
}
const markdown = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const section = getVersionNotes(markdown, tag);
if (!meaningfulReleaseNotes(section)) {
  console.error('No actual changelog entries found for ' + tag + '. Add them to CHANGELOG.md before publishing.');
  process.exit(1);
}
const version = 'v' + normalizeVersion(tag);
const notes = '## What changed in ' + version + '\n\n' + section.trim() + '\n';
fs.writeFileSync(output, notes, 'utf8');
console.log('Prepared substantive release notes for ' + version + ' (' + section.split(/\r?\n/).length + ' lines)');
