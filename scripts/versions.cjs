const fs = require('node:fs');
const {execFileSync} = require('node:child_process');

const semantic = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const calendar = /^v(\d{2})\.([1-9]|1[0-2])\.([1-9]|[12]\d|3[01])\.([1-9]\d*)$/;

function calendarVersion(value) {
  const parts = calendar.exec(value);
  if (!parts) return null;
  const [, year, month, day] = parts;
  const date = new Date(Date.UTC(2000 + Number(year), Number(month) - 1, Number(day)));
  return date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) ? parts : null;
}

function releaseVersion(value) {
  if (typeof value !== 'string') throw new Error('Invalid package version');
  const version = `v${value.replace(/^v/, '')}`;
  if (!calendarVersion(version) && !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/.test(version)) {
    throw new Error('Invalid package version');
  }
  return version;
}

function nextVersion({tags, versioning = 'calendar', intent, now = new Date(), timeZone = 'UTC'}) {
  if (versioning === 'calendar') {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, year: '2-digit', month: 'numeric', day: 'numeric',
    }).formatToParts(now).map(({type, value}) => [type, value]));
    const prefix = `v${parts.year}.${parts.month}.${parts.day}.`;
    let last = 0n;
    for (const tag of tags) {
      const match = calendarVersion(tag);
      if (match && tag.startsWith(prefix) && BigInt(match[4]) > last) last = BigInt(match[4]);
    }
    return `${prefix}${last + 1n}`;
  }
  if (versioning !== 'semantic') throw new Error('Versioning must be semantic or calendar');
  let current = [0n, 0n, 0n];
  for (const tag of tags) {
    const match = semantic.exec(tag);
    if (!match) continue;
    const candidate = match.slice(1).map(BigInt);
    const difference = candidate.findIndex((value, index) => value !== current[index]);
    if (difference !== -1 && candidate[difference] > current[difference]) current = candidate;
  }
  let [major, minor, patch] = current;
  switch (intent) {
    case 'release:major': major++; minor = 0n; patch = 0n; break;
    case 'release:minor': minor++; patch = 0n; break;
    case 'release:patch':
    case 'release:none': patch++; break;
    default: throw new Error('Unsupported semantic release intent');
  }
  return `v${major}.${minor}.${patch}`;
}

if (require.main === module) {
  const tags = execFileSync('git', ['tag', '--list', 'v*'], {encoding: 'utf8'}).trim().split('\n');
  const version = nextVersion({tags, versioning: process.env.VERSIONING || 'calendar',
    intent: process.env.RELEASE_INTENT, timeZone: process.env.VERSION_TIMEZONE || 'UTC'});
  const output = `version=${version}\ntag=${version}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}

module.exports = {releaseVersion, nextVersion};
