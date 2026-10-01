const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const {integrationBranch, route, refresh, validateBase, identifySource, validateRecovery, annotateRecovery, validateMetadata, releaseIntent, reportPublication} = require('../scripts/integration-branches.cjs');

const workflows = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(%w[pr-route pr-validate].to_h { |name| [name, YAML.load_file(".github/workflows/#{name}.yml")] })'],
  {cwd: path.resolve(__dirname, '..'), encoding: 'utf8'}));

test('router accepts metadata events only from pull_request_target', () => {
  const enabled = new Function('github', 'fromJSON', 'contains', `return (${workflows['pr-route'].jobs.route.if});`);
  for (const eventName of ['pull_request', 'pull_request_target', 'push']) {
    for (const action of ['opened', 'reopened', 'synchronize', 'edited', 'labeled', 'unlabeled', 'closed']) {
      for (const headRepo of ['org/publisher', 'fork/publisher']) {
        const github = {event_name: eventName, repository: 'org/publisher', event: {action, pull_request: {head: {repo: {full_name: headRepo}}}}};
        const expected = eventName === 'pull_request_target' && action !== 'closed';
        assert.equal(enabled(github, JSON.parse, (values, value) => values.includes(value)), expected, `${eventName}/${action}/${headRepo}`);
      }
    }
  }
});

test('metadata validation reads the routed base instead of the stale triggering event', async () => {
  const f = fixture();
  const current = pr(12, {title: 'feat: test routing', base: {ref: 'merge/12/feature/nested'}});
  f.github.rest.pulls.get = async () => ({data: current});
  const steps = workflows['pr-validate'].jobs.metadata.steps;
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  await new AsyncFunction('github', 'context', 'require', steps.find(step => step.name === 'Validate current pull request metadata').with.script)(
    f.github, f.context, () => ({validateMetadata}));
  assert.equal(f.context.payload.pull_request.base.ref, 'main');

});

function pr(number = 12, changes = {}) {
  return {number, state: 'open', merged: false, merged_at: null, merge_commit_sha: null, commits: 1,
    head: {ref: 'feature/nested'}, base: {ref: 'main'}, user: {type: 'User'}, labels: [{name: 'release:patch'}], ...changes};
}

function fixture(prs = [pr()]) {
  const refs = new Map([['heads/main', 'main-sha']]);
  const outputs = {};
  const warnings = [];
  const comments = [];
  const updates = [];
  const labels = [];
  const failures = [];
  const missing = () => Object.assign(new Error('Not found'), {status: 404});
  const github = {rest: {
    git: {
      getCommit: async () => ({data: {parents: [{sha: 'base'}, {sha: 'head'}]}}),
      getRef: async ({ref}) => {
        if (!refs.has(ref)) throw missing();
        return {data: {object: {sha: refs.get(ref)}}};
      },
      createRef: async ({ref, sha}) => {
        const key = ref.replace(/^refs\//, '');
        if (refs.has(key)) throw Object.assign(new Error('Already exists'), {status: 422});
        refs.set(key, sha);
      },
      updateRef: async args => {updates.push(args); refs.set(args.ref, args.sha);},
    },
    pulls: {
      get: async ({pull_number}) => ({data: prs.find(p => p.number === pull_number)}),
      list: async () => ({data: prs.filter(p => p.state === 'open')}),
      update: async ({pull_number, base, state}) => {
        const p = prs.find(p => p.number === pull_number);
        p.base.ref = base;
        if (state) p.state = state;
      },
    },
    issues: {
      createComment: async args => comments.push(args),
      addLabels: async args => labels.push(args),
    },
    repos: {listPullRequestsAssociatedWithCommit: async () => ({data: prs})},
  }, paginate: async (method, args) => (await method(args)).data};
  const core = {setOutput: (key, value) => {outputs[key] = value;}, info: () => {}, warning: message => warnings.push(message), setFailed: message => failures.push(message)};
  const context = {repo: {owner: 'org', repo: 'consumer'}, payload: {pull_request: prs[0]},
    ref: 'refs/heads/merge/12/feature/nested', sha: 'merge-sha', eventName: 'push', serverUrl: 'https://github.com', runId: 100};
  return {github, core, context, refs, outputs, warnings, comments, updates, labels, failures};
}

test('names preserve nested heads and isolate identical heads from different PRs', () => {
  assert.equal(integrationBranch(pr()), 'merge/12/feature/nested');
  assert.equal(integrationBranch(pr(13)), 'merge/13/feature/nested');
  for (const ref of ['', 'bad..name', 'bad[ref', 'bad.lock', '.hidden', 'bad/ref.']) {
    assert.throws(() => integrationBranch(pr(12, {head: {ref}})));
  }
  for (const number of [0, -1, 'x']) assert.throws(() => integrationBranch(pr(number)));

});

test('routing creates from latest main and is idempotent across deliveries', async () => {
  const f = fixture();
  await route(f);
  assert.equal(f.refs.get('heads/merge/12/feature/nested'), 'main-sha');
  assert.equal(f.context.payload.pull_request.base.ref, 'merge/12/feature/nested');
  await route(f);
  assert.equal(f.comments.length, 1);
});

test('routing handles concurrent creation without overwriting existing work', async () => {
  const f = fixture();
  f.github.rest.git.createRef = async ({ref}) => {
    f.refs.set(ref.replace(/^refs\//, ''), 'existing-work');
    throw Object.assign(new Error('Already exists'), {status: 422});
  };
  await route(f);
  assert.equal(f.refs.get('heads/merge/12/feature/nested'), 'existing-work');
});

test('routing skips bots, authorized, closed and unrelated PRs', async () => {
  for (const changes of [{user: {type: 'Bot'}}, {labels: [{name: 'base:main-authorized'}]}, {state: 'closed'}, {base: {ref: 'other'}}]) {
    const f = fixture([pr(12, changes)]);
    await route(f);
    assert.equal(f.refs.size, 1);
    assert.equal(f.comments.length, 0);
  }
});

test('validation accepts only the exact PR base or existing main exemptions', () => {
  validateBase(pr(12, {base: {ref: 'merge/12/feature/nested'}}), {});
  assert.throws(() => validateBase(pr(12, {base: {ref: 'merge/13/feature/nested'}}), {}));
  assert.throws(() => validateBase(pr(), {}));
  validateBase(pr(12, {user: {type: 'Bot'}}), {});
  validateBase(pr(12, {labels: [{name: 'base:main-authorized'}]}), {});
});

test('refresh advances multiple open bases but skips unrelated and closed PRs', async () => {
  const prs = [12, 13, 14].map(n => pr(n, {base: {ref: `merge/${n}/feature/nested`}}));
  prs[2].state = 'closed';
  prs.push(pr(15));
  const f = fixture(prs);
  for (const p of prs.slice(0, 3)) f.refs.set(`heads/${p.base.ref}`, 'old-main');
  await refresh(f);
  assert.equal(f.updates.length, 2);
  assert.ok(f.updates.every(update => update.force === false && update.sha === 'main-sha'));
  assert.equal(f.refs.get('heads/merge/14/feature/nested'), 'old-main');
});

test('refresh preserves a PR merged after listing and a branch changed during update', async () => {
  const f = fixture([pr(12, {base: {ref: 'merge/12/feature/nested'}}), pr(13, {base: {ref: 'merge/13/feature/nested'}})]);
  f.refs.set('heads/merge/12/feature/nested', 'merge-12');
  f.refs.set('heads/merge/13/feature/nested', 'racing-merge');
  const get = f.github.rest.pulls.get;
  f.github.rest.pulls.get = async args => {
    const result = await get(args);
    if (args.pull_number === 12) return {data: {...result.data, state: 'closed', merged: true}};
    return result;
  };
  f.github.rest.git.updateRef = async () => {throw Object.assign(new Error('Not a fast-forward'), {status: 422});};
  await refresh(f);
  assert.equal(f.refs.get('heads/merge/12/feature/nested'), 'merge-12');
  assert.equal(f.refs.get('heads/merge/13/feature/nested'), 'racing-merge');
  assert.equal(f.warnings.length, 1);
});

function candidate() {
  const f = fixture([pr(12, {base: {ref: 'merge/12/feature/nested'}, title: 'feat: publish', state: 'closed', merged: true, merged_at: 'today', merge_commit_sha: 'merge-sha'})]);
  f.refs.set('heads/merge/12/feature/nested', 'merge-sha');
  return f;
}

test('publication identifies only the exact merged PR and branch tip', async () => {
  const f = candidate();
  await identifySource(f);
  assert.deepEqual(f.outputs, {candidate: 'true', number: 12, branch: 'merge/12/feature/nested', 'merge-sha': 'merge-sha', title: 'feat: publish', intent: ''});
});

test('creation, deletion, refresh, recovery, other-base, stale and missing refs do not publish', async () => {
  const mutations = [
    f => {f.context.payload.created = true;},
    f => {f.context.payload.deleted = true;},
    f => {f.context.sha = 'refresh-sha';},
    f => {f.context.sha = 'revert-sha';},
    f => {f.context.payload.pull_request.base.ref = 'main';},
    f => {f.context.payload.pull_request.merged_at = null;},
    f => {f.refs.set('heads/merge/12/feature/nested', 'changed');},
    f => {f.refs.delete('heads/merge/12/feature/nested');},
  ];
  for (const mutate of mutations) {
    const f = candidate();
    mutate(f);
    await identifySource(f);
    assert.equal(f.outputs.candidate, 'false');
    assert.equal(f.outputs.number, undefined);
  }
});

test('invalid labels fail with recovery identifiers available', async () => {
  const f = candidate();
  f.context.payload.pull_request.labels = [];
  await assert.rejects(identifySource(f, 'semantic'), /release/);
  assert.equal(f.outputs.number, 12);
  assert.equal(f.outputs.candidate, 'false');
});

test('recovery verifies the PR, branch and original merge', async () => {
  const f = candidate();
  const env = {SOURCE_PR: '12', INTEGRATION_BRANCH: 'merge/12/feature/nested', MERGE_SHA: 'merge-sha'};
  await validateRecovery(f, env);
  assert.equal(f.outputs.branch, 'merge/12/feature/nested');
  f.context.payload.pull_request.base.ref = 'merge/13/feature/nested';
  await assert.rejects(validateRecovery(f, env));
  f.context.payload.pull_request.base.ref = 'merge/12/feature/nested';
  await assert.rejects(validateRecovery(f, {...env, MERGE_SHA: 'wrong'}));
});

test('recovery refuses to partially revert a multi-commit rebase merge', async () => {
  const f = candidate();
  f.context.payload.pull_request.commits = 3;
  f.github.rest.git.getCommit = async () => ({data: {parents: [{sha: 'parent'}]}});
  await assert.rejects(validateRecovery(f, {SOURCE_PR: '12', INTEGRATION_BRANCH: 'merge/12/feature/nested', MERGE_SHA: 'merge-sha'}), /manual recovery/);
});

test('failed reopening still labels and audits the reverted merge accurately', async () => {
  const f = candidate();
  f.github.rest.pulls.update = async () => {throw new Error('Cannot reopen merged PR');};
  await annotateRecovery(f, {SOURCE_PR: '12', INTEGRATION_BRANCH: 'merge/12/feature/nested'});
  assert.equal(f.labels.length, 1);
  assert.match(f.comments[0].body, /did not allow/);
  assert.doesNotMatch(f.comments[0].body, /This pull request was reopened/);
  assert.equal(f.failures.length, 1);
});

test('metadata and publication share one semantic release label policy', () => {
  const base = pr(12, {title: 'feat(api)!: ship', base: {ref: 'merge/12/feature/nested'}});
  for (const intent of ['major', 'minor', 'patch', 'none']) {
    const value = {...base, labels: [{name: 'stage'}, {name: `release:${intent}`}]};
    validateMetadata(value, 'semantic');
    assert.equal(releaseIntent(value, 'semantic'), `release:${intent}`);
  }
  for (const labels of [[], [{name: 'release:date'}], [{name: 'release:major'}, {name: 'release:patch'}], [{name: 'release:patch'}, {name: 'release:typo'}]]) {
    assert.throws(() => validateMetadata({...base, labels}, 'semantic'), /release/);
  }
  assert.throws(() => validateMetadata({...base, title: 'unstructured title'}), /Conventional/);
  validateMetadata({...base, title: 'fix: x'});
});

test('publication reporting distinguishes image failure after promotion from validation failure', async () => {
  const f = fixture();
  await reportPublication(f, {SOURCE_PR: '12', PROMOTED: 'true', PUBLISHED: 'false'});
  assert.match(f.comments[0].body, /retry Publish Image/);
  assert.doesNotMatch(f.comments[0].body, /Published image and release/);
  await reportPublication(f, {SOURCE_PR: '12', PROMOTED: 'false'});
  assert.match(f.comments[1].body, /not updated/);
  await reportPublication(f, {SOURCE_PR: '12', PUBLISHED: 'true', RELEASE_TAG: 'v1.0.0', CLEANUP_OUTCOME: 'failure'});
  assert.match(f.comments[2].body, /Published image and release v1.0.0/);
  assert.equal(f.warnings.length, 1);
});

test('calendar metadata and publication default to no semantic release label', async () => {
  const value = pr(12, {title: 'fix: calendar release', labels: [], base: {ref: 'merge/12/feature/nested'}});
  validateMetadata(value);
  assert.equal(releaseIntent(value), '');
  assert.throws(() => validateMetadata(value, 'semantic'), /release/);
  assert.throws(() => validateMetadata({...value, title: 'invalid'}, 'calendar'), /Conventional/);
  assert.throws(() => validateMetadata(value, 'typo'), /Versioning/);
  const f = candidate();
  f.context.payload.pull_request.labels = [];
  await identifySource(f);
  assert.equal(f.outputs.candidate, 'true');
  assert.equal(f.outputs.intent, '');
});
