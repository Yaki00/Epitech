/**
 * Routes de l'interface. Les pages sont chargées à la demande (un fichier JS par page).
 * Le backend renvoie index.html pour toute adresse hors /api : un rechargement sur /servers/x fonctionne.
 */
import { lazy } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import Layout from './Layout';
import RouteError from './RouteError';

const Home = lazy(() => import('../pages/Home'));
const Applications = lazy(() => import('../pages/Applications'));
const Application = lazy(() => import('../pages/Application'));
const Servers = lazy(() => import('../pages/Servers'));
const Server = lazy(() => import('../pages/Server'));
const MapPage = lazy(() => import('../pages/Map'));
const Monitoring = lazy(() => import('../pages/Monitoring'));
const History = lazy(() => import('../pages/History'));
const Sync = lazy(() => import('../pages/Sync'));
const NotFound = lazy(() => import('../pages/NotFound'));

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Home /> },
          { path: 'applications', element: <Applications /> },
          { path: 'applications/:id', element: <Application /> },
          { path: 'servers', element: <Servers /> },
          { path: 'servers/:id', element: <Server /> },
          { path: 'map', element: <MapPage /> },
          { path: 'monitoring', element: <Monitoring /> },
          { path: 'history', element: <History /> },
          { path: 'sync', element: <Sync /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
