import { Link, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ApplicationsPage from './pages/ApplicationsPage';
import ApplicationDetailPage from './pages/ApplicationDetailPage';
import SyncPage from './pages/SyncPage';
import TeamPage from './pages/TeamPage';
import { EmptyState } from './components/ui';
import { useI18n } from './lib/i18n';

export default function App() {
  const { t } = useI18n();
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ApplicationsPage />} />
        <Route path="app/:id" element={<ApplicationDetailPage />} />
        <Route path="sync" element={<SyncPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route
          path="*"
          element={
            <EmptyState title={t('notFound.title')}>
              <Link to="/" className="text-blue-700 hover:underline">
                {t('notFound.back')}
              </Link>
            </EmptyState>
          }
        />
      </Route>
    </Routes>
  );
}
