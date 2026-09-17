import type { ReactNode } from 'react';
import './globals.css';

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
