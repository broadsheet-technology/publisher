const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function run(cmd, args, cwd, env = {}, ok = true) {
  const result = spawnSync(cmd, args, {cwd, encoding: 'utf8', env: {...process.env, GIT_TERMINAL_PROMPT: '0', ...env}});
  if (ok) assert.equal(result.status, 0, `${cmd} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

// Exercise the actual workflow commit/promotion/tag commands, not copies.
const steps = JSON.parse(run('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(YAML.load_file(".github/workflows/publish-strategy.yml").fetch("jobs").fetch("publish").fetch("steps"))'], root).stdout);

function repository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-git-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const remote = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  fs.symlinkSync(root, path.join(dir, '.publisher'));
  run('git', ['init', '--bare', remote], dir);
  run('git', ['init', '-b', 'main'], work);
  const git = (...args) => run('git', args, work).stdout.trim();
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('remote', 'add', 'origin', remote);
  const commit = (file, value) => {
    fs.writeFileSync(path.join(work, file), value);
    git('add', file);
    git('commit', '-m', `change ${file}`);
    return git('rev-parse', 'HEAD');
  };
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({name: 'fixture', version: 'v0.0.0'}));
  fs.writeFileSync(path.join(work, 'package-lock.json'), JSON.stringify({version: 'v0.0.0', lockfileVersion: 3, packages: {'': {version: 'v0.0.0'}}}));
  git('add', 'package.json', 'package-lock.json');
  commit('base.txt', 'base\n');
  git('push', 'origin', 'main');
  const base = git('rev-parse', 'HEAD');
  function candidate(number, file = `pr-${number}.txt`, value = `${number}\n`, squash = false) {
    const branch = `merge/${number}/feature/nested`;
    git('checkout', '-B', `source-${number}`, base);
    commit(file, value);
    git('checkout', '-B', branch, base);
    if (squash) {
      git('merge', '--squash', `source-${number}`);
      git('commit', '-m', `feat: PR #${number}`);
    } else {
      git('merge', '--no-ff', '--no-edit', `source-${number}`);
    }
    const sha = git('rev-parse', 'HEAD');
    git('push', 'origin', branch);
    return {branch, sha, env: {INTEGRATION_BRANCH: branch, SOURCE_MERGE: sha, MERGE_SHA: sha, RELEASE_BRANCH: 'main', SOURCE_PR: String(number), SOURCE_TITLE: 'feat: handle $(literal) `title`'}};
  }
  function script(name, env, ok = true) {
    return run('bash', [path.join(root, 'scripts', name)], work, {GITHUB_OUTPUT: output, ...env}, ok);
  }
  function workflowStep(name, env, ok = true) {
    const step = steps.find(step => step.name === name);
    assert.ok(step, name);
    return run('bash', ['-e', '-c', step.run], work, {...env, GITHUB_WORKSPACE: dir}, ok);
  }
  const output = path.join(dir, 'outputs');
  function release(candidate) {
    git('checkout', '--detach', candidate.sha);
    fs.writeFileSync(output, '');
    script('prepare-publication.sh', {...candidate.env, GITHUB_OUTPUT: output});
    script('calculate-version.sh', {...candidate.env, RELEASE_INTENT: 'release:patch', GITHUB_OUTPUT: output});
    const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
    run('node', [path.join(root, 'scripts/package-version.cjs'), values.version], work);
    const env = {...candidate.env, RELEASE_BASE: values.base, RELEASE_VERSION: values.version, RELEASE_TAG: values.tag, GITHUB_OUTPUT: output};
    workflowStep('Create release commit', env);
    workflowStep('Promote release commit to main', env);
    workflowStep('Tag release commit', env);
    return {...values, sha: git('rev-parse', 'HEAD')};
  }
  return {dir, work, git, commit, base, candidate, script, release, workflowStep, output};
}

test('two candidates from one main preserve both changes, refresh tags and delete only the owning ref', t => {
  const f = repository(t);
  const first = f.candidate(1);
  const second = f.candidate(2);
  const release1 = f.release(first);
  assert.equal(release1.version, 'v0.0.1');
  assert.equal(f.git('rev-parse', 'HEAD^'), f.base);
  assert.equal(f.git('rev-list', '--count', `${f.base}..HEAD`), '1');
  assert.equal(f.git('show', '-s', '--format=%an <%ae>|%cn <%ce>'), 'Test <test@example.com>|Test <test@example.com>');
  assert.equal(f.git('show', '-s', '--format=%s'), 'feat: handle $(literal) `title` (#1)');
  assert.equal(f.git('show', '-s', '--format=%B'),
    `feat: handle $(literal) \`title\` (#1)\n\npr: #1\nmerge: ${first.sha}\nversion: v0.0.1`);
  assert.equal(f.git('show', '-s', '--format=%(trailers:key=version,valueonly)'), 'v0.0.1');
  assert.equal(f.git('show', '-s', '--format=%(trailers:key=merge,valueonly)'), first.sha);
  assert.equal(JSON.parse(f.git('show', 'HEAD:package.json')).version, 'v0.0.1');
  const lock = JSON.parse(f.git('show', 'HEAD:package-lock.json'));
  assert.equal(lock.version, 'v0.0.1');
  assert.equal(lock.packages[''].version, 'v0.0.1');
  assert.equal(f.git('rev-parse', `${release1.tag}^{commit}`), release1.sha);
  assert.notEqual(run('git', ['merge-base', '--is-ancestor', first.sha, 'HEAD'], f.work, {}, false).status, 0);
  f.script('delete-integration-branch.sh', first.env);
  assert.equal(f.git('ls-remote', '--refs', 'origin', `refs/heads/${first.branch}`), '');
  assert.ok(f.git('ls-remote', '--refs', 'origin', `refs/heads/${second.branch}`));
  // Simulate a queued checkout that has not seen the newly released tag.
  f.git('tag', '-d', release1.tag);
  const release2 = f.release(second);
  assert.equal(release2.version, 'v0.0.2');
  assert.equal(f.git('rev-list', '--count', `${f.base}..HEAD`), '2');
  assert.equal(f.git('rev-parse', 'HEAD^'), release1.sha);
  f.git('merge-base', '--is-ancestor', release1.sha, release2.sha);
  assert.equal(fs.readFileSync(path.join(f.work, 'pr-1.txt'), 'utf8'), '1\n');
  assert.equal(fs.readFileSync(path.join(f.work, 'pr-2.txt'), 'utf8'), '2\n');
  assert.equal(f.git('rev-parse', 'origin/main'), release2.sha);
  f.script('delete-integration-branch.sh', second.env);
  f.git('checkout', '--detach', first.sha);
  assert.notEqual(f.script('revert-integration-merge.sh', first.env, false).status, 0);
});

test('conflicting main changes stop publication and retain the integration branch', t => {
  const f = repository(t);
  const c = f.candidate(1, 'base.txt', 'candidate\n');
  f.git('checkout', 'main');
  const main = f.commit('base.txt', 'released\n');
  f.git('push', 'origin', 'main');
  f.git('checkout', '--detach', c.sha);
  assert.notEqual(f.script('prepare-publication.sh', c.env, false).status, 0);
  assert.equal(f.git('rev-parse', 'origin/main'), main);
  assert.ok(f.git('ls-remote', '--refs', 'origin', `refs/heads/${c.branch}`));
});

test('preparation refuses a branch that changed after source identification', t => {
  const f = repository(t);
  const c = f.candidate(1);
  const changed = f.commit('additional-work.txt', 'later\n');
  f.git('push', 'origin', c.branch);
  f.git('checkout', '--detach', c.sha);
  assert.notEqual(f.script('prepare-publication.sh', c.env, false).status, 0);
  assert.equal(f.git('rev-parse', 'origin/main'), f.base);
  assert.match(f.git('ls-remote', '--refs', 'origin', `refs/heads/${c.branch}`), new RegExp(`^${changed}`));
});

test('promotion refuses an external main update after validation', t => {
  const f = repository(t);
  const c = f.candidate(1);
  f.git('checkout', '--detach', c.sha);
  f.script('prepare-publication.sh', c.env);
  f.workflowStep('Create release commit', {...c.env, RELEASE_BASE: f.base, RELEASE_VERSION: 'v0.0.1', GITHUB_OUTPUT: f.output});
  const prepared = f.git('rev-parse', 'HEAD');
  f.git('checkout', 'main');
  const other = f.commit('external.txt', 'external\n');
  f.git('push', 'origin', 'main');
  f.git('checkout', '--detach', prepared);
  assert.notEqual(f.workflowStep('Promote release commit to main', {...c.env, GITHUB_OUTPUT: f.output}, false).status, 0);
  assert.equal(f.git('rev-parse', 'origin/main'), other);
});

test('cleanup lease preserves changed integration refs', t => {
  const f = repository(t);
  const c = f.candidate(1);
  f.release(c);
  f.git('checkout', c.branch);
  const changed = f.commit('new-work.txt', 'new\n');
  f.git('push', 'origin', c.branch);
  assert.notEqual(f.script('delete-integration-branch.sh', c.env, false).status, 0);
  assert.match(f.git('ls-remote', '--refs', 'origin', `refs/heads/${c.branch}`), new RegExp(`^${changed}`));
});

test('recovery reverts only the failed PR branch; promoted candidates cannot be recovered or republished', t => {
  const f = repository(t);
  const failed = f.candidate(1);
  const other = f.candidate(2);
  f.git('checkout', '--detach', failed.sha);
  f.script('revert-integration-merge.sh', failed.env);
  assert.equal(fs.existsSync(path.join(f.work, 'pr-1.txt')), false);
  assert.equal(f.git('rev-parse', 'origin/main'), f.base);
  assert.match(f.git('ls-remote', '--refs', 'origin', `refs/heads/${other.branch}`), new RegExp(`^${other.sha}`));
  f.release(other);
  f.git('checkout', '--detach', other.sha);
  assert.notEqual(f.script('revert-integration-merge.sh', other.env, false).status, 0);
  assert.notEqual(f.script('prepare-publication.sh', other.env, false).status, 0);
});

test('an integration squash produces one developer commit containing the validated tree', t => {
  const f = repository(t);
  const c = f.candidate(1, 'squashed.txt', 'squashed\n', true);
  const sourceAuthor = f.git('show', '-s', '--format=%an <%ae>');
  const sourceDate = f.git('show', '-s', '--format=%aI');
  const release = f.release(c);
  assert.equal(f.git('rev-list', '--count', `${f.base}..HEAD`), '1');
  assert.equal(f.git('show', '-s', '--format=%an <%ae>'), sourceAuthor);
  assert.equal(f.git('show', '-s', '--format=%cn <%ce>'), sourceAuthor);
  assert.equal(f.git('show', '-s', '--format=%aI'), sourceDate);
  assert.equal(f.git('show', 'HEAD:squashed.txt'), 'squashed');
  assert.equal(f.git('show', '-s', '--format=%(trailers:key=version,valueonly)'), release.version);
});

test('legacy publication is recognized by ancestry without a merge trailer', t => {
  const f = repository(t);
  const c = f.candidate(1);
  f.git('push', 'origin', 'HEAD:main');
  for (const script of ['prepare-publication.sh', 'revert-integration-merge.sh']) {
    const result = f.script(script, c.env, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /already on the release branch|Candidate was promoted/);
  }
});
