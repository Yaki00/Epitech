import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';
import './styles.css';
import { LangProvider } from './lib/i18n';
import { ThemeProvider } from './lib/theme';
import { ConfigProvider } from './lib/config';
import { LiveStatusProvider } from './lib/live';
import { createRouter } from './app/routes';

const router = createRouter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <LangProvider>
        <ConfigProvider>
          <LiveStatusProvider>
            <RouterProvider router={router} />
          </LiveStatusProvider>
        </ConfigProvider>
      </LangProvider>
    </ThemeProvider>
  </StrictMode>,
);
