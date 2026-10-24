'use strict';

// CHANGELOG.md is the release-notes source of truth. GitHub's automatic notes
// can be only a compare link when the release has no associated pull requests.
function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
}

function getVersionNotes(markdown, version) {
  if (typeof markdown !== 'string' || !markdown) return '';
  const sought = normalizeVersion(version);
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let capturing = false, collected = [];
  for (const line of lines) {
    const heading = line.match(/^##\s+(v?\d+\.\d+\.\d+)(?=\s|$)/i);
    if (heading) {
      if (capturing) break;
      capturing = normalizeVersion(heading[1]) === sought;
    } else if (capturing) {
      collected.push(line);
    }
  }
  return collected.join('\n').trim();
}

function meaningfulReleaseNotes(body) {
  if (typeof body !== 'string') return false;
  const lines = body.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.some(line => {
    if (/^#{1,6}\s*\S/.test(line)) return false;
    if (/^\*\*full changelog\*\*\s*:?\s*https?:\/\/\S+\s*$/i.test(line)) return false;
    if (/^full changelog\s*:?\s*https?:\/\/\S+\s*$/i.test(line)) return false;
    if (/^https?:\/\/\S+$/i.test(line)) return false;
    if (/^\[.{1,80}\]\(https?:\/\/[^)]+\)$/i.test(line)) return false;
    if (/^release v?\d+\.\d+\.\d+\s*[-:]?\s*see (?:git log|full changelog|github)\b/i.test(line)) return false;
    // A real description or an actual listed change counts.
    return line.replace(/^[\-*]\s*/, '').length >= 12;
  });
}

function collectUpdateNotes({releases=[], current, latest, changelogMarkdown='', compareVersions}) {
  if (typeof compareVersions !== 'function') throw new Error('compareVersions is required');
  const versions = new Map();
  for (const release of releases) {
    const version = normalizeVersion(release.tag_name || release.version || release.name);
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (compareVersions(version, current) <= 0 || compareVersions(version, latest) > 0) continue;
    const body = String(release.body || '').trim();
    versions.set(version, {version:'v'+version, body: meaningfulReleaseNotes(body) ? body : ''});
  }
  // A CHANGELOG section can be present even if the GitHub Release record is
  // missing. Include it when it belongs to the upgrade interval.
  for (const match of String(changelogMarkdown).matchAll(/^##\s+(v?\d+\.\d+\.\d+)(?=\s|$)/gim)) {
    const version = normalizeVersion(match[1]);
    if (compareVersions(version,current)<=0 || compareVersions(version,latest)>0) continue;
    const notes=getVersionNotes(changelogMarkdown,version);
    if (!meaningfulReleaseNotes(notes)) continue;
    const existing=versions.get(version);
    if (!existing || !existing.body) versions.set(version,{version:'v'+version,body:notes});
  }
  return [...versions.values()].filter(entry=>meaningfulReleaseNotes(entry.body))
    .sort((a,b)=>compareVersions(b.version,a.version));
}

module.exports = {normalizeVersion, getVersionNotes, meaningfulReleaseNotes, collectUpdateNotes};
