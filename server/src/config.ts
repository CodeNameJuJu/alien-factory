import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FactoryConfig } from '../../shared/protocol.js';

/// Everything persistent lives here. ALIEN_FACTORY_DATA_DIR points the whole
/// install elsewhere (Railway: /data on a mounted volume).
export const DATA_DIR = process.env.ALIEN_FACTORY_DATA_DIR ?? join(homedir(), '.alien-factory');
export const LOG_DIR = join(DATA_DIR, 'logs');
export const STATE_PATH = join(DATA_DIR, 'state.json');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const ACP_LOG_PATH = join(LOG_DIR, 'acp.log');
export const PROBE_DIR = join(DATA_DIR, 'probe');
/// The sandbox every agent session runs in; overridable for tests/seeding.
export const FACTORY_DIR = process.env.ALIEN_FACTORY_DIR ?? join(DATA_DIR, 'factory');

export const DEFAULT_CONFIG: FactoryConfig = {
  overlordModel: 'claude-opus-5-5-high',
  workerModel: 'swe-1-7-lightning-medium',
  smiths: 3,
  maxOverlordTurnsPerHour: 6,
  maxApprovalsPerTurn: 4,
  workerSessionJobLimit: 6,
  usdToZar: 18.5,
  mode: 'research',
  marketSource: 'itch',
  itchScanMinutes: 60,
  itchFeeds: [
    'game-assets/top-sellers/tag-pixel-art:2',
    'game-assets/new-and-popular/tag-pixel-art:2',
    'game-assets/newest/tag-pixel-art:1',
    'game-assets/top-sellers/tag-sprites:1',
    'game-assets/top-sellers/tag-tileset:1',
    'game-assets/top-sellers/tag-icons:1',
    'game-assets/top-sellers/tag-user-interface:1',
    'game-assets/top-rated/tag-pixel-art:1',
  ],
};

export function loadConfig(): FactoryConfig {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(FACTORY_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<FactoryConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: FactoryConfig): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONFIG_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(config, null, 2));
    renameSync(tmp, CONFIG_PATH);
  } catch {
    /* best effort */
  }
}
