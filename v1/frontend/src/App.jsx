import { Link, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ApplicationsPage from './pages/ApplicationsPage';
import ApplicationDetailPage from './pages/ApplicationDetailPage';
import SyncPage from './pages/SyncPage';
import TeamPage from './pages/TeamPage';
import { EmptyState } from './components/ui';

export default function App() {
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
            <EmptyState title="Page introuvable">
              <Link to="/" className="text-blue-700 hover:underline">
                Retour aux applications
              </Link>
            </EmptyState>
          }
        />
      </Route>
    </Routes>
  );
}
