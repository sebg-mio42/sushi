import fs from 'fs-extra';
import path from 'path';
import axios from 'axios';
import extract from 'extract-zip';
import temp from 'temp';
import readlineSync from 'readline-sync';
import { findReposUsingFSHFinder } from './find';
import { Repo } from './run';

// Track temporary files so they are deleted when the process exits
temp.track();

class Counter {
  public success: number;
  public error: number;

  constructor(public total: number) {
    this.success = 0;
    this.error = 0;
  }

  get done() {
    return this.success + this.error;
  }
}

export async function fish(output: string, count?: number, lookback?: number) {
  prepareOutputFolder(output);
  const start = new Date();
  const repos = parseRepoList(await findReposUsingFSHFinder({ count, lookback }));
  const counter = new Counter(repos.length);
  console.log(`Downloading ${counter.total} FSH repositories.`);
  const downloads = repos.map(repo => {
    return downloadAndExtractZip(repo, output, counter);
  });
  await Promise.all(downloads);
  const time = new Date().getTime() - start.getTime();
  console.log(`Downloaded ${counter.success} and failed ${counter.error} in ${time} ms.`);
}

async function prepareOutputFolder(output: string) {
  if (await fs.pathExists(output)) {
    const doDelete = readlineSync.keyInYN(
      `The output folder ${output} already exists. Do you wish to delete it?`
    );
    console.log();
    if (doDelete) {
      await fs.emptyDir(output);
    } else {
      console.log('Cannot fish using an existing output folder.  Exiting.');
      process.exit(1);
    }
  } else {
    await fs.mkdirp(path.join(output, 'full-igs'));
    await fs.mkdirp(path.join(output, 'fsh-sources'));
  }
}

async function downloadAndExtractZip(repo: Repo, output: string, counter: Counter) {
  try {
    const sanitizedName = sanitize(repo.name);
    const zipFile = path.join(output, `${sanitizedName}.zip`);
    await downloadZip(repo.getDownloadURL(), zipFile);
    const fullIgPath = path.join(output, 'full-igs', sanitizedName);
    const fullIgTempPath = temp.mkdirSync(sanitizedName);
    await extract(zipFile, { dir: fullIgTempPath });
    const zipRootFolderName = await (
      await fs.readdir(fullIgTempPath)
    ).find(name => /\w/.test(name));
    const zipRoot = path.join(fullIgTempPath, zipRootFolderName ?? '');
    await fs.move(zipRoot, fullIgPath);
    const inputFsh = path.join(fullIgPath, 'input', 'fsh');
    if (fs.existsSync(inputFsh)) {
      await fs.copy(inputFsh, path.join(output, 'fsh-sources', sanitizedName), { recursive: true });
    }
    await fs.unlink(zipFile);
    counter.success++;
    console.log(
      `Downloaded ${repo.getDownloadURL()} as ${sanitizedName} (${counter.done} of ${
        counter.total
      })`
    );
  } catch (e) {
    counter.error++;
    console.error(
      `Failed to download ${repo.getDownloadURL()} (${counter.done} of ${counter.total}): ${String(
        e
      )}`
    );
  }
}

function parseRepoList(repoList: string) {
  const lines = repoList
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0 && line[0] !== '#');
  return lines.map(line => {
    const parts = line.split(/#/, 2);
    return new Repo(parts[0].trim(), parts[1].trim());
  });
}

async function downloadZip(zipURL: string, zipPath: string) {
  return axios({
    method: 'get',
    url: zipURL,
    responseType: 'stream'
  }).then(response => {
    const writer = fs.createWriteStream(zipPath);
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  });
}

function sanitize(input: string): string {
  // Replace most symbols with '-', and slashes with '_', but don't allow '-' or '_' as first character
  return input
    .replace(/[^A-Za-z0-9_.\-/\\]+/g, '-')
    .replace(/[/\\]+/g, '_')
    .replace(/^[-/\\]+/, '');
}
