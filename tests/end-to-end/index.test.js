const dotenv = require('dotenv');
const setupTestRepo = require('./setupTestRepo');
const yaml = require('js-yaml');
const { readFileSync } = require('fs');
const { writeFile, readFile, mkdir } = require('fs/promises');
const { resolve, join } = require('path');
const { cwd } = require('process');
const git = require('./git');
const { getMostRecentWorkflowRun, getWorkflowRun } = require('./actionsApi');

dotenv.config();

const config = getTestConfig();

beforeAll(() => {
  let currentBranch = 'main';
  if (process.env.GITHUB_HEAD_REF) {
    // Comes from a pull request
    currentBranch = process.env.GITHUB_HEAD_REF;
  } else {
    // No support for local runs.
    process.exit(1);
  }

  setupTestRepo(config.actionFiles, currentBranch);
});

config.suites.forEach((suite) => {
  const suiteYaml = yaml.dump(suite.yaml);
  describe(suite.name, () => {
    beforeAll(async () => {
      await git('config', 'user.name', 'Automated Version Bump Test');
      await git('config', 'user.email', 'gh-action-bump-version-test@users.noreply.github.com');

      // Do everything on a branch name matching the Pull Request we were
      // triggered from, to avoid contention on the main branch.
      baseBranchName = process.env.GITHUB_HEAD_REF;
      await git('checkout', baseBranchName);

      const pushYamlPath = join('.github', 'workflows', 'push.yml');
      await mkdir(join(cwd(), '.github', 'workflows'), { recursive: true });
      await writeFile(join(cwd(), pushYamlPath), suiteYaml);
      await git('add', pushYamlPath, '--force');
    });
    suite.tests.forEach((commit) => {
      test(commit.message, async () => {
        baseBranchName = process.env.GITHUB_HEAD_REF;

        await generateReadMe(baseBranchName, commit, suiteYaml);
        await git('commit', '--message', commit.message);

        const mostRecentDate = await getMostRecentWorkflowRunDate();
        await git('push');

        const completedRun = await getCompletedRunAfter(mostRecentDate);
        expect(completedRun.conclusion).toBe('success');

        await assertExpectation(baseBranchName, commit.expected);
      });
    });
  });
});

function getTestConfig() {
  const path = resolve(__dirname, './config.yaml');
  const buffer = readFileSync(path);
  const contents = buffer.toString();
  const config = yaml.load(contents);
  return config;
}

async function generateReadMe(baseBranchName, commit, suiteYaml) {
  const readmePath = 'README.md';
  const readMeContents = [
    '# Test Details',
    '## .github/workflows/push.yml',
    '```YAML',
    yaml.dump(suiteYaml),
    '```',
    '## Message',
    commit.message,
    '## Expectation',
    generateExpectationText(baseBranchName, commit.expected),
  ].join('\n');
  await writeFile(join(cwd(), readmePath), readMeContents);
  await git('add', readmePath, '--force');
}

async function getCompletedRunAfter(date) {
  const run = await pollFor(getMostRecentWorkflowRun, (run) => run !== null && new Date(run.created_at) > date);
  const completedRun = await pollFor(
    () => getWorkflowRun(run.id),
    (run) => run.status === 'completed',
  );
  return completedRun;
}

function pollFor(getResult, validateResult) {
  return new Promise((resolve, reject) => {
    pollAndRetry();

    async function pollAndRetry() {
      try {
        const result = await getResult();
        if (validateResult(result)) {
          resolve(result);
        } else {
          setTimeout(pollAndRetry, 1000);
        }
      } catch (error) {
        reject(error);
      }
    }
  });
}

async function getMostRecentWorkflowRunDate() {
  const run = await getMostRecentWorkflowRun();
  const date = run === null ? new Date(0) : new Date(run.created_at);
  return date;
}

function generateExpectationText(baseBranchName, {
  version: expectedVersion,
  tag: expectedTag,
  branch: expectedBranch,
  message: expectedMessage,
}) {
  const results = [`- **Version:** ${expectedVersion}`];
  if (expectedTag) {
    results.push(`- **Tag:** ${expectedTag}`);
  }
  if (expectedBranch) {
    results.push(`- **Branch:** ${baseBranchName}-${expectedBranch}`);
  }
  if (expectedMessage) {
    results.push(`- **Message:** ${expectedMessage}`);
  }
  return results.join('\n');
}

async function assertExpectation(baseBranchName, {
  version: expectedVersion,
  tag: expectedTag,
  branch: expectedBranch,
  message: expectedMessage,
}) {
  if (expectedTag === undefined) {
    expectedTag = expectedVersion;
  }
  if (expectedBranch) {
    await git('fetch', 'origin', `${baseBranchName}-${expectedBranch}`);
    await git('checkout', `${baseBranchName}-${expectedBranch}`);
  }
  await git('pull');
  const [packageVersion, latestTag, latestMessage] = await Promise.all([
    getPackageJsonVersion(),
    getLatestTag(),
    getLatestCommitMessage(),
  ]);
  if (!expectedMessage) {
    expectedMessage = latestMessage;
  }
  expect(packageVersion).toBe(expectedVersion);
  expect(latestTag).toBe(expectedTag);
  expect(latestMessage).toBe(expectedMessage);
  if (expectedBranch) {
    await git('checkout', baseBranchName);
  }
}

async function getPackageJsonVersion() {
  const path = join(cwd(), 'package.json');
  const contents = await readFile(path);
  const json = JSON.parse(contents);
  return json.version;
}

async function getLatestTag() {
  const result = await git({ suppressOutput: true }, 'describe', '--tags', '--abbrev=0');
  return result.stdout;
}

async function getLatestCommitMessage() {
  const result = await git({ suppressOutput: true }, 'show', '--no-patch', '--format=%s');
  return result.stdout;
}
