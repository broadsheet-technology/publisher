const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {releaseVersion} = require('./package-version.cjs');

function parseTags(value = '') {
  const tags = [...new Set(value.split(/[\n,]/).map(tag => tag.trim()).filter(Boolean))];
  for (const tag of tags) {
    if (!/^[\w][\w.-]{0,127}$/.test(tag)) throw new Error(`Expected a raw image tag: ${tag}`);
  }
  return tags;
}

function planImage({eventName, event, tags = '', deleteTags = ''}) {
  const publish = parseTags(tags);
  const remove = parseTags(deleteTags);
  if (publish.length || remove.length) return {publish: publish.length > 0, tags: publish, deleteTags: remove};
  if (eventName === 'pull_request') {
    const pr = event.pull_request;
    if (!Number.isInteger(pr.number) || pr.number < 1) throw new Error('Invalid pull request number');
    const tag = `stage-pr-${pr.number}`;
    const stage = event.action !== 'closed' && pr.labels.some(label => label.name === 'stage');
    return {publish: stage, tags: stage ? [tag] : [], deleteTags: stage ? [] : [tag]};
  }
  // Release tags are read from the selected checkout after checkout/build.
  return {publish: true, tags: [], deleteTags: []};
}

function imageName(value) {
  if (!/^ghcr\.io\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/.test(value)) {
    throw new Error(`Expected a GHCR image name without a tag: ${value}`);
  }
  return value;
}

function imageTags({image, tags = '', sha, version}) {
  let raw = parseTags(tags);
  if (!raw.length) {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid release commit SHA');
    raw = parseTags(`${sha},${releaseVersion(version)},latest`);
  }
  return raw.map(tag => `${imageName(image)}:${tag}`);
}

async function deleteImages({github, core}, image, tags) {
  const wanted = new Set(parseTags(tags));
  if (!wanted.size) return;
  const [owner, ...parts] = imageName(image).slice('ghcr.io/'.length).split('/');
  const {data: user} = await github.rest.users.getByUsername({username: owner});
  if (!['Organization', 'User'].includes(user.type)) throw new Error(`Unsupported package owner type: ${user.type}`);
  const ownerPath = user.type === 'Organization' ? 'orgs/{org}' : 'users/{username}';
  const endpoint = `/${ownerPath}/packages/container/{package_name}/versions`;
  const params = {[user.type === 'Organization' ? 'org' : 'username']: owner, package_name: parts.join('/')};
  let versions;
  try {
    versions = await github.paginate(`GET ${endpoint}`, {...params, per_page: 100});
  } catch (error) {
    if (error.status === 404) return;
    throw error;
  }
  for (const version of versions) {
    const current = version.metadata.container.tags;
    if (!current.some(tag => wanted.has(tag))) continue;
    // GHCR deletes an entire version/digest, including all its tags.
    if (!current.every(tag => wanted.has(tag))) {
      core.warning(`Retained ${image} version ${version.id}: it also has tags outside this cleanup.`);
      continue;
    }
    try {
      await github.request(`DELETE ${endpoint}/{package_version_id}`, {...params, package_version_id: version.id});
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

function output(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (require.main === module) {
  if (process.argv[2] === 'plan') {
    const plan = planImage({eventName: process.env.GITHUB_EVENT_NAME,
      event: JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      tags: process.env.TAGS, deleteTags: process.env.DELETE_TAGS});
    output('publish', plan.publish);
    output('tags', plan.tags.join(','));
    output('delete-tags', plan.deleteTags.join(','));
  } else if (process.argv[2] === 'tags') {
    const tags = process.env.TAGS || '';
    const sha = tags ? undefined : execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    const version = tags ? undefined : JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    output('tags', imageTags({image: process.env.IMAGE, tags, sha, version}).join(','));
  } else {
    throw new Error('Expected plan or tags');
  }
}

module.exports = {parseTags, planImage, imageTags, deleteImages};
