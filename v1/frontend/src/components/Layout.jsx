import { NavLink, Outlet } from 'react-router-dom';
import { AppsIcon, BoltIcon, SyncIcon, TeamIcon } from './Icons';
import { useApi } from '../lib/useApi';
import { api } from '../api/client';
import ChatWidget from './ChatWidget';

const NAV = [
  { to: '/', label: 'Applications', icon: AppsIcon, end: true },
  { to: '/sync', label: 'Synchronisation', icon: SyncIcon },
  { to: '/team', label: 'Équipe', icon: TeamIcon },
];

function Sidebar() {
  const { data, error } = useApi(() => api.health(), []);
  const connected = !!data && !error;
  return (
    <aside className="sticky top-0 flex h-screen w-72 shrink-0 flex-col border-r border-slate-200 bg-white px-5 py-6">
      <div className="flex items-center gap-3 px-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 text-white shadow-md shadow-blue-600/30">
          <BoltIcon width={24} height={24} />
        </div>
        <div>
          <div className="text-lg font-semibold leading-tight text-slate-900">Lyra v1</div>
          <div className="text-sm text-slate-500">Infrastructure Intelligence</div>
        </div>
      </div>

      <nav className="mt-10 flex flex-col gap-1">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-4 py-3 text-[15px] font-medium transition ${
                isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-700 hover:bg-slate-50'
              }`
            }
          >
            <Icon />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto px-2 text-sm">
        <div className="flex items-center gap-2 text-slate-600">
          <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          {connected ? 'Connecté' : 'Backend injoignable'}
        </div>
        {connected && <div className="mt-1 text-slate-400">{data.counts?.application ?? 0} applications suivies</div>}
      </div>
    </aside>
  );
}

export default function Layout() {
  return (
    <div className="flex min-h-screen bg-slate-50 font-sans text-slate-900">
      <Sidebar />
      <main className="min-w-0 flex-1 px-10 py-8">
        <Outlet />
      </main>
      <ChatWidget />
    </div>
  );
}
