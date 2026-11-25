/**
 * Page Cartographie : tout le périmètre ou une application (paramètre `scope` de l'adresse),
 * zones PRD et STG côte à côte (DEV d'un clic), mini-carte, export PNG et simulation de panne.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { api, useApi } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useTitle } from '../lib/useTitle';
import { Button, PageHeader } from '../components/ui';
import { SelectField } from '../components/filters';
import { MapView } from '../map/MapView';

export default function MapPage() {
  const { t } = useI18n();
  useTitle(t('page.map.title'));
  const [params, setParams] = useSearchParams();
  const raw = params.get('scope') ?? 'perimeter';
  const scope = raw === 'perimeter' || raw.startsWith('app:') ? raw : 'perimeter';
  const { data: apps } = useApi((signal) => api.applications({ signal }), []);

  const setScope = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === 'perimeter') p.delete('scope');
    else p.set('scope', next);
    setParams(p, { replace: true });
  };

  const options = useMemo(() => {
    const list = (apps ?? [])
      .filter((a) => !a.retired || `app:${a.id}` === scope)
      .slice()
      .sort((a, b) => Number(b.inPerimeter) - Number(a.inPerimeter) || a.name.localeCompare(b.name))
      .map((a) => ({ value: `app:${a.id}`, label: a.inPerimeter ? a.name : `${a.name} (${t('map.scope.outOfPerimeter')})` }));
    // application demandée par l'adresse mais pas (encore) dans la liste : on la garde sélectionnable
    if (scope !== 'perimeter' && !list.some((o) => o.value === scope)) list.unshift({ value: scope, label: scope.slice(4).replace(/^application:/, '') });
    return [{ value: 'perimeter', label: t('map.scope.perimeter') }, ...list];
  }, [apps, scope, t]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('page.map.title')} subtitle={t('page.map.subtitle')} />
      <MapView
        key={scope}
        scope={scope}
        toolbarStart={<SelectField label={t('map.scope.label')} value={scope} onChange={setScope} options={options} className="w-full sm:w-64" />}
        notFoundAction={
          <Button variant="primary" onClick={() => setScope('perimeter')}>
            {t('map.scope.perimeter')}
          </Button>
        }
      />
    </div>
  );
}
