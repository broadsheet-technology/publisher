#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ruby -ryaml <<'RUBY'
workflow_path = ".github/workflows/publish.yml"
workflow = YAML.load_file(workflow_path)
workflow_call = workflow.fetch(true).fetch("workflow_call")
inputs = workflow_call.fetch("inputs")
secrets = workflow_call.fetch("secrets")
steps = workflow.fetch("jobs").fetch("image").fetch("steps")

def assert(condition, message)
  abort "not ok - #{message}" unless condition
end

def step_named(steps, name)
  steps.find { |step| step["name"] == name } or abort "not ok - missing step: #{name}"
end

assert(inputs.fetch("node-version").fetch("default") == "24", "Node.js 24 is the default")
assert(inputs.fetch("prune-node").fetch("type") == "boolean", "prune-node is boolean")
assert(inputs.fetch("prune-node").fetch("default") == false, "prune-node defaults to false")
assert(inputs.keys.sort == %w[delete-tags image node-version prebuild-node prune-node tags], "v4 exposes the expected inputs")
assert(secrets.fetch("BT_PACKAGE_TOKEN").fetch("required") == false, "BT_PACKAGE_TOKEN is optional")

setup = step_named(steps, "Set up Node.js")
assert(setup.fetch("uses") == "actions/setup-node@v4", "setup-node v4 is used")
assert(setup.fetch("if") == "steps.plan.outputs.publish == 'true' && inputs.prebuild-node", "Node setup requires a publish plan and prebuild-node")
assert(setup.fetch("with").fetch("registry-url") == "https://npm.pkg.github.com", "GitHub Packages registry is configured")
assert(setup.fetch("with").fetch("scope") == "@broadsheet-technology", "package scope is configured")
assert(setup.fetch("with").fetch("cache") == "npm", "npm caching is enabled")
assert(setup.fetch("with").fetch("node-version") == "${{ inputs.node-version }}", "requested Node.js version is used")

token = "${{ secrets.BT_PACKAGE_TOKEN || github.token }}"
preparation_steps = [
  ["Install Node.js dependencies", "npm ci --prefer-offline --no-audit"],
  ["Build Node.js application", "npm run build"],
  ["Prune Node.js development dependencies", "npm prune --omit=dev --no-audit"]
]

preparation_steps.each do |name, command|
  step = step_named(steps, name)
  assert(step.fetch("run") == command, "#{name} runs the expected command")
  assert(step.fetch("if").include?("steps.plan.outputs.publish == 'true'"), "#{name} is skipped for delete-only plans")
  assert(step.fetch("if").include?("inputs.prebuild-node"), "#{name} requires prebuild-node")
end

install = step_named(steps, "Install Node.js dependencies")
assert(install.fetch("env").fetch("NODE_AUTH_TOKEN") == token, "npm authentication prefers BT_PACKAGE_TOKEN and falls back to github.token")

prune = step_named(steps, "Prune Node.js development dependencies")
assert(prune.fetch("if") == "steps.plan.outputs.publish == 'true' && inputs.prebuild-node && inputs.prune-node", "pruning requires publish, prebuild-node, and prune-node")

non_install_steps = steps.reject { |step| step["name"] == "Install Node.js dependencies" }
assert(non_install_steps.none? { |step| step.fetch("env", {}).key?("NODE_AUTH_TOKEN") }, "NODE_AUTH_TOKEN is limited to dependency installation")

publish_only_steps = [
  "Check out repository",
  "Set up Node.js",
  "Install Node.js dependencies",
  "Build Node.js application",
  "Prune Node.js development dependencies",
  "Set up Docker Buildx",
  "Log in to GHCR",
  "Build and publish image"
]
publish_only_steps.each do |name|
  assert(step_named(steps, name).fetch("if").include?("steps.plan.outputs.publish == 'true'"), "#{name} is skipped for delete-only plans")
end

docker_build = step_named(steps, "Build and publish image")
docker_build_inputs = docker_build.fetch("with")
assert(!docker_build_inputs.key?("build-args"), "package token is not passed as a Docker build argument")
assert(!docker_build_inputs.key?("secrets"), "package token is not passed as a BuildKit secret")
assert(!docker_build.fetch("env", {}).value?(token), "package token is not passed in the Docker build environment")

ghcr_login = step_named(steps, "Log in to GHCR")
assert(ghcr_login.fetch("with").fetch("password") == "${{ github.token }}", "GHCR authentication continues to use github.token")

readme = File.read("README.md")
workflow_references = readme.scan(%r{broadsheet-technology/publisher/\.github/workflows/publish\.yml@v\d+})
assert(!workflow_references.empty?, "README includes reusable-workflow examples")
assert(workflow_references.all? { |reference| reference.end_with?("@v4") }, "README reusable-workflow references consistently use @v4")
assert(readme.include?("BT_PACKAGE_TOKEN"), "README documents BT_PACKAGE_TOKEN")
assert(readme.include?("`prune-node`"), "README documents prune-node")
assert(readme.include?('`"24"`'), "README documents the Node.js 24 default")

puts "ok - workflow"
RUBY
