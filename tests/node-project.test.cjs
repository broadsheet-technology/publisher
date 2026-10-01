const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const action = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load_file(".github/actions/node-project/action.yml"))'], {cwd: root, encoding: 'utf8'}));

function fixture(t, failing = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-node-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const env = {...process.env, LC_ALL: 'C', npm_config_cache: path.join(dir, '.npm-cache'), npm_config_offline: 'true'};
  const git = (...args) => execFileSync('git', args, {cwd: dir, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Publisher Test');
  git('config', 'user.email', 'publisher@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  const pkg = {name: 'fixture', version: '0.0.0', private: true, scripts: {
    test: failing ? 'node -e "process.exit(1)"' : 'node -e "require(\'node:fs\').writeFileSync(\'tested\', require(\'./package.json\').version)"',
    build: 'node -e "require(\'node:fs\').writeFileSync(\'built\', require(\'./package.json\').version)"',
  }};
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: {'': {name: pkg.name, version: pkg.version}}}));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.npm-cache\ntested\nbuilt\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  function prepare(version, test) {
    for (const step of action.runs.steps.filter(step => step.run)) {
      if (step.if && !new Function('inputs', `return (${step.if})`)({version, test: String(test)})) continue;
      const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run],
        {cwd: dir, env: {...env, RELEASE_VERSION: version, PUBLISHER_ACTION_PATH: path.join(root, '.github/actions/node-project')}, encoding: 'utf8'});
      if (result.status !== 0) return {step: step.name, ...result};
    }
    return {status: 0};
  }
  return {dir, env, git, prepare};
}

test('release preparation bumps both version files before tests/build, and image tags use the release commit', t => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  const result = f.prepare('v1.0.0', true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, 'tested'), 'utf8'), 'v1.0.0');
  assert.equal(fs.readFileSync(path.join(f.dir, 'built'), 'utf8'), 'v1.0.0');
  const lock = JSON.parse(fs.readFileSync(path.join(f.dir, 'package-lock.json')));
  assert.equal(lock.version, 'v1.0.0');
  assert.equal(lock.packages[''].version, 'v1.0.0');
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('tag', '--list'), '');
  f.git('add', 'package.json', 'package-lock.json');
  f.git('commit', '-m', 'release: v1.0.0');
  const sha = f.git('rev-parse', 'HEAD');
  const output = path.join(f.dir, 'outputs');
  execFileSync('node', [path.join(root, 'scripts/images.cjs'), 'tags'], {cwd: f.dir,
    env: {...f.env, IMAGE: 'ghcr.io/org/app', TAGS: '', GITHUB_OUTPUT: output}});
  const tags = fs.readFileSync(output, 'utf8');
  assert.equal(tags, `tags=ghcr.io/org/app:${sha},ghcr.io/org/app:v1.0.0,ghcr.io/org/app:latest\n`);
  assert.ok(!tags.includes(before));
});

test('image preparation builds without changing version or running tests', t => {
  const f = fixture(t, true);
  const result = f.prepare('', false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.dir, 'built'), 'utf8'), '0.0.0');
  assert.equal(fs.existsSync(path.join(f.dir, 'tested')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'package.json'))).version, '0.0.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'package-lock.json'))).version, '0.0.0');
});

test('failed tests stop preparation before build and publication', t => {
  const f = fixture(t, true);
  const head = f.git('rev-parse', 'HEAD');
  const result = f.prepare('v1.0.0', true);
  assert.notEqual(result.status, 0);
  assert.equal(result.step, 'Run tests');
  assert.equal(fs.existsSync(path.join(f.dir, 'built')), false);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('tag', '--list'), '');
});

test('semantic version selection ignores prerelease/non-semantic tags and preserves release:none policy', t => {
  const f = fixture(t);
  for (const tag of ['v1.2.3', 'v2.0.0-rc.1', 'v2026.9.30.1', 'v01.9.0']) f.git('tag', tag);
  const output = path.join(f.dir, 'version');
  for (const [intent, expected] of [['major', '2.0.0'], ['minor', '1.3.0'], ['patch', '1.2.4'], ['none', '1.2.4']]) {
    fs.writeFileSync(output, '');
    execFileSync('node', [path.join(root, 'scripts/versions.cjs')], {cwd: f.dir,
      env: {...f.env, VERSIONING: 'semantic', RELEASE_INTENT: `release:${intent}`, GITHUB_OUTPUT: output}});
    assert.equal(fs.readFileSync(output, 'utf8'), `version=v${expected}\ntag=v${expected}\n`);
  }
});

test('version updates preserve dependency versions and reject invalid input before writing', t => {
  const f = fixture(t);
  const pkgFile = path.join(f.dir, 'package.json');
  const lockFile = path.join(f.dir, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile));
  pkg.dependencies = {dependency: '^1.0.0'};
  const lock = JSON.parse(fs.readFileSync(lockFile));
  lock.packages[''].dependencies = pkg.dependencies;
  lock.packages['node_modules/dependency'] = {version: '1.0.0', resolved: 'https://example.invalid/dependency'};
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  execFileSync('node', [path.join(root, 'scripts/package-version.cjs'), 'v2.0.0'], {cwd: f.dir});
  assert.deepEqual(JSON.parse(fs.readFileSync(pkgFile)), {...pkg, version: 'v2.0.0'});
  lock.version = 'v2.0.0';
  lock.packages[''].version = 'v2.0.0';
  assert.deepEqual(JSON.parse(fs.readFileSync(lockFile)), lock);
  const before = [fs.readFileSync(pkgFile, 'utf8'), fs.readFileSync(lockFile, 'utf8')];
  const invalid = spawnSync('node', [path.join(root, 'scripts/package-version.cjs'), 'vv2.0.0'], {cwd: f.dir});
  assert.notEqual(invalid.status, 0);
  assert.deepEqual([fs.readFileSync(pkgFile, 'utf8'), fs.readFileSync(lockFile, 'utf8')], before);
});

test('calendar versions survive install, test, build, prune, lockfiles, and image tagging', t => {
  const f = fixture(t);
  const version = 'v26.10.1.1';
  const result = f.prepare(version, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'package.json'))).version, version);
  const lock = JSON.parse(fs.readFileSync(path.join(f.dir, 'package-lock.json')));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
  for (const file of ['tested', 'built']) assert.equal(fs.readFileSync(path.join(f.dir, file), 'utf8'), version);
  const output = path.join(f.dir, 'outputs');
  execFileSync('node', [path.join(root, 'scripts/images.cjs'), 'tags'], {cwd: f.dir,
    env: {...f.env, IMAGE: 'ghcr.io/org/app', GITHUB_OUTPUT: output}});
  assert.equal(fs.readFileSync(output, 'utf8'), `tags=ghcr.io/org/app:${f.git('rev-parse', 'HEAD')},ghcr.io/org/app:${version},ghcr.io/org/app:latest\n`);
});
