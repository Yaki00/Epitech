import { describe, expect, it } from 'vitest';
import { APP_STATES, ENV_CLASSES, SERVER_STATES, TONE_CLASSES, bySeverity, envKey, envLabelKey, isAlerting, serviceState, stateMeta, worstState } from './status';
import { DICTIONARIES } from './i18n';

describe('status', () => {
  it('chaque état a un ton, une icône et un libellé traduit', () => {
    for (const s of [...SERVER_STATES, ...APP_STATES]) {
      const m = stateMeta(s);
      expect(m.state).toBe(s);
      expect(m.icon).toBeTruthy();
      expect(TONE_CLASSES[m.tone]).toBeTruthy();
      expect(DICTIONARIES.fr[m.labelKey], s).toBeTruthy();
      expect(DICTIONARIES.en[m.labelKey], s).toBeTruthy();
    }
  });

  it('valeur absente ou inattendue : « unknown », jamais OK', () => {
    expect(stateMeta(null).state).toBe('unknown');
    expect(stateMeta(undefined).state).toBe('unknown');
    expect(stateMeta('UP').state).toBe('unknown');
    expect(stateMeta('toString').state).toBe('unknown');
  });

  it('les états se distinguent (ton différent) sauf alerte et dégradé', () => {
    const tones = SERVER_STATES.map((s) => stateMeta(s).tone);
    expect(new Set(tones).size).toBe(SERVER_STATES.length);
    expect(stateMeta('degraded').tone).toBe(stateMeta('warning').tone);
    // non supervisé et inconnu : icônes différentes (pas seulement la couleur)
    expect(stateMeta('not_monitored').icon).not.toBe(stateMeta('unknown').icon);
  });

  it('tri par gravité : panne, critique, alerte, inconnu, non supervisé, maintenance, OK', () => {
    const shuffled = ['ok', 'maintenance', 'warning', 'down', 'not_monitored', 'critical', 'unknown'];
    expect([...shuffled].sort(bySeverity)).toEqual(['down', 'critical', 'warning', 'unknown', 'not_monitored', 'maintenance', 'ok']);
  });

  it('pire état d\'une liste', () => {
    expect(worstState(['ok', 'warning', 'maintenance'])).toBe('warning');
    expect(worstState(['ok', 'degraded', 'down'])).toBe('down');
    expect(worstState(['ok', 'ok'])).toBe('ok');
    expect(worstState([])).toBe('unknown');
  });

  it('états qui demandent de l\'attention', () => {
    expect(['down', 'critical', 'warning', 'degraded'].every(isAlerting)).toBe(true);
    expect(['ok', 'maintenance', 'unknown', 'not_monitored', null].some(isAlerting)).toBe(false);
  });

  it('codes de service Naemon, arrêt planifié = maintenance', () => {
    expect([0, 1, 2, 3].map((c) => serviceState(c))).toEqual(['ok', 'warning', 'critical', 'unknown']);
    expect(serviceState(2, true)).toBe('maintenance');
    expect(serviceState(9)).toBe('unknown');
  });

  it('environnements : null ou inattendu = « Non précisé »', () => {
    expect(envKey('PRD')).toBe('PRD');
    expect(envKey(null)).toBe('none');
    expect(envKey('prod')).toBe('none');
    expect(envLabelKey(null)).toBe('env.none');
    for (const k of ['PRD', 'STG', 'DEV', 'none'] as const) {
      expect(ENV_CLASSES[k]).toBeTruthy();
      expect(DICTIONARIES.fr[`env.${k}`]).toBeTruthy();
      expect(DICTIONARIES.en[`env.short.${k}`]).toBeTruthy();
    }
  });
});
