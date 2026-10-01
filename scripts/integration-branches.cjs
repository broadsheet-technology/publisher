// Loaded only from the trusted publisher checkout by actions/github-script.
function integrationBranch(pr) {
  if (!/^[1-9]\d*$/.test(String(pr.number))) throw new Error('Invalid pull request number');
  const branch = `merge/${pr.number}/${pr.head.ref}`;
  if (branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock')) ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') ||
      branch.includes('@{') || branch.endsWith('.')) {
    throw new Error(`Invalid integration branch: ${branch}`);
  }
  return branch;
}

async function getRef(github, repo, branch) {
  try {
    return (await github.rest.git.getRef({...repo, ref: `heads/${branch}`})).data;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function route({github, context, core}) {
  const repo = context.repo;
  const {data: pr} = await github.rest.pulls.get({...repo, pull_number: context.payload.pull_request.number});
  const releaseBranch = 'main';
  if (pr.state !== 'open' || mayTargetMain(pr)) return;
  const branch = integrationBranch(pr);
  if (pr.base.ref !== releaseBranch && pr.base.ref !== branch) return;
  const ref = await getRef(github, repo, branch);
  if (!ref) {
    const release = await getRef(github, repo, releaseBranch);
    if (!release) throw new Error(`Release branch ${releaseBranch} does not exist`);
    try {
      await github.rest.git.createRef({...repo, ref: `refs/heads/${branch}`, sha: release.object.sha});
    } catch (error) {
      // An overlapping delivery may already have created the same PR's branch.
      if (error.status !== 422 || !(await getRef(github, repo, branch))) throw error;
    }
  }
  if (pr.base.ref === branch) return;
  await github.rest.pulls.update({...repo, pull_number: pr.number, base: branch});
  await github.rest.issues.createComment({...repo, issue_number: pr.number,
    body: `This pull request now targets \`${branch}\`. Successful publication will promote its release to \`${releaseBranch}\`.`});
  core.info(`Routed #${pr.number} to ${branch}.`);
}

async function refresh({github, context, core}) {
  const repo = context.repo;
  const release = await getRef(github, repo, 'main');
  if (!release) throw new Error('Release branch does not exist');
  const prs = await github.paginate(github.rest.pulls.list, {...repo, state: 'open', per_page: 100});
  for (const listed of prs) {
    const branch = integrationBranch(listed);
    if (listed.base.ref !== branch) continue;
    // Re-read immediately before updating: a PR may have merged since listing.
    const {data: pr} = await github.rest.pulls.get({...repo, pull_number: listed.number});
    if (pr.state !== 'open' || pr.merged || pr.base.ref !== branch) continue;
    const ref = await getRef(github, repo, branch);
    if (!ref || ref.object.sha === release.object.sha) continue;
    try {
      // GitHub checks ancestry atomically. A racing merge or divergent work is
      // preserved even if it arrives after the state check above.
      await github.rest.git.updateRef({...repo, ref: `heads/${branch}`, sha: release.object.sha, force: false});
      core.info(`Advanced ${branch} to ${release.object.sha}.`);
    } catch (error) {
      if (![404, 409, 422].includes(error.status)) throw error;
      core.warning(`Retained ${branch}: it disappeared or cannot fast-forward to the release branch. ${error.message}`);
    }
  }
}

function mayTargetMain(pr) {
  return pr.user.type === 'Bot' || pr.labels.some(label => label.name === 'base:main-authorized');
}

function validateBase(pr) {
  const branch = integrationBranch(pr);
  if (pr.base.ref === branch) return;
  if (pr.base.ref === 'main' && mayTargetMain(pr)) return;
  throw new Error(`Pull requests must target ${branch} unless authorized to target main.`);
}

async function identifySource({github, context, core}) {
  core.setOutput('candidate', 'false');
  if (context.eventName !== 'push' || context.payload.created || context.payload.deleted) return;
  const branch = context.ref.replace(/^refs\/heads\//, '');
  const prs = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit,
    {...context.repo, commit_sha: context.sha, per_page: 100});
  const matches = prs.filter(pr => pr.merged_at && pr.merge_commit_sha === context.sha &&
    pr.base.ref === branch && integrationBranch(pr) === branch);
  if (matches.length === 0) {
    core.info('This push is not the merge of a PR into its integration branch.');
    return;
  }
  if (matches.length !== 1) throw new Error('Ambiguous source pull request');
  const pr = matches[0];
  const ref = await getRef(github, context.repo, branch);
  if (!ref || ref.object.sha !== context.sha) {
    core.info('The integration branch has been removed or changed since this push.');
    return;
  }
  // Set recovery identifiers even if release-label validation fails.
  core.setOutput('number', pr.number);
  core.setOutput('branch', branch);
  core.setOutput('merge-sha', context.sha);
  core.setOutput('title', pr.title);
  core.setOutput('intent', releaseIntent(pr));
  core.setOutput('candidate', 'true');
}

async function validateRecovery({github, context, core}, env = process.env) {
  const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number: Number(env.SOURCE_PR)});
  if (!pr.merged || pr.base.ref !== integrationBranch(pr) || pr.merge_commit_sha !== env.MERGE_SHA) {
    throw new Error('Recovery inputs do not match the source PR merge');
  }
  const {data: commit} = await github.rest.git.getCommit({...context.repo, commit_sha: env.MERGE_SHA});
  if (commit.parents.length === 1 && pr.commits !== 1) {
    throw new Error('A single-parent merge from a multi-commit PR requires manual recovery; reverting only the last rebased commit could leave partial changes');
  }
  core.setOutput('branch', pr.base.ref);
}

async function annotateRecovery({github, context, core}, env = process.env) {
  const repo = context.repo;
  const number = Number(env.SOURCE_PR);
  let reopened = false;
  let failure;
  try {
    await github.rest.pulls.update({...repo, pull_number: number, base: env.INTEGRATION_BRANCH, state: 'open'});
    reopened = true;
  } catch (error) {
    failure = error;
  }
  await github.rest.issues.addLabels({...repo, issue_number: number, labels: ['publication:failed']});
  await github.rest.issues.createComment({...repo, issue_number: number,
    body: `Publication failed.\n\nThe merge into \`${env.INTEGRATION_BRANCH}\` was reverted. ${reopened ? 'This pull request was reopened.' : 'GitHub did not allow this pull request to be reopened; create a follow-up PR with the corrected changes.'}\n\nRecovery workflow: ${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`});
  if (failure) core.setFailed(`The merge was reverted and annotated, but reopening failed: ${failure.message}`);
}

function releaseIntent(pr) {
  const labels = pr.labels.map(label => label.name).filter(name => name.startsWith('release:'));
  if (labels.length !== 1 || !/^release:(major|minor|patch|none)$/.test(labels[0])) {
    throw new Error('Expected exactly one release:major, release:minor, release:patch, or release:none label');
  }
  return labels[0];
}

function validateMetadata(pr) {
  if (!/^(feat|fix|perf|refactor|build|ci|docs|test|style|chore|revert)(\([A-Za-z0-9._/-]+\))?!?: \S.*$/.test(pr.title || '')) {
    throw new Error('Pull request title must use Conventional Commit syntax: <type>(optional-scope)!: description');
  }
  releaseIntent(pr);
  validateBase(pr);
}

async function reportPublication({github, context, core}, env = process.env) {
  const url = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  let body = env.PUBLISHED === 'true'
    ? `Published image and release ${env.RELEASE_TAG}.\n\nRelease commit: ${env.RELEASE_SHA}`
    : `Publication failed. ${env.PROMOTED === 'true' ? 'The release is already on main; retry Publish Image on its release tag instead of reverting the merge.' : 'The release branch was not updated by this run.'}\n\nWorkflow: ${url}`;
  for (const [name, outcome] of [['Integration branch cleanup', env.CLEANUP_OUTCOME], ['Integration base refresh', env.REFRESH_OUTCOME]]) {
    if (outcome === 'failure') {
      core.warning(`${name} failed; see ${url}`);
      body += `\n\n${name} failed; see ${url}.`;
    }
  }
  await github.rest.issues.createComment({...context.repo, issue_number: Number(env.SOURCE_PR), body});
}

module.exports = {integrationBranch, route, refresh, validateBase, releaseIntent, validateMetadata,
  identifySource, validateRecovery, annotateRecovery, reportPublication};
