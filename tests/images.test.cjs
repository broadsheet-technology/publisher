const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseTags, planImage, imageTags, deleteImages} = require('../scripts/images.cjs');

test('explicit publish/delete tags are normalized, deduplicated, and validated', () => {
  assert.deepEqual(planImage({tags: 'latest, sha-123\nlatest', deleteTags: 'old'}),
    {publish: true, tags: ['latest', 'sha-123'], deleteTags: ['old']});
  assert.deepEqual(planImage({deleteTags: 'old'}), {publish: false, tags: [], deleteTags: ['old']});
  for (const tag of ['ghcr.io/org/app:latest', 'bad tag', '-bad', 'a'.repeat(129), '";error']) {
    assert.throws(() => parseTags(tag));
  }
});

test('stage lifecycle is owned by publisher and closed PRs only delete', () => {
  for (const action of ['opened', 'reopened', 'synchronize', 'labeled', 'unlabeled', 'closed']) {
    for (const stage of [true, false]) {
      const event = {action, pull_request: {number: 17, labels: stage ? [{name: 'stage'}] : []}};
      const plan = planImage({eventName: 'pull_request', event});
      const publish = stage && action !== 'closed';
      assert.deepEqual(plan, {publish, tags: publish ? ['stage-pr-17'] : [], deleteTags: publish ? [] : ['stage-pr-17']});
    }
  }
});

test('release tags use the selected release SHA and version; explicit tags need no package.json', () => {
  const image = 'ghcr.io/org/application';
  const sha = 'a'.repeat(40);
  assert.deepEqual(planImage({eventName: 'push', event: {}}), {publish: true, tags: [], deleteTags: []});
  assert.deepEqual(imageTags({image, sha, version: 'v1.2.3'}), [`${image}:${sha}`, `${image}:v1.2.3`, `${image}:latest`]);
  assert.deepEqual(imageTags({image, sha, version: '1.2.3'}), [`${image}:${sha}`, `${image}:v1.2.3`, `${image}:latest`]);
  assert.deepEqual(imageTags({image, tags: 'preview,preview'}), [`${image}:preview`]);
  assert.throws(() => imageTags({image, sha: 'short', version: '1.2.3'}));
  assert.throws(() => imageTags({image, sha, version: 'invalid'}));
  assert.throws(() => imageTags({image: image + ':tag', tags: 'latest'}));
});

function fixture(type = 'Organization') {
  const deleted = [];
  const warnings = [];
  const github = {
    rest: {users: {getByUsername: async () => ({data: {type}})}},
    paginate: async () => [
      {id: 1, metadata: {container: {tags: ['stage-pr-1']}}},
      {id: 2, metadata: {container: {tags: ['stage-pr-1', 'latest', 'v1.0.0']}}},
      {id: 3, metadata: {container: {tags: ['stage-pr-2', 'stage-pr-3']}}},
      {id: 4, metadata: {container: {tags: ['unrelated']}}},
    ],
    request: async (route, params) => deleted.push({route, params}),
  };
  return {github, core: {warning: value => warnings.push(value)}, deleted, warnings};
}

test('stage cleanup preserves shared release digests and deletes each requested version once', async () => {
  const f = fixture();
  await deleteImages(f, 'ghcr.io/org/nested/app', 'stage-pr-1,stage-pr-2,stage-pr-3');
  assert.deepEqual(f.deleted.map(call => call.params.package_version_id), [1, 3]);
  assert.equal(f.deleted[0].params.package_name, 'nested/app');
  assert.match(f.deleted[0].route, /\/orgs\//);
  assert.equal(f.warnings.length, 1);
});

test('cleanup supports personal packages, missing packages, and already-deleted versions', async () => {
  const f = fixture('User');
  await deleteImages(f, 'ghcr.io/user/app', 'stage-pr-1');
  assert.match(f.deleted[0].route, /\/users\//);
  f.github.request = async () => {throw Object.assign(new Error('gone'), {status: 404});};
  await deleteImages(f, 'ghcr.io/user/app', 'stage-pr-1');
  f.github.paginate = async () => {throw Object.assign(new Error('missing'), {status: 404});};
  await deleteImages(f, 'ghcr.io/user/app', 'stage-pr-1');
});

test('cleanup propagates lookup and deletion permission errors', async () => {
  const f = fixture();
  f.github.request = async () => {throw Object.assign(new Error('forbidden'), {status: 403});};
  await assert.rejects(deleteImages(f, 'ghcr.io/org/app', 'stage-pr-1'), /forbidden/);
  f.github.paginate = async () => {throw Object.assign(new Error('lookup forbidden'), {status: 403});};
  await assert.rejects(deleteImages(f, 'ghcr.io/org/app', 'stage-pr-1'), /lookup forbidden/);
});
