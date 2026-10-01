const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const documents = JSON.parse(execFileSync('ruby', ['-ryaml', '-rjson', '-e',
  'puts JSON.generate(Dir[".github/workflows/*.yml", ".github/actions/*/action.yml"].to_h { |file| [file, YAML.load_file(file)] })'],
  {cwd: root, encoding: 'utf8'}));
const workflow = name => documents[`.github/workflows/${name}.yml`];
const node = documents['.github/actions/node-project/action.yml'];
const image = documents['.github/actions/publish-image/action.yml'];

test('release guards validation, promotion, and image publication; cleanup follows image success', () => {
  const steps = workflow('publish-strategy').jobs.publish.steps;
  const names = ['Merge current released main', 'Calculate release version', 'Version, test, and build application',
    'Create release commit', 'Promote release commit to main', 'Tag release commit', 'Publish release image', 'Mark publication complete'];
  const positions = names.map(name => {
    const index = steps.findIndex(step => step.name === name);
    assert.ok(index >= 0, name);
    const step = steps[index];
    assert.equal(step.if, "steps.source.outputs.candidate == 'true'");
    assert.equal(step['continue-on-error'], undefined);
    return index;
  });
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.equal(steps.find(step => step.id === 'cleanup').if, "steps.published.outputs.complete == 'true'");
  assert.equal(steps.find(step => step.id === 'refresh').if, "always() && steps.promote.outputs.promoted == 'true'");
  assert.equal(steps.find(step => step.name === 'Version, test, and build application').with.version, '${{ steps.version.outputs.version }}');
  assert.equal(steps.find(step => step.name === 'Version, test, and build application').with.test, 'true');
});

test('publication, recovery, refresh, and manual images share one serialization boundary', () => {
  const concurrency = workflow('publish-strategy').concurrency;
  assert.equal(concurrency.group, 'publish-${{ github.repository }}');
  assert.equal(concurrency['cancel-in-progress'], false);
  assert.equal(concurrency.queue, 'max');
  for (const name of ['recover-publication', 'refresh-integrations']) assert.deepEqual(workflow(name).concurrency, concurrency);
  const expr = workflow('publish').concurrency.group.slice(3, -2).trim();
  const group = new Function('github', 'format', `return (${expr});`);
  const format = (pattern, ...values) => pattern.replace(/\{(\d+)\}/g, (_, index) => values[index]);
  assert.equal(group({event_name: 'workflow_dispatch', repository: 'org/app'}, format), 'publish-org/app');
  assert.equal(group({event_name: 'pull_request', repository: 'org/app', event: {pull_request: {number: 12}}}, format), 'stage-org/app-12');
});

test('Node preparation is shared, configures authentication before npm, and tests before build/prune', () => {
  const steps = node.runs.steps;
  assert.equal(steps[0].uses, 'actions/setup-node@v4');
  assert.equal(steps[0].with['node-version'], '24');
  assert.equal(steps[0].with['registry-url'], 'https://npm.pkg.github.com');
  const index = name => steps.findIndex(step => step.name === name);
  assert.ok(index('Update package version') < index('Install dependencies'));
  assert.ok(index('Install dependencies') < index('Run tests'));
  assert.ok(index('Run tests') < index('Build application'));
  assert.ok(index('Build application') < index('Prune development dependencies'));
  for (const name of ['Install dependencies', 'Prune development dependencies']) {
    assert.equal(steps[index(name)].env.NODE_AUTH_TOKEN, '${{ inputs.package-token }}');
  }
  for (const name of ['publish-strategy', 'validate-node', 'publish']) {
    const steps = Object.values(workflow(name).jobs).flatMap(job => job.steps || []);
    assert.ok(steps.some(step => step.uses === './.publisher/.github/actions/node-project'));
  }
  assert.equal(image.inputs['package-token'], undefined);
});

test('delete-only image runs do not check out or build the application', () => {
  const steps = workflow('publish').jobs.image.steps;
  for (const name of ['Check out application', 'Build Node application', 'Publish image']) {
    assert.ok(steps.find(step => step.name === name).if.includes("steps.plan.outputs.publish == 'true'"));
  }
  assert.equal(image.runs.steps.at(-1).with.context, 'candidate');
  assert.equal(image.runs.steps.at(-1).with.tags, '${{ steps.tags.outputs.tags }}');
});

test('composite action shell steps have explicit shells and valid syntax', () => {
  for (const action of [node, image]) {
    for (const step of action.runs.steps.filter(step => step.run)) {
      assert.equal(step.shell, 'bash');
      execFileSync('bash', ['-n'], {input: step.run, env: {...process.env, LC_ALL: 'C'}});
    }
  }
});

test('release workflows load Publisher automation from v5', () => {
  let checkouts = 0;
  for (const [file, doc] of Object.entries(documents)) {
    if (!doc.jobs) continue;
    for (const job of Object.values(doc.jobs)) {
      for (const step of job.steps || []) {
        if (step.with?.repository !== 'broadsheet-technology/publisher') continue;
        assert.equal(step.with.ref, 'v5', file);
        checkouts++;
      }
    }
  }
  assert.equal(checkouts, 7);
});

test('v5 publication requires successful main tests and never tags a PR or stale run', async () => {
  const job = workflow('test').jobs.release;
  assert.equal(job.needs, 'test');
  assert.equal(job.permissions.contents, 'write');
  const enabled = new Function('github', `return (${job.if});`);
  assert.equal(enabled({event_name: 'push', ref: 'refs/heads/main'}), true);
  assert.equal(enabled({event_name: 'pull_request', ref: 'refs/heads/main'}), false);
  assert.equal(enabled({event_name: 'push', ref: 'refs/heads/feature'}), false);
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const publish = new AsyncFunction('github', 'context', 'core', job.steps[0].with.script);
  for (const state of ['existing', 'missing', 'stale', 'denied']) {
    const writes = [];
    const github = {rest: {git: {
      getRef: async ({ref}) => {
        if (ref === 'heads/main') return {data: {object: {sha: state === 'stale' ? 'newer' : 'tested'}}};
        if (state === 'missing' || state === 'denied') throw Object.assign(new Error(state), {status: state === 'missing' ? 404 : 403});
        return {data: {object: {sha: 'old'}}};
      },
      createRef: async args => writes.push({method: 'create', ...args}),
      updateRef: async args => writes.push({method: 'update', ...args}),
    }}};
    const repo = {owner: 'org', repo: 'publisher'};
    const result = publish(github, {repo, sha: 'tested'}, {info: () => {}});
    if (state === 'denied') await assert.rejects(result, /denied/);
    else await result;
    const expected = state === 'existing' ? [{method: 'update', ...repo, ref: 'tags/v5', sha: 'tested', force: true}]
      : state === 'missing' ? [{method: 'create', ...repo, ref: 'refs/tags/v5', sha: 'tested'}] : [];
    assert.deepEqual(writes, expected, state);
  }
});

test('metadata and publication expose calendar defaults and forward calendar configuration', () => {
  const publish = workflow('publish-strategy');
  const metadata = workflow('pr-validate');
  for (const doc of [publish, metadata]) {
    assert.equal(doc.true.workflow_call.inputs.versioning.default, 'calendar');
  }
  assert.equal(publish.true.workflow_call.inputs.timezone.default, 'UTC');
  const steps = publish.jobs.publish.steps;
  assert.equal(steps.find(step => step.id === 'source').env.VERSIONING, '${{ inputs.versioning }}');
  const calculate = steps.find(step => step.id === 'version');
  assert.equal(calculate.env.VERSIONING, '${{ inputs.versioning }}');
  assert.equal(calculate.env.VERSION_TIMEZONE, '${{ inputs.timezone }}');
  const validate = metadata.jobs.metadata.steps.find(step => step.env?.VERSIONING);
  assert.equal(validate.env.VERSIONING, '${{ inputs.versioning }}');
});
