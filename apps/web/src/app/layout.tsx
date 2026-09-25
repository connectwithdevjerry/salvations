import type { ReactNode } from 'react';
import './globals.css';
import { DialogProvider } from '@/components/dialog';

export const metadata = {
  title: 'HIVE — agents that actually do the work',
  description:
    'An MCP-native agent host: any model, any MCP server, with a budget, an audit ' +
    'trail and your approval before anything consequential happens.',
};

/**
 * `themeColor` matches the canvas so the browser chrome does not sit as a bright
 * band above a dark page on mobile.
 */
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#05070b' },
    { media: '(prefers-color-scheme: light)', color: '#fbfbfa' },
  ],
};

/**
 * Applies a chosen theme before the first paint.
 *
 * Inline and tiny, because the alternative is a flash of the wrong theme on
 * every load for anyone who chose one. Reads the same key the Appearance
 * setting writes; anything but "light" or "dark" means "follow the system",
 * which is the stylesheet's default.
 */
const APPLY_THEME = `(function(){try{var t=localStorage.getItem('hive.theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPLY_THEME }} />
      </head>
      <body><DialogProvider>{children}</DialogProvider></body>
    </html>
  );
}
