import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ENV_FILTER, ENV_FILTER_STORAGE_KEY, envVisible, parseEnvFilter, serializeEnvFilter, toggleEnv } from './envFilter';

describe('filtre d’environnements', () => {
  beforeEach(() => localStorage.clear());

  it('par défaut : PRD et STG, DEV décoché, Non précisé affiché', () => {
    expect(DEFAULT_ENV_FILTER.envs).toEqual(['PRD', 'STG']);
    expect(envVisible(DEFAULT_ENV_FILTER, 'PRD')).toBe(true);
    expect(envVisible(DEFAULT_ENV_FILTER, 'STG')).toBe(true);
    expect(envVisible(DEFAULT_ENV_FILTER, 'DEV')).toBe(false);
    expect(envVisible(DEFAULT_ENV_FILTER, null)).toBe(true);
  });

  it('une valeur mémorisée illisible ou invalide redonne le défaut', () => {
    for (const raw of [null, '', '{pas du json', 'null', '42', '{"envs":"PRD"}', '{"envs":["QA"],"unspecified":true}', '{"envs":["PRD"]}']) {
      expect(parseEnvFilter(raw)).toEqual(DEFAULT_ENV_FILTER);
    }
  });

  it('relit une valeur valide, dans l’ordre PRD, STG, DEV', () => {
    const f = parseEnvFilter(serializeEnvFilter({ envs: ['DEV', 'PRD'], unspecified: false }));
    expect(f).toEqual({ envs: ['PRD', 'DEV'], unspecified: false });
    expect(envVisible(f, null)).toBe(false);
    expect(localStorage.getItem(ENV_FILTER_STORAGE_KEY)).toBeNull();
  });

  it('bascule un environnement', () => {
    const withDev = toggleEnv(DEFAULT_ENV_FILTER, 'DEV', true);
    expect(withDev.envs).toEqual(['PRD', 'STG', 'DEV']);
    expect(toggleEnv(withDev, 'PRD', false).envs).toEqual(['STG', 'DEV']);
  });
});
