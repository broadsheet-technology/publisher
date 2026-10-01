const {test} = require('node:test');
const assert = require('node:assert/strict');
const {nextVersion, releaseVersion} = require('../scripts/versions.cjs');

const calendar = (now, tags = [], timeZone = 'UTC') => nextVersion({
  now: new Date(now), tags, timeZone,
});

test('calendar versions are the default, start at one, increment numerically, and reset for each date', () => {
  assert.equal(calendar('2026-10-01T12:00:00Z', ['v1.0.0']), 'v26.10.1.1');
  assert.equal(calendar('2026-10-01T12:00:00Z', ['v26.10.1.1']), 'v26.10.1.2');
  assert.equal(calendar('2026-10-02T12:00:00Z', ['v26.10.1.1', 'v26.10.1.2']), 'v26.10.2.1');
  assert.equal(calendar('2026-10-01T12:00:00Z', ['v26.10.1.9', 'v26.10.1.2', 'v26.10.1.10']), 'v26.10.1.11');
  assert.equal(calendar('2006-01-03T12:00:00Z'), 'v06.1.3.1');
  assert.equal(calendar('2027-01-01T12:00:00Z', ['v26.12.31.99']), 'v27.1.1.1');
});

test('calendar counters ignore semantic, malformed, prerelease, and other-day tags', () => {
  const tags = ['v100.0.0', 'v26.10.1.1', 'v26.10.1.20-rc.1', 'v26.10.1.030',
    'v26.10.01.40', 'v2026.10.1.50', 'v26.10.2.60', 'v26.10.1.0'];
  assert.equal(calendar('2026-10-01T12:00:00Z', tags), 'v26.10.1.2');
});

test('calendar days follow the selected timezone, including daylight saving boundaries', () => {
  const tags = ['v26.10.1.2'];
  assert.equal(calendar('2026-10-02T04:59:59Z', tags, 'America/Chicago'), 'v26.10.1.3');
  assert.equal(calendar('2026-10-02T05:00:00Z', tags, 'America/Chicago'), 'v26.10.2.1');
  assert.equal(calendar('2026-10-02T04:59:59Z', tags, 'UTC'), 'v26.10.2.1');
  assert.equal(calendar('2026-11-02T05:59:59Z', [], 'America/Chicago'), 'v26.11.1.1');
  assert.equal(calendar('2026-11-02T06:00:00Z', [], 'America/Chicago'), 'v26.11.2.1');
  assert.throws(() => calendar('2026-10-01T12:00:00Z', [], 'invalid/timezone'), RangeError);
});

test('explicit semantic versioning ignores calendar versions', () => {
  for (const [intent, expected] of [['major', 'v3.0.0'], ['minor', 'v2.11.0'], ['patch', 'v2.10.4'], ['none', 'v2.10.4']]) {
    assert.equal(nextVersion({versioning: 'semantic', tags: ['v2.9.9', 'v2.10.3', 'v26.10.1.9', 'v3.0.0-rc.1'], intent: `release:${intent}`}), expected);
  }
  assert.equal(nextVersion({versioning: 'semantic', tags: [], intent: 'release:major'}), 'v1.0.0');
  assert.throws(() => nextVersion({tags: [], versioning: 'typo'}), /Versioning/);
  assert.throws(() => nextVersion({versioning: 'semantic', tags: [], intent: ''}), /intent/);
});

test('package and image versions accept both conventions and reject invalid calendar dates', () => {
  for (const version of ['v26.10.1.1', 'v06.1.3.1', 'v28.2.29.1', 'v1.2.3', 'v1.2.3-rc.1']) {
    assert.equal(releaseVersion(version), version);
  }
  assert.equal(releaseVersion('1.2.3'), 'v1.2.3');
  for (const version of ['v26.2.29.1', 'v26.4.31.1', 'v26.0.1.1', 'v26.13.1.1',
    'v26.10.0.1', 'v26.10.01.1', 'v26.10.1.0', 'v26.10.1.01', 'v2026.10.1.1', 'vv26.10.1.1']) {
    assert.throws(() => releaseVersion(version), /Invalid package version/, version);
  }
});
