const { existsSync } = require('fs');
const { rm, mkdir, copyFile, stat } = require('fs/promises');
const { chdir, cwd } = require('process');
const { resolve, join, dirname } = require('path');
const exec = require('./exec');
const git = require('./git');
const glob = require('tiny-glob');
const { clearWorkflowRuns } = require('./actionsApi');

/**
 * Sets up a local test repo
 * @param {*} actionFileGlobPaths 
 * @param {*} baseBranchName 
 */
module.exports = async function setupTestRepo(actionFileGlobPaths, baseBranchName) {
  const testRepoPath = resolve(__dirname, '..', '..', 'test-repo');
  if (existsSync(testRepoPath)) {
    await rm(testRepoPath, { recursive: true, force: true });
  }
  await mkdir(testRepoPath);
  chdir(testRepoPath);
  await Promise.all([clearWorkflowRuns(baseBranchName), createNpmPackage(), copyActionFiles(actionFileGlobPaths)]);
  await git('init', '--initial-branch', baseBranchName);
  await addRemote({
    testRepoUrl: process.env.TEST_REPO,
    username: process.env.TEST_USER,
    token: process.env.TEST_TOKEN
  });
  console.log('ROSSHAMISH');
  await git('config', 'user.name', 'Automated Version Bump Test');
  await git('config', 'user.email', 'gh-action-bump-version-test@users.noreply.github.com');
  await git('add', '.');
  await git('commit', '--message', 'initial commit (version 1.0.0)');
  await git('push', '--force', '--set-upstream', 'origin', baseBranchName);
  await deleteTagsAndBranches(baseBranchName);
};

function createNpmPackage() {
  return exec('npm', 'init', '-y');
}

async function addRemote({ testRepoUrl, username, token }) {
  const authUrl = testRepoUrl.replace(/^https:\/\//, `https://${username}:${token}@`);
  await git('remote', 'add', 'origin', authUrl);
}

async function copyActionFiles(globPaths) {
  const actionFolder = join(cwd(), 'action');
  await mkdir(actionFolder);
  const projectRoot = join(__dirname, '..', '..');
  const globResults = await Promise.all(globPaths.map((path) => glob(path, { cwd: projectRoot })));
  const relativeFilePaths = await Promise.all([...new Set(globResults.flat())]);
  const folders = [...new Set(relativeFilePaths.map(dirname))].filter((path) => path !== '.');
  if (folders.length > 0) {
    await Promise.all(folders.map((folder) => mkdir(join(actionFolder, folder), { recursive: true })));
  }
  await Promise.all(
    relativeFilePaths.map(async (path) => {
      const sourcePath = join(projectRoot, path);
      const fileStat = await stat(sourcePath);
      if (fileStat.isFile()) {
        return copyFile(sourcePath, join(actionFolder, path));
      }
    }),
  );
}

/**
 * Delete all tags and branches.
 * TODO(rosshamish) filter tags by prefix as well
 *
 * @param {*} baseBranchName (Optional) Filter to branches with this prefix
 */
async function deleteTagsAndBranches(baseBranchName) {
  const listResult = await git({ suppressOutput: true }, 'ls-remote', '--tags', '--heads', 'origin');
  if (listResult.stdout) {
    const lines = listResult.stdout.split('\n');
    const refs = lines.map((line) => line.split('\t')[1]).filter((ref) => ref !== `refs/heads/${baseBranchName}`);
    if (refs.length > 0) {
      await git('push', 'origin', '--delete', ...refs);
    }
  }
}
