import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;

export const credentialsPath = (environment = process.env) => {
  if (environment.ZIRA_CREDENTIALS_FILE) {
    return path.resolve(environment.ZIRA_CREDENTIALS_FILE);
  }

  const configDirectory = environment.ZIRA_CONFIG_DIR
    ? path.resolve(environment.ZIRA_CONFIG_DIR)
    : path.join(environment.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'zira');

  return path.join(configDirectory, 'credentials.json');
};

export const readStore = async (file = credentialsPath()) => {
  try {
    const contents = await fs.readFile(file, 'utf8');
    const store = JSON.parse(contents);
    if (store.version !== STORE_VERSION || !store.profiles || typeof store.profiles !== 'object') {
      throw new Error(`Unsupported credentials format in ${file}`);
    }
    return store;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { version: STORE_VERSION, profiles: {} };
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in credentials file ${file}`, { cause: error });
    }
    throw error;
  }
};

export const writeStore = async (store, file = credentialsPath()) => {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);

  const temporaryFile = path.join(directory, `.credentials-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryFile, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    });
    await fs.rename(temporaryFile, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
};

export const getProfile = async (profileName, file = credentialsPath()) => {
  const store = await readStore(file);
  return store.profiles[profileName];
};

export const saveProfile = async (profileName, profile, file = credentialsPath()) => {
  const store = await readStore(file);
  store.profiles[profileName] = profile;
  await writeStore(store, file);
};

export const removeProfile = async (profileName, file = credentialsPath()) => {
  const store = await readStore(file);
  const existed = Object.hasOwn(store.profiles, profileName);
  delete store.profiles[profileName];
  if (existed) {
    await writeStore(store, file);
  }
  return existed;
};
