const fs = require('node:fs');

const {releaseVersion} = require('./versions.cjs');

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
