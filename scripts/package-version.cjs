const fs = require('node:fs');

function releaseVersion(value) {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/.test(value)) {
    throw new Error('Invalid package version');
  }
  return `v${value.replace(/^v/, '')}`;
}

if (require.main === module) {
  const version = releaseVersion(process.argv[2]);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  pkg.version = version;
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  for (const [file, value] of [['package.json', pkg], ['package-lock.json', lock]]) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
}

module.exports = {releaseVersion};
