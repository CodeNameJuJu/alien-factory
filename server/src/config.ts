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
  models: {
    overlord: 'claude-sonnet-5-5-medium',
    scout: 'claude-haiku-5-5-medium',
    smith: 'swe-2-medium-lightning',
    inspector: 'claude-haiku-5-5-low',
    packer: 'swe-1-6',
  },
  smiths: 3,
  maxOverlordTurnsPerHour: 6,
  maxApprovalsPerTurn: 4,
  sessionJobLimit: { scout: 1, smith: 1, inspector: 4, packer: 6 },
  rescoutHours: 6,
  usdToZar: 18.5,
  prices: {},
  dailyTokenCaps: null,
  mode: 'research',
  marketSource: 'itch',
  gumroad: { minScore: 7, packsOnly: true, maxDraftsPerDay: 3, autoPublish: false },
  autoArchiveFailed: true,
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

/// Merge a raw config.json onto the defaults. One-time migration: the old
/// overlordModel/workerModel/workerSessionJobLimit keys are dropped
/// (per-role models + session limits replace them); nested maps merge.
export function migrateConfig(raw: Record<string, unknown>): FactoryConfig {
  const {
    overlordModel: _o,
    workerModel: _w,
    workerSessionJobLimit: _s,
    ...rest
  } = raw as Record<string, unknown> & {
    overlordModel?: unknown;
    workerModel?: unknown;
    workerSessionJobLimit?: unknown;
  };
  const merged = { ...DEFAULT_CONFIG, ...(rest as Partial<FactoryConfig>) };
  merged.models = { ...DEFAULT_CONFIG.models, ...(rest.models as Partial<FactoryConfig['models']> | undefined) };
  merged.sessionJobLimit = {
    ...DEFAULT_CONFIG.sessionJobLimit,
    ...(rest.sessionJobLimit as Partial<FactoryConfig['sessionJobLimit']> | undefined),
  };
  merged.prices = { ...((rest.prices as FactoryConfig['prices']) ?? {}) };
  merged.dailyTokenCaps = (rest.dailyTokenCaps as FactoryConfig['dailyTokenCaps']) ?? null;
  merged.gumroad = { ...DEFAULT_CONFIG.gumroad, ...(rest.gumroad as Partial<FactoryConfig['gumroad']> | undefined) };
  return merged;
}

export function loadConfig(): FactoryConfig {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(FACTORY_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models }, sessionJobLimit: { ...DEFAULT_CONFIG.sessionJobLimit } };
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
    return migrateConfig(raw);
  } catch {
    return { ...DEFAULT_CONFIG, models: { ...DEFAULT_CONFIG.models }, sessionJobLimit: { ...DEFAULT_CONFIG.sessionJobLimit } };
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
