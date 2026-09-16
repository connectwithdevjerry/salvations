import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Salvations',
  description: 'MCP-native agent host',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
